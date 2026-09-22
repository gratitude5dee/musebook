// packages/kernel/src/headers.ts — plan.md §6.6, verbatim.
import type { AccessDecision, Representation, Resource } from "@musebook/schema";
import { spdxUrl } from "./render/jsonld";

/**
 * The ETag is PER REPRESENTATION: W/"sha256-<first 16 hex of content_hash>-<as>",
 * e.g. W/"sha256-3f1a9c0b7e2d4a6f-markdown". The hash part is the content identity
 * (spine invariant 1); the suffix is what stops a cache or a client treating the
 * .md and .json twins of one post as the same entity.
 */
export function etagFor(resource: Resource, as: Representation): string {
  return `W/"sha256-${resource.contentHash.slice(0, 16)}-${as}"`;
}

export function linkHeaderFor(resource: Resource, origin: string): string {
  const base = `${origin}/p/${resource.slug}`;
  const license = resource.licenseUrl ?? spdxUrl(resource.licenseSpdx);
  return [
    `<${resource.canonicalUrl ?? base}>; rel="canonical"`,
    `<${base}.md>; rel="alternate"; type="text/markdown"`,
    `<${base}.json>; rel="alternate"; type="application/json"`,
    `<${base}.jsonld>; rel="alternate"; type="application/ld+json"`,
    ...(license !== null ? [`<${license}>; rel="license"`] : []),
    `<${origin}/llms.txt>; rel="describedby"; type="text/plain"`,
  ].join(", ");
}

/**
 * Reads the license COLUMNS (§4.4: train_ai, ai_use, search_indexable), never the
 * mode. `publish_mode` says who pays; the license says what a payer may do after.
 * `train_ai = false` with `x402_always` is a legitimate "pay to read, not to train".
 */
export function usageHeadersFor(resource: Resource): Record<string, string> {
  // AI preference signalling. The `Content-Usage` field is from the IETF AIPREF
  // work and is NOT a ratified RFC as of 2026-09-21. Emitted as a hint only;
  // nothing in the kernel branches on it. The three token names are fixed here
  // and nowhere else: `ai-use`, `train-ai`, `search`.
  const yn = (b: boolean): "y" | "n" => (b ? "y" : "n");
  return {
    "Content-Usage": `ai-use=${yn(resource.aiUse)}, train-ai=${yn(resource.trainAi)}, search=${yn(resource.searchIndexable)}`,
    "X-Musebook-License": resource.licenseSpdx,
  };
}

export function headersFor(
  resource: Resource,
  decision: AccessDecision,
  as: Representation,
  origin: string,
): Record<string, string> {
  const h: Record<string, string> = {
    "Cache-Control": decision.cache.cacheControl,
    Link: linkHeaderFor(resource, origin),
    "X-Musebook-Content-Hash": resource.contentHash,
    ...usageHeadersFor(resource),
  };
  if (decision.cache.vary.length > 0) h.Vary = decision.cache.vary.join(", ");
  if (decision.allow) h.ETag = etagFor(resource, as);
  if (as === "html") {
    h["X-Robots-Tag"] = resource.searchIndexable
      ? "index, follow, max-snippet:-1, max-image-preview:large"
      : "noindex, nofollow";
  }
  return h;
}
