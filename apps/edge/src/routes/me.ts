// apps/edge/src/routes/me.ts — the DSAR surface (§15.11). One route prefix,
// one table, one Queue consumer, five verbs. The export artifact is an R2 KEY
// on musebook-paid, never a URL — this route re-checks the session and
// streams it from the binding.
import { actorOrResponse, asIdentityEnv } from "../auth/resolve-actor.js";
import type { Actor } from "@musebook/schema";
import { bound, fresh } from "../db/client.js";
import { enqueueJob } from "../enqueue.js";

const JSON_HEADERS = { "content-type": "application/json", "cache-control": "no-store" } as const;
const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });

function humanActor(actor: Actor): string | null {
  return actor.class === "human_creator" || actor.class === "human_reader" ? actor.userId : null;
}

interface DsarRow {
  id: string;
  kind: string;
  state: string;
  requested_at: string;
  completed_at: string | null;
  artifact_key: string | null;
}

async function readRequest(env: Env, requestId: string, userId: string): Promise<DsarRow | null> {
  const db = fresh(env);
  try {
    const { rows } = await db.query<DsarRow>(
      "select * from app.read_dsar_request($1::uuid, $2::uuid)",
      [requestId, userId],
    );
    return rows[0] ?? null;
  } finally {
    await db.end().catch(() => undefined);
  }
}

async function createRequest(
  env: Env,
  ctx: ExecutionContext,
  request: Request,
  kind: "export" | "delete" | "objection",
): Promise<Response> {
  const actor = await actorOrResponse(asIdentityEnv(env), ctx, request);
  if (actor instanceof Response) return actor;
  const userId = humanActor(actor);
  if (userId === null) return json({ error: "sign_in_required" }, 401);

  // A deletion must be re-authenticated: a month-old session cookie is not
  // proof of presence. The web app mints a fresh marker into this header.
  if (kind === "delete" && !request.headers.get("x-mb-reauth")) {
    return json({ error: "reauth_required" }, 401);
  }

  const db = fresh(env);
  let requestId: string;
  try {
    const { rows } = await db.query<{ id: string }>(
      "select app.create_dsar_request($1::uuid, null, $2) as id",
      [userId, kind],
    );
    const id = rows[0]?.id;
    if (id === undefined) throw new Error("create_dsar_request returned no id");
    requestId = id;
  } finally {
    await db.end().catch(() => undefined);
  }

  if (kind === "objection") {
    // Immediate effect, not a queue: the flag §13.4.6's collector checks.
    const db2 = fresh(env);
    try {
      await db2.query(
        "select app.record_consent_event($1::uuid, null, 'analytics', false, 'settings')",
        [userId],
      );
    } finally {
      await db2.end().catch(() => undefined);
    }
  } else {
    await enqueueJob(
      env,
      ctx,
      "dsar",
      `dsar:${kind}:${requestId}`,
      { request_id: requestId, kind, user_id: userId },
      userId,
    );
  }
  return json({ request_id: requestId, state: "received" }, 202);
}

export async function handleMeExport(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST") {
    return new Response(null, { status: 405 });
  }
  return createRequest(env, ctx, request, "export");
}

export async function handleMeDelete(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  return createRequest(env, ctx, request, "delete");
}

export async function handleMeObjection(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  return createRequest(env, ctx, request, "objection");
}

export async function handleMeRequestStatus(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  requestId: string,
): Promise<Response> {
  if (request.method !== "GET") return new Response(null, { status: 405 });
  const actor = await actorOrResponse(asIdentityEnv(env), ctx, request);
  if (actor instanceof Response) return actor;
  const userId = humanActor(actor);
  if (userId === null) return json({ error: "sign_in_required" }, 401);
  const row = await readRequest(env, requestId, userId);
  if (row === null) return json({ error: "not_found" }, 404);
  return json({
    request_id: row.id,
    kind: row.kind,
    state: row.state,
    requested_at: row.requested_at,
    completed_at: row.completed_at,
    downloadable: row.artifact_key !== null,
  });
}

export async function handleMeRequestDownload(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  requestId: string,
): Promise<Response> {
  if (request.method !== "GET") return new Response(null, { status: 405 });
  const actor = await actorOrResponse(asIdentityEnv(env), ctx, request);
  if (actor instanceof Response) return actor;
  const userId = humanActor(actor);
  if (userId === null) return json({ error: "sign_in_required" }, 401);
  const row = await readRequest(env, requestId, userId);
  if (row === null) return json({ error: "not_found" }, 404);
  if (row.kind !== "export" || row.state !== "completed") {
    return json({ error: "not_ready", state: row.state }, 409);
  }
  if (row.artifact_key === null) {
    // The 7-day lifecycle rule already collected it; the sweep nulled the key.
    return json({ error: "expired" }, 410);
  }
  const object = await bound(env.PAID_MEDIA, "PAID_MEDIA").get(row.artifact_key);
  if (object === null || !("body" in object)) return json({ error: "expired" }, 410);
  return new Response(object.body, {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="musebook-export-${row.id}.zip"`,
      "cache-control": "private, no-store",
      "content-length": String(object.size),
    },
  });
}
