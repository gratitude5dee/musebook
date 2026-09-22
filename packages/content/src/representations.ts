// packages/content/src/representations.ts — the six §6.6 representations.
//
// These are the package's only transforms — the ungated full-body (and
// preview-body) conversions behind `representations` in `posts.*_r2_key`.
// They never read publish_mode and never decide free vs paid: preview
// handling is explicit in `BodyKind` (§4.4's `preview_key` shape) — the
// caller selects full/preview/empty, and anything decision-dependent in the
// output (`isAccessibleForFree`, `hasPart`, ETag, usage headers, the paywall
// span injected into preview HTML) belongs to the kernel's render files
// (§6.6, M5) and stays a no-publish-mode-elsewhere lint clean zone.
import { canonicalMarkdown } from "./canonicalize";
import { frontMatter } from "./frontmatter";
import { jsonLdBase } from "./jsonld";
import { markdownToHtml } from "./markdown-html";
import type { Representation, Resource } from "@musebook/schema";

/**
 * `full` is the paid/ungated body; `preview` is the free view (the schema
 * callers keep separate `*_preview_key` objects — §4.4); `empty` is the
 * 402-payment-required body where a representation exists at all.
 */
export type BodyKind = "full" | "preview" | "empty";

export const CONTENT_TYPES: Record<Representation, string> = {
  html: "text/html; charset=utf-8",
  markdown: "text/markdown; charset=utf-8",
  json: "application/json; charset=utf-8",
  jsonld: "application/ld+json",
  mcp: "application/json",
  feed: "application/feed+json",
};

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** US display price from the stored `price_atomic` + `price_usd` — the
 * composer header shows "Pay $4.20" from the same fields (§14.4.1). */
function displayPrice(resource: Resource): string {
  const usd = resource.priceUsd;
  if (usd === null || usd.trim() === "") {
    return resource.priceAsset === null
      ? resource.priceAtomic
      : `${resource.priceAtomic} ${resource.priceAsset}`;
  }
  return `$${usd}`;
}

function htmlFor(resource: Resource, bodyKind: BodyKind, origin: string): string {
  const jsonld = JSON.stringify(jsonLdBase(resource, origin));
  const head = `<!doctype html><html lang="${escapeHtml(resource.languageCode)}"><head><meta charset="utf-8"><title>${escapeHtml(
    resource.title ?? resource.slug,
  )}</title><script type="application/ld+json">${jsonld}</script></head><body>`;
  if (bodyKind === "empty") {
    return `${head}<main><p>Payment required.</p></main></body></html>`;
  }
  const article = markdownToHtml(resource.canonicalMarkdown);
  const paywall =
    bodyKind === "preview"
      ? `<div class="musebook-paywall"><p>This content is gated for agents: pay ${escapeHtml(
          displayPrice(resource),
        )} to continue reading.</p></div>`
      : "";
  return `${head}<article>${article}</article>${paywall}</body></html>`;
}

function markdownFor(resource: Resource, bodyKind: BodyKind): string {
  if (bodyKind === "empty") return "";
  const head = frontMatter(resource);
  const body = canonicalMarkdown(resource.canonicalMarkdown);
  const tail =
    bodyKind === "preview" ? `\n<!-- musebook:paywall price="${displayPrice(resource)}" -->\n` : "";
  return `${head}\n${body}${tail}`;
}

function jsonFor(resource: Resource, bodyKind: BodyKind): string {
  if (bodyKind === "empty") {
    return JSON.stringify({ error: "payment_required" });
  }
  const envelope: Record<string, unknown> = {
    schema: "musebook-post-v1",
    post_id: resource.postId,
    slug: resource.slug,
    kind: resource.kind,
    title: resource.title,
    summary: resource.summary,
    language_code: resource.languageCode,
    content_hash: resource.contentHash,
    body: bodyKind === "preview" ? null : canonicalMarkdown(resource.canonicalMarkdown),
    license: resource.licenseSpdx,
    license_url: resource.licenseUrl,
    train_ai: resource.trainAi,
    ai_use: resource.aiUse,
    attribution_required: resource.attributionRequired,
    published_at: resource.publishedAt,
    updated_at: resource.updatedAt,
  };
  if (bodyKind === "preview") {
    envelope["preview"] = true;
    envelope["payment"] = {
      required: true,
      price_atomic: resource.priceAtomic,
      price_asset: resource.priceAsset,
      price_usd: resource.priceUsd,
      price_network: resource.priceNetwork,
    };
  }
  return JSON.stringify(envelope);
}

function mcpFor(resource: Resource, bodyKind: BodyKind): string {
  if (bodyKind === "empty") {
    return JSON.stringify({ isError: true, content: [] });
  }
  const meta = {
    post_id: resource.postId,
    slug: resource.slug,
    content_hash: resource.contentHash,
    attribution_required: resource.attributionRequired,
    train_ai: resource.trainAi,
    ai_use: resource.aiUse,
  };
  if (bodyKind === "preview") {
    return JSON.stringify({
      isError: true,
      content: [
        {
          type: "text",
          text: `Payment required to read this post in full: ${displayPrice(resource)} (${resource.priceAsset} on ${resource.priceNetwork}).`,
        },
      ],
      structuredContent: { ...meta, payment_required: true },
    });
  }
  return JSON.stringify({
    content: [{ type: "text", text: canonicalMarkdown(resource.canonicalMarkdown) }],
    structuredContent: meta,
  });
}

/**
 * `feed` is resource metadata plus the post link only (§6.6, MODE-FIXED-2:
 * "feed never carries a body in any mode"), which is what makes it the safe
 * listing rep — `bodyKind` is accepted for a uniform producer signature and
 * ignored.
 */
function feedFor(resource: Resource, origin: string): string {
  return JSON.stringify({
    id: `${origin}/p/${resource.slug}`,
    post_id: resource.postId,
    slug: resource.slug,
    kind: resource.kind,
    title: resource.title,
    summary: resource.summary,
    url: resource.canonicalUrl,
    author: { handle: resource.authorHandle, name: resource.authorDisplayName },
    language_code: resource.languageCode,
    content_hash: resource.contentHash,
    license: resource.licenseSpdx,
    license_url: resource.licenseUrl,
    attribution_required: resource.attributionRequired,
    published_at: resource.publishedAt,
    updated_at: resource.updatedAt,
  });
}

/**
 * Produces one representation body. For `jsonld` the caller merges decision
 * fields (`isAccessibleForFree`, `hasPart`) onto the returned document — the
 * kernel does this after `resolveAccess`; the pure producer is mode-neutral.
 */
export function produce(
  resource: Resource,
  as: Representation,
  bodyKind: BodyKind,
  origin: string,
): { body: string; contentType: string } {
  const body = ((): string => {
    switch (as) {
      case "html":
        return htmlFor(resource, bodyKind, origin);
      case "markdown":
        return markdownFor(resource, bodyKind);
      case "json":
        return jsonFor(resource, bodyKind);
      case "jsonld":
        return JSON.stringify(jsonLdBase(resource, origin));
      case "mcp":
        return mcpFor(resource, bodyKind);
      case "feed":
        return feedFor(resource, origin);
    }
  })();
  return { body, contentType: CONTENT_TYPES[as] };
}
