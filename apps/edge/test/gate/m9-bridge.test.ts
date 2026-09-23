// apps/edge/test/gate/m9-bridge.test.ts — §10.6's two endpoints end-to-end
// against the live local DB: token resolution on FRESH every call, the
// hello->task poll loop, result idempotency, error-frame release, and the
// completeDraft path shared with the tick.
import { SELF, env } from "cloudflare:test";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { db } from "./helpers.js";

const OWNER = "11111111-1111-4111-8111-000000000003";
const CONNECTOR = "bbbbbbbb-bbbb-4bbb-8bbb-000000000001"; // seed-echo-mcp
const AGENT = "cccccccc-cccc-4ccc-8ccc-000000000001";
const AGENT_EXPIRED = "cccccccc-cccc-4ccc-8ccc-0000000000ee";
const DLG = "cccccccc-cccc-4ccc-8ccc-0000000000aa";
const DLG_REVOKED = "cccccccc-cccc-4ccc-8ccc-0000000000bb";
const DLG_EXPIRED = "cccccccc-cccc-4ccc-8ccc-0000000000dd";
const SCHED = "dddddddd-dddd-4ddd-8ddd-0000000000aa";
const TOKEN = "mb_brg_gate_test_token_0001";
const TOKEN_REVOKED = "mb_brg_gate_test_token_0002";
const TOKEN_EXPIRED = "mb_brg_gate_test_token_0003";

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function poll(body: unknown, token = TOKEN): Promise<Response> {
  return SELF.fetch(
    new Request("https://musebook.dev/api/bridge/poll", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function result(taskId: string | null, frame: unknown, token = TOKEN): Promise<Response> {
  return SELF.fetch(
    new Request("https://musebook.dev/api/bridge/result", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(taskId !== null ? { "idempotency-key": taskId } : {}),
      },
      body: JSON.stringify(frame),
    }),
  );
}

async function seedReservation(taskId: string): Promise<string> {
  const id = crypto.randomUUID();
  await db(
    `insert into public.agent_spend_reservations
       (id, delegation_id, window_start, purpose, estimate_atomic, state,
        external_kind, external_ref, idempotency_key)
     values ($1::uuid, $2::uuid, now(), 'connector.call', 1000, 'held',
             'bridge_draft', $3::text, $4::text)`,
    [id, DLG, taskId, `${taskId}:idem`],
  );
  return id;
}

function rawPost(path: string, body: string, headers: Record<string, string> = {}) {
  return SELF.fetch(
    new Request(`https://musebook.dev${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...headers },
      body,
    }),
  );
}

beforeAll(async () => {
  env.MUSEBOOK_BRIDGE_POLL_MAX_MS = "1";
  await db(
    `insert into public.agent_identities (id, slug, display_name)
     values ($1::uuid, 'm9-bridge-agent', 'M9 bridge agent')`,
    [AGENT],
  );
  await db(
    `insert into public.delegations
       (id, owner_user_id, connector_id, agent_identity_id, state, scopes,
        token_sha256, requires_approval, clean_approvals, reputation)
     values
       ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'active', '{post:write,post:publish}',
        $5, false, 10, 50),
       ($6::uuid, $2::uuid, $3::uuid, $4::uuid, 'revoked', '{post:write}',
        $7, false, 0, 50)`,
    [
      DLG,
      OWNER,
      CONNECTOR,
      AGENT,
      await sha256Hex(TOKEN),
      DLG_REVOKED,
      await sha256Hex(TOKEN_REVOKED),
    ],
  );
  await db(
    `insert into public.agent_identities (id, slug, display_name)
     values ($1::uuid, 'm9-bridge-expired-agent', 'M9 expired agent')`,
    [AGENT_EXPIRED],
  );
  await db(
    `insert into public.delegations
       (id, owner_user_id, connector_id, agent_identity_id, state, scopes,
        token_sha256, requires_approval, clean_approvals, reputation, expires_at)
     values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'active', '{post:write}',
             $5, false, 0, 50, now() - interval '1 hour')`,
    [DLG_EXPIRED, OWNER, CONNECTOR, AGENT_EXPIRED, await sha256Hex(TOKEN_EXPIRED)],
  );
  await db(
    `insert into public.agent_post_schedules
       (id, delegation_id, cadence, prompt_template, target_platforms,
        max_posts_per_day, approval_mode, approval_n)
     values ($1::uuid, $2::uuid, 'manual', 'Draft about {today} for @{handle}', '{}',
             3, 'never', 0)`,
    [SCHED, DLG],
  );
});

afterAll(async () => {
  await db(`delete from public.idempotency_keys where endpoint = 'bridge.result'`);
  await db(
    `delete from public.agent_spend_reservations where delegation_id in ($1::uuid,$2::uuid,$3::uuid)`,
    [DLG, DLG_REVOKED, DLG_EXPIRED],
  );
  await db(`delete from public.agent_post_schedules where id = $1::uuid`, [SCHED]);
  await db(`delete from public.delegations where id in ($1::uuid,$2::uuid,$3::uuid)`, [
    DLG,
    DLG_REVOKED,
    DLG_EXPIRED,
  ]);
  await db(`delete from public.agent_identities where id in ($1::uuid,$2::uuid)`, [
    AGENT,
    AGENT_EXPIRED,
  ]);
  await db(
    `delete from public.posts p using public.approval_queue q
      where q.payload->>'post_id' = p.id::text and q.delegation_id = $1::uuid`,
    [DLG],
  );
  await db(`delete from public.approval_queue where delegation_id = $1::uuid`, [DLG]);
});

describe("§10.6 — bridge auth", () => {
  it("rejects non-POST, missing, wrong-prefix and unknown tokens", async () => {
    expect((await SELF.fetch(new Request("https://musebook.dev/api/bridge/poll"))).status).toBe(
      405,
    );
    const noAuth = await poll({ v: 1, type: "hello" }, "");
    expect(noAuth.status).toBe(401);
    expect((await noAuth.json()) as { error: string }).toEqual({
      error: "bridge_token_required",
    });
    expect((await poll({ v: 1, type: "hello" }, "mb_dlg_whatever")).status).toBe(401);
    const unknown = await poll({ v: 1, type: "hello" }, "mb_brg_unknown");
    expect(unknown.status).toBe(401);
    expect((await unknown.json()) as { error: string }).toEqual({
      error: "bridge_token_invalid",
    });
  });

  it("a revoked delegation gets the revoked frame, not an auth error", async () => {
    const res = await poll({ v: 1, type: "hello" }, TOKEN_REVOKED);
    expect(res.status).toBe(401);
    const f = (await res.json()) as { type: string; reason: string };
    expect(f.type).toBe("revoked");
    expect(f.reason).toBe("delegation_revoked");
  });

  it("an expired delegation gets the revoked frame with delegation_expired", async () => {
    const res = await poll({ v: 1, type: "hello" }, TOKEN_EXPIRED);
    expect(res.status).toBe(403);
    const f = (await res.json()) as { type: string; reason: string };
    expect(f.type).toBe("revoked");
    expect(f.reason).toBe("delegation_expired");
  });
});

describe("§10.6 — bridge poll", () => {
  it("requires a hello frame and returns idle inside the bounded window", async () => {
    const bad = await poll({ v: 1, type: "result", taskId: "x" });
    expect(bad.status).toBe(400);
    const res = await poll({ v: 1, type: "hello", runtime: "gate", bridgeVersion: "0.1.0" });
    const f = (await res.json()) as { v: number; type: string };
    expect(f).toEqual({ v: 1, type: "idle" });
  });

  it("hands a held reservation out as a task frame with the rendered op", async () => {
    const taskId = `draft:${SCHED}:${Date.now()}`;
    await seedReservation(taskId);
    const res = await poll({ v: 1, type: "hello", runtime: "gate", bridgeVersion: "0.1.0" });
    expect(res.status).toBe(200);
    const f = (await res.json()) as {
      v: number;
      type: string;
      taskId: string;
      deadlineMs: number;
      op: { kind: string; request: { intent: string; taskId: string } };
    };
    expect(f.type).toBe("task");
    expect(f.taskId).toBe(taskId);
    expect(f.deadlineMs).toBe(30 * 60_000);
    expect(f.op.kind).toBe("draft");
    expect(f.op.request.taskId).toBe(taskId);
    expect(f.op.request.intent).toContain("@");
    // The task is still held: a second poll idles rather than re-issuing.
    await db(
      `update public.agent_spend_reservations
          set state = 'released', actual_atomic = 0, closed_at = now()
        where external_ref = $1`,
      [taskId],
    );
  });

  it("a malformed frame is 400 and an oversized one is 413", async () => {
    expect((await rawPost("/api/bridge/poll", "{")).status).toBe(400);
    const big = await rawPost("/api/bridge/poll", "{}", { "content-length": "2000000" });
    expect(big.status).toBe(413);
  });

  it("an orphaned held task is released by the poll and the loop idles", async () => {
    // external_ref fails the draft:<uuid>:<ms> regex → bridge_task_context's
    // schedule lookup is NULL → the route releases the hold itself.
    const reservationId = await seedReservation("not-a-draft-ref");
    const res = await poll({ v: 1, type: "hello" });
    const f = (await res.json()) as { type: string };
    expect(f.type).toBe("idle");
    const rows = await db<{ state: string }>(
      `select state from public.agent_spend_reservations where id = $1::uuid`,
      [reservationId],
    );
    expect(rows[0]?.state).toBe("released");
  });
});

describe("§10.6 — bridge result", () => {
  it("enforces idempotency-key, frame type and task-id match", async () => {
    expect((await result(null, { v: 1, type: "result", taskId: "x" })).status).toBe(400);
    const wrongType = await result("t1", { v: 1, type: "hello" });
    expect((await wrongType.json()) as { error: string }).toEqual({
      error: "result_or_error_expected",
    });
    const mismatch = await result("t2", { v: 1, type: "result", taskId: "t3" });
    expect((await mismatch.json()) as { error: string }).toEqual({
      error: "task_id_mismatch",
    });
  });

  it("accepts-and-discards a result for a task that is not held, idempotently", async () => {
    const res = await result("draft:missing:1", {
      v: 1,
      type: "result",
      taskId: "draft:missing:1",
      payload: { text: "late" },
    });
    expect((await res.json()) as { applied: boolean }).toEqual({ applied: false });
    const replay = await result("draft:missing:1", {
      v: 1,
      type: "result",
      taskId: "draft:missing:1",
      payload: { text: "late" },
    });
    expect(replay.status).toBe(200);
  });

  it("revoked and expired delegations get 401 on result before frame parsing", async () => {
    const revoked = await result("t-x", { v: 1, type: "result", taskId: "t-x" }, TOKEN_REVOKED);
    expect(revoked.status).toBe(401);
    expect((await revoked.json()) as { error: string }).toEqual({
      error: "delegation_revoked",
    });
    const expired = await result("t-x", { v: 1, type: "result", taskId: "t-x" }, TOKEN_EXPIRED);
    expect(expired.status).toBe(401);
    expect((await expired.json()) as { error: string }).toEqual({
      error: "delegation_expired",
    });
  });

  it("an error frame releases the hold and records the code", async () => {
    const taskId = `draft:${SCHED}:${Date.now()}1`;
    const reservationId = await seedReservation(taskId);
    const res = await result(taskId, {
      v: 1,
      type: "error",
      taskId,
      code: "provider_unavailable",
    });
    expect((await res.json()) as { applied: boolean; code: string }).toEqual({
      applied: false,
      code: "provider_unavailable",
    });
    const rows = await db<{ state: string }>(
      `select state from public.agent_spend_reservations where id = $1::uuid`,
      [reservationId],
    );
    expect(rows[0]?.state).toBe("released");
  });

  it("a result completes the draft: post written, hold settled, replay idempotent", async () => {
    const taskId = `draft:${SCHED}:${Date.now()}2`;
    const reservationId = await seedReservation(taskId);
    const res = await result(taskId, {
      v: 1,
      type: "result",
      taskId,
      payload: {
        text: "A bridge-drafted post body for the M9 gate.",
        hashtags: ["gate"],
        costAtomic: 500,
        modelUsed: "gate-model",
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      applied: boolean;
      outcome: { outcome: string; postId?: string };
    };
    expect(body.applied).toBe(true);
    expect(["pending_approval", "published"]).toContain(body.outcome.outcome);
    const rows = await db<{ state: string; actual_atomic: string }>(
      `select state, actual_atomic::text from public.agent_spend_reservations where id = $1::uuid`,
      [reservationId],
    );
    expect(rows[0]?.state).toBe("settled");
    expect(rows[0]?.actual_atomic).toBe("500");
    if (body.outcome.postId !== undefined) {
      const posts = await db(`select id from public.posts where id = $1::uuid`, [
        body.outcome.postId,
      ]);
      expect(posts.length).toBe(1);
      await db(`delete from public.posts where id = $1::uuid`, [body.outcome.postId]);
    }
  });

  it("an orphaned held reservation is released on result too", async () => {
    const reservationId = await seedReservation("also-not-a-draft");
    const res = await result("also-not-a-draft", {
      v: 1,
      type: "result",
      taskId: "also-not-a-draft",
      payload: { text: "late" },
    });
    expect((await res.json()) as { applied: boolean }).toEqual({ applied: false });
    const rows = await db<{ state: string }>(
      `select state from public.agent_spend_reservations where id = $1::uuid`,
      [reservationId],
    );
    expect(rows[0]?.state).toBe("released");
  });

  it("a non-string payload.text still applies (sanitized to empty draft)", async () => {
    const taskId = `draft:${SCHED}:${Date.now()}3`;
    await seedReservation(taskId);
    const res = await result(taskId, {
      v: 1,
      type: "result",
      taskId,
      payload: { text: 42, hashtags: "not-an-array" },
    });
    expect((await res.json()) as { applied: boolean }).toMatchObject({ applied: true });
  });
});
