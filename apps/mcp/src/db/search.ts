// apps/mcp/src/db/search.ts — catalog reads for the public tools.
// Everything below runs under `musebook_public_reader` (entered inside each
// app.* helper) on whichever binding the caller passes — public rows are safe
// on HYPERDRIVE_CACHED. The publish-mode column is never touched from app
// code (§3.4): access badges are computed inside the SQL helpers and the
// `access` filter is applied there too.
import type { Sql } from "./client.js";

export interface SearchHit {
  post_id: string;
  slug: string;
  title: string | null;
  summary: string | null;
  kind: string;
  author_handle: string;
  published_at: string;
  content_hash: string;
  access_badge: "open" | "toll" | "gated";
  price_atomic: string;
  price_asset: string | null;
  price_network: string | null;
  license_spdx: string;
  tags: string[];
  rank: number;
}

export interface SearchArgs {
  query: string;
  author?: string | undefined;
  kind?: string | undefined;
  tags?: string[] | undefined;
  access?: "open" | "toll" | "gated" | "any" | undefined;
  published_after?: string | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
}

const b64uEncode = (s: string): string =>
  btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const b64uDecode = (s: string): string => atob(s.replace(/-/g, "+").replace(/_/g, "/"));

function parseCursor(cursor: string | undefined): { publishedAt: string; postId: string } | null {
  if (cursor === undefined) return null;
  try {
    const raw = JSON.parse(b64uDecode(cursor)) as {
      pa?: unknown;
      id?: unknown;
    };
    return typeof raw.pa === "string" && typeof raw.id === "string"
      ? { publishedAt: raw.pa, postId: raw.id }
      : null;
  } catch {
    return null;
  }
}

function makeCursor(last: SearchHit | undefined): string | null {
  if (last === undefined) return null;
  return b64uEncode(JSON.stringify({ pa: last.published_at, id: last.post_id }));
}

export interface SearchPage {
  results: SearchHit[];
  nextCursor: string | null;
  markdownTable: string;
}

function table(rows: SearchHit[], cols: [keyof SearchHit, string][]): string {
  const head = `| ${cols.map(([, h]) => h).join(" | ")} |`;
  const rule = `| ${cols.map(() => "---").join(" | ")} |`;
  const body = rows.map(
    (r) =>
      `| ${cols
        .map(([k]) =>
          String(r[k] ?? "")
            .replaceAll("|", "\\|")
            .replaceAll("\n", " "),
        )
        .join(" | ")} |`,
  );
  return [head, rule, ...body].join("\n");
}

export async function searchPosts(sql: Sql, args: SearchArgs): Promise<SearchPage> {
  const cur = parseCursor(args.cursor);
  const rows = (await sql.unsafe(
    `select * from app.search_posts(
       $1::text, $2::text, $3::text, $4::text[], $5::timestamptz, $6::timestamptz, $7::uuid,
       $8::int, $9::text)`,
    [
      args.query,
      args.author ?? null,
      args.kind ?? null,
      args.tags && args.tags.length > 0 ? args.tags : null,
      args.published_after ?? null,
      cur?.publishedAt ?? null,
      cur?.postId ?? null,
      args.limit ?? 20,
      args.access ?? "any",
    ],
  )) as SearchHit[];
  const nextCursor = rows.length === (args.limit ?? 20) ? makeCursor(rows.at(-1)) : null;
  return {
    results: rows,
    nextCursor,
    markdownTable: table(rows, [
      ["slug", "slug"],
      ["title", "title"],
      ["kind", "kind"],
      ["author_handle", "author"],
      ["access_badge", "access"],
      ["price_atomic", "price_atomic"],
      ["content_hash", "content_hash"],
    ]),
  };
}

export interface AuthorRow {
  handle: string;
  display_name: string | null;
  bio: string | null;
  post_count: number;
  follower_count: number;
  has_paid_posts: boolean;
}

export interface ListAuthorsArgs {
  query?: string | undefined;
  sort?: "recent" | "followers" | "posts" | undefined;
  accepts_agent_payment?: boolean | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
}

export async function listAuthors(sql: Sql, args: ListAuthorsArgs) {
  const offset = Number(args.cursor ?? "0") || 0;
  const rows = (await sql.unsafe(
    `select * from app.list_authors($1::text, $2::text, $3::boolean, $4::int, $5::int)`,
    [
      args.query ?? null,
      args.sort ?? "recent",
      args.accepts_agent_payment ?? null,
      args.limit ?? 50,
      offset,
    ],
  )) as AuthorRow[];
  const nextCursor = rows.length === (args.limit ?? 50) ? String(offset + rows.length) : null;
  return {
    results: rows,
    nextCursor,
    markdownTable: table(
      rows as unknown as SearchHit[],
      [
        ["handle", "handle"],
        ["display_name", "name"],
        ["post_count", "posts"],
        ["follower_count", "followers"],
        ["has_paid_posts", "paid_posts"],
      ] as unknown as [keyof SearchHit, string][],
    ),
  };
}
