// apps/web/lib/db/posts.ts — loadPostView (§7.12/§14.4.2). The ONLY read path
// the post page has: PostgREST for the non-gated metadata the kernel envelope
// does not carry (og_image_url), plus the Worker's JSON twin for body +
// access. apps/web has no Postgres credential — this file is as deep as it gets.
import "server-only";
import type { PostView } from "@musebook/schema";
import { serviceDb } from "./service";
import { fetchJsonTwin } from "../edge/twin";

interface PostRow {
  post_id: string;
  author_user_id: string;
  author_display_name: string;
  author_handle: string;
  kind: PostView["kind"];
  status: string;
  slug: string;
  title: string | null;
  summary: string | null;
  canonical_url: string | null;
  language_code: string;
  tags: string[];
  content_hash: string;
  price_atomic: string;
  price_asset: string | null;
  price_network: string | null;
  revenue_share_version: string;
  license_spdx: PostView["licenseSpdx"];
  license_url: string | null;
  train_ai: boolean;
  ai_use: boolean;
  attribution_required: boolean;
  citation_template: string | null;
  og_image_url: string | null;
  published_at: string | null;
  updated_at: string;
}

/** Loads the UI projection for `/p/{slug}`. Two reads, one projection:
 *  1. `posts` over PostgREST — the non-gated metadata (§5.4's allowed seam).
 *  2. `/p/{slug}.json` on the Worker — body, preview, access badge, license
 *     columns, JSON-LD. A post the twin cannot serve (removed, gated on the
 *     agent plane) never reaches this function in production, because the
 *     Worker short-circuits before the origin fetch; locally it returns null.
 */
export async function loadPostView(slug: string): Promise<PostView | null> {
  const [{ data: row }, twin] = await Promise.all([
    serviceDb
      .from("posts")
      .select(
        "post_id, author_user_id, author_display_name, author_handle, kind, status, slug, title, summary, canonical_url, language_code, tags, content_hash, price_atomic, price_asset, price_network, revenue_share_version, license_spdx, license_url, train_ai, ai_use, search_indexable, attribution_required, citation_template, og_image_url, published_at, updated_at",
      )
      .eq("slug", slug)
      .eq("status", "published")
      .maybeSingle()
      .returns<PostRow>(),
    fetchJsonTwin(slug).catch(() => null),
  ]);
  if (row === null || row === undefined || twin === null) return null;

  return {
    postId: row.post_id,
    slug: row.slug,
    kind: row.kind,
    title: row.title,
    summary: row.summary,
    authorUserId: row.author_user_id,
    authorHandle: row.author_handle,
    authorDisplayName: row.author_display_name,
    languageCode: row.language_code,
    tags: row.tags,
    contentHash: row.content_hash,
    canonicalUrl: row.canonical_url,
    ogImageUrl: row.og_image_url,
    publishedAt: row.published_at,
    updatedAt: row.updated_at,
    body: twin.body,
    preview: twin.preview,
    accessBadge: twin.accessBadge,
    licenseSpdx: row.license_spdx,
    licenseUrl: row.license_url,
    trainAi: row.train_ai,
    aiUse: row.ai_use,
    attributionRequired: row.attribution_required,
    citationTemplate: row.citation_template,
    priceAtomic: row.price_atomic,
    priceAsset: row.price_asset,
    priceNetwork: row.price_network,
    priceUsd: twin.payment.priceUsd ?? null,
    jsonld: twin.jsonld,
  };
}
