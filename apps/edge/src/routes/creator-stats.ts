// apps/edge/src/routes/creator-stats.ts — GET /api/creator/stats (§13.8).
// The only serve-path read of the rollup tables: jobs plane via
// app.creator_dashboard, HYPERDRIVE_CACHED because the data is a day stale by
// construction and a cached binding is the correct consistency level.
import { actorOrResponse, asIdentityEnv } from "../auth/resolve-actor.js";
import { cached } from "../db/client.js";

const JSON_HEADERS = {
  "content-type": "application/json",
  "cache-control": "private, max-age=300",
} as const;
const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });

export async function handleCreatorStats(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (request.method !== "GET") return new Response(null, { status: 405 });
  const actor = await actorOrResponse(asIdentityEnv(env), ctx, request);
  if (actor instanceof Response) return actor;
  if (actor.class !== "human_creator" || actor.userId === null) {
    return json({ error: "creator_only" }, 403);
  }
  const db = cached(env);
  try {
    const { rows } = await db.query<{ creator_dashboard: unknown }>(
      "select app.creator_dashboard($1::uuid)",
      [actor.userId],
    );
    return json(rows[0]?.creator_dashboard ?? {});
  } finally {
    await db.end().catch(() => undefined);
  }
}
