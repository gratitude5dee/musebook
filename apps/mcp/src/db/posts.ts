// apps/edge/src/db/posts.ts — ResourceRow loads.
// The projection is packages/kernel/sql/load_resource.sql verbatim, moved into
// the migration's app.load_resource_by_{slug,post_id} helpers: a Worker bundle
// has no filesystem to read the .sql from, and a sibling app.enter(...) in the
// same SELECT binds too late at plan time (D23).
import type { ResourceRow } from "@musebook/kernel";
import type { DbClient } from "./client.js";

export async function loadPostBySlug(
  client: DbClient,
  slug: string,
  actorUserId: string | null = null,
): Promise<ResourceRow | null> {
  const { rows } = await client.query<ResourceRow>(
    "select * from app.load_resource_by_slug($1, $2::uuid)",
    [slug, actorUserId],
  );
  return rows[0] ?? null;
}

export async function loadPostByPostId(
  client: DbClient,
  postId: string,
  actorUserId: string | null = null,
): Promise<ResourceRow | null> {
  const { rows } = await client.query<ResourceRow>(
    "select * from app.load_resource_by_post_id($1::uuid, $2::uuid)",
    [postId, actorUserId],
  );
  return rows[0] ?? null;
}
