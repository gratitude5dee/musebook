// packages/kernel/test/fixtures/resources.ts — the three fixture resources (§6.13).
// Rows are the single source of truth; Resources derive through loadResource(),
// which is the same snake_case -> camelCase path production takes.
import { contentHash } from "@musebook/content";
import type { Resource } from "@musebook/schema";
import { loadResource, type ResourceRow } from "../../src/load.js";

/** A unique string placed only in the tail of every fixture resource's body. */
export const SECRET_MARKER = "MUSEBOOK_PAID_BODY_MARKER_7f3a";

const AUTHOR = {
  post_id: "00000000-0000-4000-8000-000000000001",
  author_user_id: "00000000-0000-4000-8000-00000000d00d",
  author_display_name: "Author One",
  author_handle: "author-one",
  author_wallet: "0x769900f8faad0000000000000000000000000001",
  language_code: "en",
  tags: ["musebook", "x402"],
  canonical_url: null,
  license_url: null,
  revenue_share_version: "rsv-1",
  attribution_required: true,
  citation_template: "cite: {slug}",
  published_at: "2026-09-22T12:00:00Z",
  updated_at: "2026-09-22T12:00:00Z",
};

function row(
  over: Partial<ResourceRow> & Pick<ResourceRow, "slug" | "canonical_markdown">,
): ResourceRow {
  return {
    ...AUTHOR,
    kind: "article",
    status: "published",
    publish_mode: "free",
    title: null,
    summary: null,
    content_hash: contentHash(over.canonical_markdown),
    price_atomic: "0",
    price_asset: null,
    price_network: null,
    license_spdx: "CC-BY-4.0",
    train_ai: true,
    ai_use: true,
    search_indexable: true,
    ...over,
  };
}

const FREE_BODY = [
  "# The Free Article",
  "Free for everyone — humans and agents alike. No quote, no signature, no 402.",
  "A second block of padding so the paid tail sits well past the preview boundary. " +
    "This paragraph exists only to push the marker beyond four hundred characters, " +
    "the deterministic teaser's cutoff used by every stub port in this suite.",
  `The tail of the body, which a denied render must never emit: ${SECRET_MARKER}`,
].join("\n\n");

const HFAP_BODY = [
  "# The Human-Free Agent-Paid Article",
  "Humans read this at 200. Agents get a 402 with a preview.",
  "A second block of padding so the paid tail sits well past the preview boundary. " +
    "This paragraph exists only to push the marker beyond four hundred characters, " +
    "the deterministic teaser's cutoff used by every stub port in this suite.",
  `The tail of the body, which a denied render must never emit: ${SECRET_MARKER}`,
].join("\n\n");

const GATED_BODY = [
  "# The Always-Paid Article",
  "Every read is paid — human or agent. The teaser is all you get for free.",
  "A second block of padding so the paid tail sits well past the preview boundary. " +
    "This paragraph exists only to push the marker beyond four hundred characters, " +
    "the deterministic teaser's cutoff used by every stub port in this suite.",
  `The tail of the body, which a denied render must never emit: ${SECRET_MARKER}`,
].join("\n\n");

export const FREE_ROW: ResourceRow = row({
  post_id: "00000000-0000-4000-8000-000000000001",
  slug: "the-free-article",
  canonical_markdown: FREE_BODY,
  title: "The Free Article",
  summary: "Free for everyone.",
});

export const HFAP_ROW: ResourceRow = row({
  post_id: "00000000-0000-4000-8000-000000000002",
  slug: "the-hfap-article",
  canonical_markdown: HFAP_BODY,
  title: "The Human-Free Agent-Paid Article",
  summary: "Free for humans; agents pay once per content_hash.",
  publish_mode: "human_free_agent_paid",
  price_atomic: "2000",
  price_asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  price_network: "eip155:8453",
});

export const GATED_ROW: ResourceRow = row({
  post_id: "00000000-0000-4000-8000-000000000003",
  slug: "the-gated-article",
  canonical_markdown: GATED_BODY,
  title: "The Always-Paid Article",
  summary: "Every read is paid.",
  publish_mode: "x402_always",
  price_atomic: "250000",
  price_asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  price_network: "eip155:8453",
  train_ai: false,
});

export const ROWS: readonly ResourceRow[] = [FREE_ROW, HFAP_ROW, GATED_ROW];

export const FREE: Resource = loadResource(FREE_ROW);
export const HFAP: Resource = loadResource(HFAP_ROW);
export const GATED: Resource = loadResource(GATED_ROW);
