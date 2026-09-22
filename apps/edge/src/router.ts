// apps/edge/src/router.ts — §7.10.1. The pattern tables the G-EDGE-ROUTES check
// diffs against §6.12.8's table; TWIN is never relaxed past the slug charset.
import { prefersMarkdown } from "./http/negotiate.js";
import { llmsTxt } from "./routes/llms-txt.js";
import { llmsFullTxt } from "./routes/llms-full-txt.js";
import { robotsTxt } from "./routes/robots-txt.js";
import { sitemap } from "./routes/sitemap.js";
import { authorsMd } from "./routes/authors.js";
import { atom, jsonFeedRoute, rss } from "./routes/feeds.js";

export type RouteHandler = (
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  match: RegExpMatchArray | null,
) => Promise<Response> | Response;

// §6.12.8: the static surfaces served entirely by the Worker. This map, and only
// this map, is where the Worker answers without resolving an actor or a post.
export const STATIC_ROUTES: Readonly<Record<string, RouteHandler>> = {
  "/llms.txt": llmsTxt,
  "/llms-full.txt": llmsFullTxt,
  "/robots.txt": robotsTxt,
  "/sitemap.xml": sitemap,
  "/authors.md": authorsMd,
  "/feed.xml": rss,
  "/atom.xml": atom,
  "/feed.json": jsonFeedRoute,
};

// §7.10.1. `/p/{slug}.{md,json,jsonld}` — a twin is one extension past the slug.
// Never relax the slug arm to `(.+)`: a dot in the slug would fork the regex
// onto a path the kernel cannot load, and `.{rep}` becomes a wildcard.
export const TWIN = /^\/p\/([a-z0-9][a-z0-9-]{1,79})\.(md|json|jsonld)$/;
export const AUTHOR_TWIN = /^\/@([a-z0-9][a-z0-9_-]{1,29})\.md$/;
export const AUTHOR_FEED = /^\/@([a-z0-9][a-z0-9_-]{1,29})\/feed\.xml$/;

export type Representation = "html" | "markdown" | "json" | "jsonld";

export interface ResourceTarget {
  slug: string;
  as: Representation;
}

export const REP_BY_EXT: Readonly<Record<string, Representation>> = {
  md: "markdown",
  json: "json",
  jsonld: "jsonld",
};

/**
 * `/p/{slug}` -> { slug, as: 'html' } — or 'markdown' when the client stated a
 * strictly stronger preference for text/markdown (§7.10.2).
 * `/p/{slug}.{md,json,jsonld}` -> the twin, always.
 * Anything else is not a resource URL and returns null.
 */
export function parseResourceUrl(url: URL, accept: string | null): ResourceTarget | null {
  const twin = TWIN.exec(url.pathname);
  if (twin !== null) {
    const slug = twin[1] as string;
    const ext = twin[2] as string;
    return { slug, as: REP_BY_EXT[ext] ?? "markdown" };
  }
  const page = /^\/p\/([a-z0-9][a-z0-9-]{1,79})$/.exec(url.pathname);
  if (page !== null) {
    const slug = page[1] as string;
    return { slug, as: prefersMarkdown(accept) ? "markdown" : "html" };
  }
  return null;
}

export interface AuthorTarget {
  kind: "author_twin" | "author_feed";
  handle: string;
}

/** AUTHOR_TWIN + AUTHOR_FEED are Worker-served (§7.10's route table) — matched
 *  here so index.ts's order stays the single dispatch source. */
export function matchAuthorRoute(pathname: string): AuthorTarget | null {
  const twin = AUTHOR_TWIN.exec(pathname);
  if (twin !== null) return { kind: "author_twin", handle: twin[1] as string };
  const feed = AUTHOR_FEED.exec(pathname);
  if (feed !== null) return { kind: "author_feed", handle: feed[1] as string };
  return null;
}
