// apps/edge/src/db/catalog.ts — the catalog queries the crawl/feed surfaces
// run on HYPERDRIVE_CACHED (public rows only; the helpers that join post_bodies
// are security definer — D39 — and expose canonical_markdown only for free
// posts, so nothing gated is ever returned).
import { loadResource, type ResourceRow } from "@musebook/kernel";
import type { Resource } from "@musebook/schema";
import type { DbClient } from "./client.js";

export async function listPublicResources(
  db: DbClient,
  opts: { limit: number; order?: string },
): Promise<Resource[]> {
  // `order` is fixed by the callers (published_at desc); the helper orders by
  // it — there is no second ordering to accept, so an `order` arg is read as a
  // no-op here rather than opening a SQL-injection surface in the helper.
  void opts.order;
  const { rows } = await db.query<ResourceRow>("select * from app.list_public_resources($1)", [
    opts.limit,
  ]);
  return rows.map(loadResource);
}

export async function listAuthorsCount(db: DbClient): Promise<number> {
  const { rows } = await db.query<{ n: number }>("select app.list_authors_count() as n");
  return rows[0]?.n ?? 0;
}

export async function listAuthorPosts(
  db: DbClient,
  handle: string,
  limit: number,
): Promise<Resource[]> {
  const { rows } = await db.query<ResourceRow>("select * from app.list_author_posts($1, $2)", [
    handle,
    limit,
  ]);
  return rows.map(loadResource);
}

export interface AuthorRow {
  handle: string;
  display_name: string | null;
  bio: string | null;
  avatar_url: string | null;
  post_count: number;
  wallet: string | null;
  license_spdx: string | null;
}

export async function listAuthors(db: DbClient, limit: number): Promise<AuthorRow[]> {
  const { rows } = await db.query<AuthorRow>("select * from app.list_authors($1)", [limit]);
  return rows;
}

export interface AuthorProfile {
  user_id: string;
  handle: string;
  display_name: string | null;
  bio: string | null;
  avatar_url: string | null;
  website_url: string | null;
  is_verified: boolean;
}

export async function authorProfile(db: DbClient, handle: string): Promise<AuthorProfile | null> {
  const { rows } = await db.query<AuthorProfile>("select * from app.author_profile($1)", [handle]);
  return rows[0] ?? null;
}
