// apps/edge/src/routes/feeds.ts — §7.15's four feed routes. Every item goes
// through renderResource(resource, 'feed', decision); `feed` is the one
// representation with no gated variant, so a gated post contributes its free
// portion only — never a body, in any feed, ever.
import { createKernel, toAccessBadge } from "@musebook/kernel";
import type { AccessDecision, Resource } from "@musebook/schema";
import { listAuthorPosts, listPublicResources } from "../db/catalog.js";
import { cached, fresh, release } from "../db/client.js";
import { cacheHeadersFor } from "../http/cache.js";
import { notFound } from "../http.js";
import { canonicalOrigin } from "../index.js";
import { portsFor } from "../kernel/configure.js";

// Feed items never vary by viewer — the synthetic deny forces the free-portion
// projection regardless of who is reading. `feed` ignores bodyKind entirely.
const DENIED: AccessDecision = {
  allow: false,
  reason: "payment_required",
  bodyKind: "preview",
  httpStatus: 402,
  challenge: null,
  cache: { cacheControl: "private, no-store", vary: ["*"], shared: false },
};

const siteUrl = (req: Request): string => canonicalOrigin(new URL(req.url));
const mcpUrl = (): string => "https://mcp.musebook.dev";

const esc = (s: string): string =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

interface FeedItem {
  readonly resource: Resource;
  readonly item: Record<string, unknown>;
}

async function feedItems(
  env: Env,
  ctx: ExecutionContext,
  resources: Resource[],
): Promise<FeedItem[]> {
  const db = fresh(env);
  try {
    const kernel = createKernel(
      portsFor(new Request("https://musebook.dev/"), env, ctx, { actorUserId: null }, db),
    );
    const out: FeedItem[] = [];
    for (const resource of resources) {
      const rendered = await kernel.renderResource(resource, "feed", DENIED);
      out.push({ resource, item: rendered.structured as Record<string, unknown> });
    }
    return out;
  } finally {
    release(ctx, db);
  }
}

const FEED_HEADERS = {
  "cache-tag": "feed",
  ...cacheHeadersFor({ shared: true, sMaxAge: 600 }),
};

function rssDoc(
  req: Request,
  title: string,
  homeUrl: string,
  feedUrl: string,
  items: FeedItem[],
): string {
  const origin = siteUrl(req);
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"' +
    ' xmlns:atom="http://www.w3.org/2005/Atom">' +
    `<channel><title>${esc(title)}</title><link>${esc(homeUrl)}</link>` +
    `<description>Posts, articles, media and artifacts from Musebook.</description>` +
    `<atom:link href="${esc(feedUrl)}" rel="self" type="application/rss+xml"/>` +
    items
      .map(({ resource, item }) => {
        const link = `${origin}/p/${resource.slug}`;
        return (
          `<item><title>${esc((item.title as string) ?? resource.slug)}</title>` +
          `<link>${link}</link><guid isPermaLink="true">${link}</guid>` +
          `<description>${esc((item.content_text as string) ?? resource.summary ?? "")}</description>` +
          `<pubDate>${new Date(resource.publishedAt ?? resource.updatedAt).toUTCString()}</pubDate>` +
          `</item>`
        );
      })
      .join("") +
    "</channel></rss>"
  );
}

function atomDoc(
  req: Request,
  title: string,
  homeUrl: string,
  feedUrl: string,
  items: FeedItem[],
): string {
  const origin = siteUrl(req);
  const updated =
    items[0] === undefined
      ? new Date().toISOString()
      : new Date(items[0].resource.updatedAt).toISOString();
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<feed xmlns="http://www.w3.org/2005/Atom">' +
    `<title>${esc(title)}</title><link href="${esc(homeUrl)}"/>` +
    `<link href="${esc(feedUrl)}" rel="self" type="application/atom+xml"/>` +
    `<id>${esc(homeUrl)}</id><updated>${updated}</updated>` +
    items
      .map(({ resource, item }) => {
        const link = `${origin}/p/${resource.slug}`;
        return (
          `<entry><title>${esc((item.title as string) ?? resource.slug)}</title>` +
          `<link rel="alternate" type="text/html" href="${link}"/>` +
          `<link rel="alternate" type="text/markdown" href="${link}.md"/>` +
          `<id>${link}</id>` +
          `<updated>${new Date(resource.updatedAt).toISOString()}</updated>` +
          `<summary>${esc(resource.summary ?? "")}</summary>` +
          `<author><name>${esc(resource.authorDisplayName ?? resource.authorHandle)}</name></author>` +
          "</entry>"
        );
      })
      .join("") +
    "</feed>"
  );
}

function jsonFeed(
  req: Request,
  title: string,
  homeUrl: string,
  feedUrl: string,
  items: FeedItem[],
): string {
  return JSON.stringify({
    version: "https://jsonfeed.org/version/1.1",
    title,
    home_page_url: homeUrl,
    feed_url: feedUrl,
    description: "Posts, articles, media and artifacts from Musebook.",
    items: items.map(({ resource, item }) => ({
      ...item,
      _musebook: {
        access: toAccessBadge(resource).kind,
        content_hash: resource.contentHash,
        markdown_url: `${siteUrl(req)}/p/${resource.slug}.md`,
        ...(resource.priceUsd !== null ? { price_usd: resource.priceUsd } : {}),
        ...(resource.priceAtomic !== null ? { price_atomic: resource.priceAtomic } : {}),
        ...(resource.priceAsset !== null ? { asset: resource.priceAsset } : {}),
        ...(resource.priceNetwork !== null ? { network: resource.priceNetwork } : {}),
        license_spdx: resource.licenseSpdx,
        mcp_endpoint: `${mcpUrl()}/mcp`,
        mcp_tool: "get_post",
      },
    })),
  });
}

async function loadFeedResources(
  env: Env,
  ctx: ExecutionContext,
  handle: string | null,
): Promise<Resource[] | null> {
  const sql = cached(env);
  try {
    if (handle === null) {
      return await listPublicResources(sql, { limit: 50, order: "published_at desc" });
    }
    const posts = await listAuthorPosts(sql, handle, 50);
    return posts.length === 0 ? null : posts;
  } finally {
    release(ctx, sql);
  }
}

async function feedResponse(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  format: "rss" | "atom" | "json",
  handle: string | null = null,
): Promise<Response> {
  const resources = await loadFeedResources(env, ctx, handle);
  if (resources === null) return notFound();
  const origin = siteUrl(req);
  const title = handle === null ? "Musebook" : `Musebook — @${handle}`;
  const home = handle === null ? origin : `${origin}/@${handle}`;
  const feedUrl =
    handle === null
      ? `${origin}/${format === "json" ? "feed.json" : `${format}.xml`}`
      : `${origin}/@${handle}/feed.xml`;
  const items = await feedItems(env, ctx, resources);
  if (format === "json") {
    return new Response(jsonFeed(req, title, home, feedUrl, items), {
      headers: {
        "content-type": "application/feed+json; charset=utf-8",
        ...FEED_HEADERS,
      },
    });
  }
  const xml =
    format === "rss"
      ? rssDoc(req, title, home, feedUrl, items)
      : atomDoc(req, title, home, feedUrl, items);
  return new Response(xml, {
    headers: {
      "content-type":
        format === "rss"
          ? "application/rss+xml; charset=utf-8"
          : "application/atom+xml; charset=utf-8",
      ...FEED_HEADERS,
    },
  });
}

export const rss = (req: Request, env: Env, ctx: ExecutionContext) =>
  feedResponse(req, env, ctx, "rss");
export const atom = (req: Request, env: Env, ctx: ExecutionContext) =>
  feedResponse(req, env, ctx, "atom");
export const jsonFeedRoute = (req: Request, env: Env, ctx: ExecutionContext) =>
  feedResponse(req, env, ctx, "json");
export const authorFeed = (
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  match: RegExpMatchArray | null,
) => feedResponse(req, env, ctx, "rss", match?.[1] ?? null);
