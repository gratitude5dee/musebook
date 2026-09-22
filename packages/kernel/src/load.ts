// packages/kernel/src/load.ts — plan.md §6.5, verbatim.
import { resourceSchema, type Resource } from "@musebook/schema";
import { formatPriceUsd } from "./price";

/** v1 settles USDC only (§6.9); when a second asset lands, decimals come from the row. */
const USDC_DECIMALS = 6;

export interface ResourceRow {
  post_id: string;
  author_user_id: string;
  author_display_name: string;
  author_handle: string;
  author_wallet: string | null;
  kind: string;
  status: string;
  publish_mode: string;
  slug: string;
  title: string | null;
  summary: string | null;
  canonical_url: string | null;
  language_code: string;
  tags: string[];
  content_hash: string;
  canonical_markdown: string;
  price_atomic: string;
  price_asset: string | null;
  price_network: string | null;
  revenue_share_version: string;
  license_spdx: string;
  license_url: string | null;
  train_ai: boolean;
  ai_use: boolean;
  search_indexable: boolean;
  attribution_required: boolean;
  citation_template: string | null;
  published_at: string | null;
  updated_at: string;
}

/** The single snake_case -> camelCase boundary for publish_mode in the whole repo. */
export function loadResource(row: ResourceRow): Resource {
  return resourceSchema.parse({
    postId: row.post_id,
    authorUserId: row.author_user_id,
    authorDisplayName: row.author_display_name,
    authorHandle: row.author_handle,
    authorWallet: row.author_wallet,
    kind: row.kind,
    status: row.status,
    publishMode: row.publish_mode,
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    canonicalUrl: row.canonical_url,
    languageCode: row.language_code,
    tags: row.tags,
    contentHash: row.content_hash,
    canonicalMarkdown: row.canonical_markdown,
    priceAtomic: row.price_atomic,
    priceUsd: row.price_atomic === "0" ? null : formatPriceUsd(row.price_atomic, USDC_DECIMALS),
    priceAsset: row.price_asset,
    priceNetwork: row.price_network,
    revenueShareVersion: row.revenue_share_version,
    licenseSpdx: row.license_spdx,
    licenseUrl: row.license_url,
    trainAi: row.train_ai,
    aiUse: row.ai_use,
    searchIndexable: row.search_indexable,
    attributionRequired: row.attribution_required,
    citationTemplate: row.citation_template,
    publishedAt: row.published_at,
    updatedAt: row.updated_at,
  });
}
