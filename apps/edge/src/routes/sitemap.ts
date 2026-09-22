// apps/edge/src/routes/sitemap.ts — §7.14, verbatim: honour search_indexable,
// 45_000 cap under the 50_000 limit.
import { listPublicResources } from "../db/catalog.js";
import { cached, release } from "../db/client.js";
import { cacheHeadersFor } from "../http/cache.js";
import { canonicalOrigin } from "../index.js";

export async function sitemap(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const sql = cached(env);
  try {
    const origin = canonicalOrigin(new URL(req.url));
    const posts = (
      await listPublicResources(sql, { limit: 45_000, order: "published_at desc" })
    ).filter((p) => p.searchIndexable);
    const url = (loc: string, lastmod?: string, freq?: string, pri?: number): string =>
      `<url><loc>${loc}</loc>` +
      (lastmod ? `<lastmod>${lastmod}</lastmod>` : "") +
      (freq ? `<changefreq>${freq}</changefreq>` : "") +
      (pri !== undefined ? `<priority>${pri}</priority>` : "") +
      "</url>";
    const body =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
      url(origin, undefined, "hourly", 1) +
      url(`${origin}/authors`, undefined, "daily", 0.6) +
      posts
        .map((p) =>
          url(
            `${origin}/p/${p.slug}`,
            new Date(p.updatedAt).toISOString(),
            p.kind === "article" ? "weekly" : "monthly",
            p.kind === "article" ? 0.8 : 0.5,
          ),
        )
        .join("") +
      "</urlset>";
    return new Response(body, {
      headers: {
        "content-type": "application/xml; charset=utf-8",
        ...cacheHeadersFor({ shared: true, sMaxAge: 3600 }),
      },
    });
  } finally {
    release(ctx, sql);
  }
}
