// packages/kernel/src/render/index.ts — the dispatch behind renderResourceWith (§6.6).
// `renderResource` takes the decision, so there is no code path that produces bytes
// without an access answer. A denied decision still renders — the teaser plus the
// challenge — which is why there is one function and not a `render` and `renderGated`.
import type { AccessDecision, Rendered, Representation, Resource } from "@musebook/schema";
import type { KernelPorts } from "../ports.js";
import { etagFor, headersFor } from "../headers.js";
import { renderHtml } from "./html.js";
import { renderMarkdown } from "./markdown.js";
import { renderJson } from "./json.js";
import { jsonLdFor } from "./jsonld.js";
import { renderMcp } from "./mcp.js";
import { renderFeed } from "./feed.js";

const MEDIA_TYPES: Record<Representation, string> = {
  html: "text/html; charset=utf-8",
  markdown: "text/markdown; charset=utf-8",
  json: "application/json; charset=utf-8",
  jsonld: "application/ld+json",
  mcp: "application/json",
  feed: "application/feed+json",
};

/**
 * Serialises `structured` into `body` with a stable key order so the two
 * projections of one value agree byte-for-byte (§6.2): the .snap driver and the
 * §7.4 assertion both read `rendered.body` as `JSON.parse`.
 */
export function stableSerialize(value: unknown): string {
  return JSON.stringify(sortKeys(value), null, 2);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

// Async because the Kernel interface signature is Promise<Rendered>; the body is
// synchronous — every port read already happened in resolveAccess.
// eslint-disable-next-line @typescript-eslint/require-await
export async function renderResourceWith(
  ports: KernelPorts,
  resource: Resource,
  as: Representation,
  decision: AccessDecision,
): Promise<Rendered> {
  const origin = ports.policy.siteOrigin();
  const previewChars = ports.policy.previewChars(resource);
  const status = decision.allow ? 200 : decision.httpStatus;
  const headers = headersFor(resource, decision, as, origin);
  const bodyKind = decision.bodyKind;

  switch (as) {
    case "html":
      return {
        status,
        mediaType: MEDIA_TYPES.html,
        body: renderHtml(resource, decision, origin, previewChars),
        headers,
        etag: decision.allow ? etagFor(resource, "html") : null,
        bodyKind,
        structured: null,
        mcpMeta: null,
      };

    case "markdown":
      return {
        status,
        mediaType: MEDIA_TYPES.markdown,
        body: renderMarkdown(resource, decision, origin, previewChars),
        headers,
        etag: decision.allow ? etagFor(resource, "markdown") : null,
        bodyKind,
        structured: null,
        mcpMeta: null,
      };

    case "json": {
      const envelope = renderJson(resource, decision, origin, previewChars);
      return {
        status,
        mediaType: MEDIA_TYPES.json,
        body: stableSerialize(envelope),
        headers,
        etag: decision.allow ? etagFor(resource, "json") : null,
        bodyKind,
        structured: envelope,
        mcpMeta: null,
      };
    }

    case "jsonld": {
      const doc =
        bodyKind === "empty" ? { error: "not_available" } : jsonLdFor(resource, decision, origin);
      return {
        status,
        mediaType: MEDIA_TYPES.jsonld,
        body: stableSerialize(doc),
        headers,
        etag: decision.allow ? etagFor(resource, "jsonld") : null,
        bodyKind,
        structured: doc,
        mcpMeta: null,
      };
    }

    case "mcp": {
      const { result, meta } = renderMcp(resource, decision, origin, previewChars);
      return {
        status,
        mediaType: MEDIA_TYPES.mcp,
        body: stableSerialize(result),
        headers,
        etag: decision.allow ? etagFor(resource, "mcp") : null,
        bodyKind,
        structured: result,
        mcpMeta: meta,
      };
    }

    case "feed": {
      // `feed` never carries a body in any mode — it ignores decision.bodyKind
      // entirely (§6.6). The feed assembler omits denied items itself.
      const item = renderFeed(resource, origin);
      return {
        status,
        mediaType: MEDIA_TYPES.feed,
        body: stableSerialize(item),
        headers,
        etag: decision.allow ? etagFor(resource, "feed") : null,
        bodyKind,
        structured: item,
        mcpMeta: null,
      };
    }
  }
}
