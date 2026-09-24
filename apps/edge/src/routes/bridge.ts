// apps/edge/src/routes/bridge.ts — §10.6's two endpoints, served by the Worker
// and NEVER forwarded to the Vercel origin (10.6.7 rule 6). The reservation
// row is the task; the poll probes one bounded query per 5 s window and never
// pins a Hyperdrive connection while it waits.
//
// Auth: `Authorization: Bearer mb_brg_…` → sha256 → delegations.token_sha256,
// resolved on HYPERDRIVE_FRESH on EVERY poll — revocable credentials get no
// cache window (10.6.2; KV is for append-only x402 grants only).
import type { BridgeErrorCode, BridgeFrame, BridgeOp } from "@musebook/connectors";
import {
  completeDraft,
  renderTemplate,
  minMaxCharsFor,
  type DelegationForDrafting,
  type ScheduleRow,
} from "musebook-worker/agent-draft";
import { fresh, type DbClient } from "../db/client.js";

const POLL_PROBE_MS = 5_000;
const RESULT_FRAME_CAP = 1_048_576;
const MAX_DRAFT_CHARS = 20_000;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Bearer → delegations row. A token without the mb_brg_ prefix is rejected
 *  BEFORE touching the database — the two credential forms never swap routes
 *  (10.6.2's last paragraph). */
async function resolveBridge(
  request: Request,
  env: Env,
): Promise<{ delegationId: string; revoked: boolean; expired: boolean } | Response> {
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token.startsWith("mb_brg_")) {
    return json({ error: "bridge_token_required" }, 401);
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");

  const db = fresh(env);
  try {
    const { rows } = await db.query<{
      id: string;
      state: string;
      expires_at: Date | string | null;
    }>("select d.id, d.state, d.expires_at from app.resolve_delegation($1::text) d", [hash]);
    const d = rows[0];
    if (!d) return json({ error: "bridge_token_invalid" }, 401);
    return {
      delegationId: d.id,
      revoked: d.state === "revoked",
      expired: d.expires_at !== null && new Date(d.expires_at).getTime() <= Date.now(),
    };
  } finally {
    await db.end();
  }
}

interface BridgeTaskContext {
  delegation: DelegationForDrafting | null;
  schedule: ScheduleRow | null;
  reservation_state: string;
  task_id: string;
}

async function taskContext(db: DbClient, reservationId: string): Promise<BridgeTaskContext | null> {
  const { rows } = await db.query<BridgeTaskContext>(
    "select * from app.bridge_task_context($1::uuid)",
    [reservationId],
  );
  return rows[0] ?? null;
}

async function frame(request: Request): Promise<BridgeFrame | Response> {
  const len = Number(request.headers.get("content-length") ?? "0");
  if (len > RESULT_FRAME_CAP) return json({ error: "output_too_large" }, 413);
  try {
    const body: BridgeFrame = await request.json();
    return body;
  } catch {
    return json({ error: "frame_invalid" }, 400);
  }
}

/** POST /api/bridge/poll — `hello` in; `task` | `idle` | `revoked` out. The
 *  hold is bounded by MUSEBOOK_BRIDGE_POLL_MAX_MS (25 s default): one probe,
 *  release, scheduler.wait, probe again (10.6.6's probe loop). */
export async function handleBridgePoll(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  void ctx;
  if (request.method !== "POST") return json({ error: "method" }, 405);
  const who = await resolveBridge(request, env);
  if (who instanceof Response) return who;
  if (who.revoked || who.expired) {
    const frame: BridgeFrame = {
      v: 1,
      type: "revoked",
      reason: who.revoked ? "delegation_revoked" : "delegation_expired",
    };
    return json(frame, who.revoked ? 401 : 403);
  }

  const f = await frame(request);
  if (f instanceof Response) return f;
  if (f.type !== "hello") return json({ error: "hello_expected" }, 400);

  const maxMs = Number(env.MUSEBOOK_BRIDGE_POLL_MAX_MS ?? 25_000);
  const deadline = Date.now() + maxMs;

  for (;;) {
    const db = fresh(env);
    try {
      const { rows } = await db.query<{
        reservation_id: string;
        task_id: string;
        estimate_atomic: string;
      }>("select * from app.next_bridge_task($1::uuid)", [who.delegationId]);
      const task = rows[0];
      if (task) {
        const c = await taskContext(db, task.reservation_id);
        if (c?.delegation && c.schedule) {
          const op = await draftOpFor(env, c.delegation, c.schedule, task.task_id);
          const response: BridgeFrame = {
            v: 1,
            type: "task",
            taskId: task.task_id,
            deadlineMs: 30 * 60_000, // the 30-minute reaper's bound (10.6.6)
            op,
          };
          await auditBridge(env, who.delegationId, task.reservation_id, {
            task_id: task.task_id,
            runtime: f.runtime,
            bridge_version: f.bridgeVersion,
          });
          return json(response);
        }
        // Context vanished (schedule deleted mid-flight) — release the hold so
        // the reaper does not have to.
        await db.query(
          "select app.enter('musebook_jobs'), public.release_agent_spend($1::uuid, $2::text)",
          [task.reservation_id, "bridge_task_orphaned"],
        );
      }
    } finally {
      await db.end();
    }

    if (Date.now() >= deadline) break;
    const remaining = deadline - Date.now();
    await scheduler.wait(Math.min(POLL_PROBE_MS, Math.max(0, remaining)));
  }

  const idle: BridgeFrame = { v: 1, type: "idle" };
  return json(idle);
}

/** POST /api/bridge/result — `result` | `error` in, Idempotency-Key: taskId.
 *  First writer wins inside (endpoint, key, actor); a replay returns the
 *  stored response (10.6.3). Runs the SAME completeDraft the tick calls. */
export async function handleBridgeResult(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  void ctx;
  if (request.method !== "POST") return json({ error: "method" }, 405);
  const who = await resolveBridge(request, env);
  if (who instanceof Response) return who;
  if (who.revoked || who.expired) {
    return json({ error: who.revoked ? "delegation_revoked" : "delegation_expired" }, 401);
  }

  const taskId = request.headers.get("idempotency-key");
  if (!taskId) return json({ error: "idempotency_key_required" }, 400);
  const f = await frame(request);
  if (f instanceof Response) return f;
  if (f.type !== "result" && f.type !== "error") {
    return json({ error: "result_or_error_expected" }, 400);
  }
  if (f.taskId !== taskId) return json({ error: "task_id_mismatch" }, 400);

  const db = fresh(env);
  try {
    const { rows } = await db.query<{
      reservation_id: string;
      reservation_state: string;
    }>("select * from app.bridge_reservation_for_task($1::uuid, $2::text)", [
      who.delegationId,
      taskId,
    ]);
    const r = rows[0];
    if (!r || r.reservation_state !== "held") {
      // Late result for a reaped/cancelled/applied task: accept into
      // idempotency_keys, discard, never apply (10.6.3).
      await recordOnce(db, who.delegationId, taskId, { applied: false });
      return json({ applied: false });
    }

    if (f.type === "error") {
      const code: BridgeErrorCode = f.code;
      await db.query(
        "select app.enter('musebook_jobs'), public.release_agent_spend($1::uuid, $2::text)",
        [r.reservation_id, `bridge_${code}`],
      );
      await auditBridge(env, who.delegationId, r.reservation_id, {
        action: "agent.draft_failed",
        code,
      });
      await recordOnce(db, who.delegationId, taskId, { applied: false, code });
      return json({ applied: false, code });
    }

    const c = await taskContext(db, r.reservation_id);
    if (!c?.delegation || !c.schedule) {
      await db.query(
        "select app.enter('musebook_jobs'), public.release_agent_spend($1::uuid, $2::text)",
        [r.reservation_id, "bridge_task_orphaned"],
      );
      await recordOnce(db, who.delegationId, taskId, { applied: false });
      return json({ applied: false });
    }

    const payload = f.payload as {
      text?: string;
      hashtags?: string[];
      costAtomic?: number | string;
      modelUsed?: string;
      remoteTraceId?: string;
    };
    const outcome = await completeDraft(env, {
      schedule: c.schedule,
      delegation: c.delegation,
      reservationId: r.reservation_id,
      draft: {
        text: typeof payload.text === "string" ? payload.text : "",
        hashtags: Array.isArray(payload.hashtags) ? payload.hashtags : [],
        costAtomic: BigInt(payload.costAtomic ?? 0),
        modelUsed: payload.modelUsed,
        remoteTraceId: payload.remoteTraceId,
      },
    });
    await recordOnce(db, who.delegationId, taskId, { applied: true, outcome });
    return json({ applied: true, outcome });
  } finally {
    await db.end();
  }
}

/** The task frame's op — reconstructed from the SAME schedule row the drain
 *  rendered against, so the bridge receives the request the tick would have
 *  sent had the far side answered synchronously (10.15.3). */
async function draftOpFor(
  env: Env,
  d: DelegationForDrafting,
  s: ScheduleRow,
  taskId: string,
): Promise<BridgeOp> {
  return {
    kind: "draft",
    request: {
      intent: renderTemplate(s.prompt_template ?? "", {
        today: new Date().toISOString().slice(0, 10),
        handle: d.owner_handle,
      }),
      targetPlatforms: s.target_platforms,
      maxLengthChars: Math.min(MAX_DRAFT_CHARS, await minMaxCharsFor(env, s.target_platforms)),
      referenceUrls: [],
      taskId,
    },
  };
}

async function recordOnce(
  db: DbClient,
  delegationId: string,
  taskId: string,
  response: Record<string, unknown>,
): Promise<void> {
  await db.query("select * from app.bridge_result_once($1::text, $2::uuid, $3::jsonb)", [
    taskId,
    delegationId,
    response,
  ]);
}

async function auditBridge(
  env: Env,
  delegationId: string,
  reservationId: string,
  meta: Record<string, unknown>,
): Promise<void> {
  const db = fresh(env);
  try {
    await db.query(`select app.audit_log_insert($1::jsonb)`, [
      {
        actor: "owner_agent",
        delegation_id: delegationId,
        action: (meta.action as string | undefined) ?? "bridge.task_submitted",
        target_kind: "reservation",
        target_id: reservationId,
        after_state: meta,
      },
    ]);
  } catch {
    // audit is fail-open (5.7.7)
  } finally {
    await db.end();
  }
}
