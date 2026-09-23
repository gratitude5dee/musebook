// apps/edge/src/routes/agents-me.ts — GET /api/v1/agents/me (§12.2.9).
// The shape the forked musebook.provider.ts authenticates against: an
// unmodified upstream file hits this route with the delegation token it was
// handed, so the contract is Bearer mb_dlg_* -> { success, agent }.
import { actorOrResponse, asIdentityEnv } from "../auth/resolve-actor.js";
import { fresh } from "../db/client.js";

const JSON_HEADERS = { "content-type": "application/json", "cache-control": "no-store" } as const;
const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });

export async function handleAgentsMe(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (request.method !== "GET") return new Response(null, { status: 405 });
  const actor = await actorOrResponse(asIdentityEnv(env), ctx, request);
  if (actor instanceof Response) return actor;
  if (actor.class !== "owner_agent" || actor.agentIdentityId === null) {
    return json({ success: false, error: "delegation_required" }, 401);
  }

  const db = fresh(env);
  try {
    const { rows } = await db.query<{ result: Record<string, unknown> | null }>(
      "select app.agent_me($1::uuid, $2::uuid) as result",
      [actor.agentIdentityId, actor.userId],
    );
    const agent = rows[0]?.result ?? null;
    if (agent === null) return json({ success: false, error: "agent_not_found" }, 404);
    return json({ success: true, agent });
  } finally {
    await db.end().catch(() => undefined);
  }
}
