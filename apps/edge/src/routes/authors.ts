// apps/edge/src/routes/authors.ts — `/authors.md` and `/@{handle}.md`
// (§7.10.1's AUTHOR_TWIN): markdown over the public author plane only —
// handle, display name, bio, avatar, post list with per-post pricing lines.
import { pricingLineFor } from "@musebook/kernel";
import { authorProfile, listAuthorPosts, listAuthorsCount } from "../db/catalog.js";
import { cached, release } from "../db/client.js";
import { cacheHeadersFor } from "../http/cache.js";
import { notFound } from "../http.js";
import { canonicalOrigin } from "../index.js";

export async function authorsMd(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const sql = cached(env);
  try {
    const origin = canonicalOrigin(new URL(req.url));
    const count = await listAuthorsCount(sql);
    const body = [
      "# Musebook — author index",
      "",
      `${count} authors. Each author's posts are at ${origin}/@{handle}.md; each`,
      "profile page is the HTML at the same handle without the extension.",
      "",
      `The feeds: ${origin}/feed.xml · ${origin}/atom.xml · ${origin}/feed.json`,
      "",
    ].join("\n");
    return new Response(body, {
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        ...cacheHeadersFor({ shared: true, sMaxAge: 3600, swr: 86_400 }),
      },
    });
  } finally {
    release(ctx, sql);
  }
}

/** `/@{handle}.md` — one author's page as markdown (the AUTHOR_TWIN arm). */
export async function authorTwin(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  match: RegExpMatchArray | null,
): Promise<Response> {
  const handle = match?.[1];
  if (handle === undefined) return notFound();
  const sql = cached(env);
  try {
    const origin = canonicalOrigin(new URL(req.url));
    const profile = await authorProfile(sql, handle);
    if (profile === null) return notFound();
    const posts = await listAuthorPosts(sql, handle, 100);
    const body = [
      `# ${profile.display_name ?? handle} (@${handle})`,
      "",
      profile.bio ?? "",
      "",
      "## Posts",
      "",
      ...posts.map((p) =>
        `- [${p.title ?? p.slug}](${origin}/p/${p.slug}.md): ${pricingLineFor(p)} ${p.summary ?? ""}`.trimEnd(),
      ),
      "",
      `Feed: ${origin}/@${handle}/feed.xml`,
      "",
    ].join("\n");
    return new Response(body, {
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        ...cacheHeadersFor({ shared: true, sMaxAge: 600, swr: 86_400 }),
        vary: "Accept",
      },
    });
  } finally {
    release(ctx, sql);
  }
}
