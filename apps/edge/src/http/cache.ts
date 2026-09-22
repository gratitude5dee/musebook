// apps/edge/src/http/cache.ts — §6.12.5's three-layer header set, verbatim.
// `negotiated` covers twin responses that fork on Accept (§7.11).
import type { AccessDecision } from "@musebook/schema";

export interface CacheSpec {
  shared: boolean;
  sMaxAge?: number | undefined;
  swr?: number | undefined;
  vary?: readonly string[] | undefined;
  negotiated?: boolean | undefined;
}

/** The shape every route emits; applyCacheHeaders derives the three layers. */
export function cacheHeadersFor(spec: CacheSpec): Record<string, string> {
  if (spec.negotiated === true) {
    // Twin content-negotiation: the same URL serves html/markdown/json/jsonld —
    // private to the requester and Vary: * so no shared cache can mix the
    // representations. `Accept` narrows browser caches; `*` covers the rest.
    return {
      "cache-control": "private, no-store",
      vary: "Accept, *",
    };
  }
  if (!spec.shared) {
    return { "cache-control": "private, no-store, must-revalidate", vary: "*" };
  }
  const sMaxAge = spec.sMaxAge ?? 0;
  const swr = spec.swr ?? 0;
  const swrPart = swr > 0 ? `, stale-while-revalidate=${swr}` : "";
  const headers: Record<string, string> = {
    "cache-control": "public, max-age=0, must-revalidate",
    "cloudflare-cdn-cache-control": `public, s-maxage=${sMaxAge}${swrPart}`,
    "vercel-cdn-cache-control": `public, s-maxage=${sMaxAge}, stale-while-revalidate=${swr}`,
    vary: spec.vary?.join(", ") ?? "Accept, Accept-Encoding",
  };
  return headers;
}

/**
 * §6.12.5, verbatim: AccessDecision.cache -> the three-layer header set.
 * Never emit a bare `CDN-Cache-Control` — the platform-neutral name silently
 * wins over the scoped ones on some edges and loses on others.
 */
export function applyCacheHeaders(
  response: Response,
  decision: AccessDecision,
  _env: Env,
  negotiated = false,
): Response {
  const policy = decision.cache;
  const headers = new Headers(response.headers);
  if (negotiated) {
    if (!decision.allow) {
      // A denial on a twin URL is still §6.12.8's deny row: no-store on all
      // three layers and bare `Vary: *`, the one Vary form Cloudflare honours
      // unconditionally.
      headers.set("cache-control", "private, no-store, must-revalidate");
      headers.set("cloudflare-cdn-cache-control", "no-store");
      headers.set("vercel-cdn-cache-control", "no-store");
      headers.set("vary", "*");
      return new Response(response.body, { status: response.status, headers });
    }
    // Content-negotiated twin (§7.10.2): the same URL serves html/markdown —
    // private to the requester, Vary: Accept narrows browser caches and `*`
    // covers the rest.
    headers.set("cache-control", "private, no-store");
    headers.set("vary", "Accept, *");
    return new Response(response.body, { status: response.status, headers });
  }
  if (policy.shared) {
    headers.set("cache-control", "public, max-age=0, must-revalidate");
    headers.set(
      "cloudflare-cdn-cache-control",
      "public, s-maxage=300, stale-while-revalidate=86400",
    );
    headers.set("vercel-cdn-cache-control", "public, s-maxage=31536000, stale-while-revalidate=59");
    headers.set("vary", policy.vary.join(", "));
  } else {
    // PRIVATE_NO_STORE — the grant/vary fork can never enter a shared cache.
    headers.set("cache-control", "private, no-store, must-revalidate");
    headers.set("cloudflare-cdn-cache-control", "no-store");
    headers.set("vercel-cdn-cache-control", "no-store");
    headers.set("vary", "*");
  }
  return new Response(response.body, { status: response.status, headers });
}
