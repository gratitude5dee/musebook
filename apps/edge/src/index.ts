// apps/edge/src/index.ts — §6.12.2, verbatim. One file, one order:
// pass-through -> static routes -> media hosts -> parse -> resolve -> render
// or origin. THE request path (§3.1).
import { createKernel, loadResource, toAccessBadge } from "@musebook/kernel";
import type { Actor, Resource } from "@musebook/schema";
import { actorOrResponse, asIdentityEnv } from "./auth/resolve-actor.js"; // §5.6.1
import { portsFor } from "./kernel/configure.js";
import { serveMedia } from "./media.js"; // §6.12.4
import { bound, fresh, release } from "./db/client.js";
import { applyCacheHeaders } from "./http/cache.js"; // §6.12.5
import { renderedToResponse, notFound } from "./http.js";
import { parseResourceUrl, STATIC_ROUTES } from "./router.js"; // §7.10.1
import { handleEvents } from "./routes/events.js"; // §13.4.3
import { handleFeedForYou, handleFeedReels, handleFeedScored } from "./routes/feed.js"; // §9.21
import { handlePublishPost } from "./routes/posts.js"; // §6 flow C
import { routeUploads } from "./routes/uploads.js"; // §11.7.3
import { twin } from "./routes/twin.js"; // §7.11
import { authorTwin } from "./routes/authors.js";
import { authorFeed } from "./routes/feeds.js";
import { AUTHOR_FEED, AUTHOR_TWIN } from "./router.js";

/** Passed straight to Vercel before any gate runs. `/.well-known/*` is here
 *  because blocking it breaks Vercel's certificate renewal, and these two
 *  because the Worker has no handler for them. Everything else that is always
 *  free is RENDERED by the Worker through STATIC_ROUTES below — §6.12.8. */
const ORIGIN_PASSTHROUGH = new Set(["/security.txt", "/crawlers.json"]);

/** `/api/*` is the Worker's own; it never reaches Vercel (§9.21). */
const API_ROUTES: Readonly<
  Record<string, (r: Request, e: Env, c: ExecutionContext) => Promise<Response>>
> = {
  "/api/events": handleEvents,
  "/api/feed/foryou": handleFeedForYou,
  "/api/feed/reels": handleFeedReels,
  "/api/feed/scored": handleFeedScored,
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (ORIGIN_PASSTHROUGH.has(url.pathname) || url.pathname.startsWith("/.well-known/")) {
      return toOrigin(request, env);
    }

    // media.musebook.dev and artifacts.musebook.dev have their own gate (§6.12.4).
    if (url.hostname === env.MEDIA_HOST || url.hostname === env.ARTIFACT_HOST) {
      return serveMedia(request, env, ctx);
    }

    // /api/* never reaches Vercel — §9.21's route table.
    const api = API_ROUTES[url.pathname];
    if (api !== undefined) return api(request, env, ctx);

    // The composer's write edge (§6 flow C) + §11.7.3's signed-PUT orchestrator.
    if (url.pathname.startsWith("/api/uploads/")) {
      const uploads = routeUploads(url.pathname);
      if (uploads !== null) return uploads(request, env, ctx);
    }
    const publishMatch = url.pathname.match(
      /^\/api\/posts\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/publish$/,
    );
    const publishPostId = publishMatch?.[1];
    if (publishPostId !== undefined) {
      return handlePublishPost(request, env, ctx, publishPostId);
    }

    // The crawl surface. §7.10.1 owns this table; the handlers render IN THE
    // WORKER and the response is never charged — the whole point, because
    // /llms.txt and /llms-full.txt carry the price signal built from
    // pricingLineFor() (§6.3, §6.12.8), and proxying them to a static file on
    // Vercel would publish a stale one. The handlers that emit only a free
    // portion (the feeds, /llms-full.txt) trim it themselves.
    const free = STATIC_ROUTES[url.pathname];
    if (free !== undefined) return free(request, env, ctx, null);

    // /@{handle}.md and /@{handle}/feed.xml — Worker-served per §7.10.
    const authorTwinMatch = AUTHOR_TWIN.exec(url.pathname);
    if (authorTwinMatch !== null) return authorTwin(request, env, ctx, authorTwinMatch);
    const authorFeedMatch = AUTHOR_FEED.exec(url.pathname);
    if (authorFeedMatch !== null) return authorFeed(request, env, ctx, authorFeedMatch);

    // /p/{slug}.{md,json,jsonld} — §7.11's twin handler, one code path for the
    // literal twin and for the Accept-negotiated form below.
    const twinMatch = url.pathname.match(/^\/p\/([a-z0-9][a-z0-9-]{1,79})\.(md|json|jsonld)$/);
    if (twinMatch !== null) {
      const actor = await actorOrResponse(asIdentityEnv(env), ctx, request);
      if (actor instanceof Response) return actor;
      return twin(request, env, ctx, twinMatch, actor);
    }

    // /p/{slug}, or an Accept-negotiated canonical URL. Returns null for
    // everything else, which passes through untouched.
    const target = parseResourceUrl(url, request.headers.get("accept"));
    if (target === null) return toOrigin(request, env);

    const db = fresh(env);
    try {
      const ports = portsFor(request, env, ctx, { actorUserId: null }, db); // per request, never a global
      const kernel = createKernel(ports); // §6.3: not configureKernel, see above
      const actor = await actorOrResponse(asIdentityEnv(env), ctx, request);
      if (actor instanceof Response) return actor;

      const row = await ports.resources.loadRowBySlug(target.slug);
      if (row === null) return notFound();
      const resource = loadResource(row);

      // THE decision. Nothing above this line reads the publishing mode; nothing below
      // it re-decides. A thrown check denies (spine invariant 9) inside resolveAccess.
      const decision = await kernel.resolveAccess(resource, actor);

      // A denial, and the negotiated non-html form, is rendered here and never
      // touches the origin — §7.11's handler again, with a synthetic match.
      if (target.as !== "html") {
        const rep = target.as === "markdown" ? "md" : target.as === "jsonld" ? "jsonld" : "json";
        const res = await twin(
          request,
          env,
          ctx,
          [url.pathname, target.slug, rep] as RegExpMatchArray,
          actor,
        );
        // §7.10.2's negotiated response: Vary: Accept and private, no-store on
        // top of the twin's own cache headers — the URL serves two
        // representations and a shared cache must never mix them.
        return applyCacheHeaders(res, decision, env, true);
      }
      if (!decision.allow) {
        const rendered = await kernel.renderResource(resource, target.as, decision);
        return applyCacheHeaders(renderedToResponse(rendered), decision, env);
      }

      const res = await toOrigin(request, env, { actor, resource });
      return applyCacheHeaders(res, decision, env);
    } finally {
      release(ctx, db);
    }
  },
} satisfies ExportedHandler<Env>;

/**
 * §3.6.1's inner entrypoint of the Workers-Caching gateway pattern. The
 * default export above is the gate — it always runs, cache disabled — and
 * only ever reaches here AFTER an allow decision. This export is the one
 * `wrangler.jsonc` marks cacheable and keyed on URL alone, so every paying
 * agent shares one cache entry. Object keys are content-addressed (§6.12.4),
 * so `immutable` is honest: the bytes at a key can never change.
 */
export const PaidMedia = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const key = decodeURIComponent(url.pathname.slice(1));
    const bucket = bound(
      url.hostname === env.ARTIFACT_HOST ? env.ARTIFACTS : env.PAID_MEDIA,
      url.hostname === env.ARTIFACT_HOST ? "ARTIFACTS" : "PAID_MEDIA",
    );
    const object = await bucket.get(key);
    if (object === null || !("body" in object)) return new Response(null, { status: 404 });
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);
    headers.set("cache-control", "public, max-age=31536000, immutable");
    headers.set("content-length", String(object.size));
    return new Response(request.method === "HEAD" ? null : object.body, {
      status: 200,
      headers,
    });
  },
} satisfies ExportedHandler<Env>;

/** The ONLY place in the codebase a request leaves for Vercel.
 *  §6.12.2 keeps it in this file: gate check 14 asserts CF-Connecting-IP is
 *  read nowhere else but here and telemetry/privacy.ts. */
async function toOrigin(
  request: Request,
  env: Env,
  ctx?: { actor: Actor; resource: Resource },
): Promise<Response> {
  // §6.12.2: the request is REBUILT on ORIGIN_HOST (the public <project>.vercel.app
  // hostname — the "no fetchable origin" var). Fetching the zone hostname back
  // would loop the request into this same Worker.
  const url = new URL(request.url);
  const req = new Request(
    new URL(
      url.pathname + url.search,
      // ORIGIN_SCHEME is only ever "http" for the local dev pair (wrangler dev
      // → next dev); no wrangler.jsonc sets it, so deployed envs keep https.
      `${env.ORIGIN_SCHEME ?? "https"}://${env.ORIGIN_HOST}`,
    ),
    request,
  );

  // (1) STRIP every inbound x-mb-* header. They are ours; a client may not set one.
  for (const k of [...req.headers.keys()]) {
    if (k.toLowerCase().startsWith("x-mb-")) req.headers.delete(k);
  }

  // (2) ORIGIN LOCKDOWN. proxy.ts 404s anything without this (§6.12.7).
  req.headers.set("x-musebook-edge", env.MUSEBOOK_EDGE_SECRET);

  // (3) What Vercel can no longer work out for itself. Behind a proxy, Vercel
  //     sees Cloudflare PoP IPs: its geo helpers and its ip-country header are
  //     all dead (CF-SPINE §1). These three headers replace them, and they are
  //     trustworthy at the origin ONLY because (1) stripped and (2) authenticated.
  req.headers.set("x-mb-request-id", crypto.randomUUID());
  req.headers.set("x-mb-country", (request.cf?.country as string | undefined) ?? "XX");
  req.headers.set("x-mb-client-ip", request.headers.get("CF-Connecting-IP") ?? "");

  // (4) The kernel's own projections, so apps/web never needs the mode (§6.3).
  if (ctx !== undefined) {
    req.headers.set("x-mb-plane", ctx.actor.plane);
    req.headers.set("x-mb-access-badge", toAccessBadge(ctx.resource).kind);
  }

  // `global_fetch_strictly_public` is NOT enabled: the default same-zone route
  // sends this straight to the Vercel origin with no 1019 loop — and bypasses
  // Cloudflare's own security settings, which is exactly why every gate above
  // has already run.
  return fetch(req);
}

/** §6.3's PolicyPort.siteOrigin(). A pure function of the request, so there is
 *  no second place a canonical origin can be set wrong. §3.7 scopes
 *  NEXT_PUBLIC_SITE_URL to Vercel only and this section adds no env var. */
export function canonicalOrigin(url: URL): string {
  return `https://${url.hostname.replace(/^(?:www|mcp)\./, "")}`;
}
