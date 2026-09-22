// apps/edge/src/routes/posts.ts — the composer's write edge (§6 flow C).
// Publish delegates to enqueue.ts's publishPost(): one `publish_post` round
// trip — never an explicit transaction — then best-effort Q_* sends inside
// ctx.waitUntil (§4.13.1/§4.13.2).
import { actorOrResponse, asIdentityEnv } from "../auth/resolve-actor.js";
import { fresh } from "../db/client.js";
import { publishPost } from "../enqueue.js";

const JSON_HEADERS = { "content-type": "application/json", "cache-control": "no-store" } as const;
const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });

/** POST /api/posts/{id}/publish — actor must be the post's author. */
export async function handlePublishPost(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  postId: string,
): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  const actor = await actorOrResponse(asIdentityEnv(env), ctx, request);
  if (actor instanceof Response) return actor;
  if (actor.class !== "human_creator" || actor.userId === null) {
    return json({ error: "forbidden" }, 403);
  }
  const raw = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const platforms = Array.isArray(raw?.platforms)
    ? raw.platforms.filter((p): p is string => typeof p === "string")
    : [];

  const db = fresh(env);
  try {
    const owned = await db.query<{ ok: boolean }>(
      "select app.can_write_post($1::uuid, $2::uuid) as ok",
      [actor.userId, postId],
    );
    if (owned.rows[0]?.ok !== true) return json({ error: "post_not_found" }, 404);
  } finally {
    await db.end().catch(() => undefined);
  }

  try {
    const published = await publishPost(env, ctx, postId, platforms);
    return json({ ...published, status: "published" });
  } catch (e) {
    if ((e as { code?: string }).code === "22023") {
      return json({ error: "post_not_publishable" }, 409);
    }
    throw e;
  }
}
