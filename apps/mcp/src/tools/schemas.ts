// apps/mcp/src/tools/schemas.ts — §7.4.1's input schemas, one file so the
// acceptance test can iterate them. zod 4 idioms: z.uuid(), z.iso.datetime().
import { z } from "zod";
import { postKindSchema } from "@musebook/schema";

export const searchPostsInput = z.object({
  query: z
    .string()
    .min(1)
    .max(512)
    .describe("Natural-language or keyword query. Matched against title, summary and body."),
  author: z.string().max(64).optional().describe("Author handle without the leading '@'."),
  kind: postKindSchema.optional(),
  tags: z.array(z.string().max(48)).max(10).optional(),
  access: z
    .enum(["open", "toll", "gated", "any"])
    .default("any")
    .describe(
      "Filter by how this post is priced for agents: open (free), toll (free for humans, paid for agents), gated (paid on every fetch).",
    ),
  published_after: z.iso.datetime().optional(),
  limit: z.number().int().min(1).max(50).default(20),
  cursor: z
    .string()
    .max(512)
    .optional()
    .describe("Opaque cursor from a previous result. There are no sessions; carry it yourself."),
});

export const getPostInput = z
  .object({
    slug: z
      .string()
      .max(80)
      .optional()
      .describe("Post slug, e.g. 'how-mog-became-musebook'. Provide this or post_id."),
    post_id: z.uuid().optional(),
    format: z
      .enum(["markdown", "text", "json"])
      .default("markdown")
      .describe("markdown is the canonical agent representation."),
    include: z
      .array(z.enum(["body", "transcript", "assets", "comments", "license"]))
      .default(["body", "license"]),
    grant_id: z
      .uuid()
      .optional()
      .describe(
        "Access grant from a prior purchase. Omit on the first call; a paid post will tell you what to do.",
      ),
    if_none_match: z
      .string()
      .length(64)
      .optional()
      .describe(
        "A content_hash from a prior call. If unchanged, the result says not_modified and costs nothing.",
      ),
  })
  .refine((v) => Boolean(v.slug) || Boolean(v.post_id), {
    message: "Provide either slug or post_id.",
  });

export const getFeedInput = z.object({
  surface: z.enum(["home", "topic", "author"]).default("home"),
  topic: z.string().max(64).optional().describe("Required when surface = 'topic'."),
  author: z.string().max(64).optional().describe("Required when surface = 'author'."),
  limit: z.number().int().min(1).max(50).default(20),
  cursor: z
    .string()
    .max(512)
    .optional()
    .describe("Slate cursor. Page 2 reads the cached slate; it does not re-rank."),
});

export const listAuthorsInput = z.object({
  query: z.string().max(128).optional().describe("Substring match on handle or display name."),
  sort: z.enum(["recent", "followers", "posts"]).default("recent"),
  accepts_agent_payment: z
    .boolean()
    .optional()
    .describe("Only authors who have at least one post priced for agents."),
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.string().max(512).optional(),
});

export const getArtifactInput = z
  .object({
    artifact_id: z.uuid().optional(),
    post_slug: z.string().max(80).optional(),
    include_source: z
      .boolean()
      .default(false)
      .describe(
        "Source bundles may be priced separately; false returns metadata and the run URL only.",
      ),
    grant_id: z.uuid().optional(),
  })
  .refine((v) => Boolean(v.artifact_id) || Boolean(v.post_slug), {
    message: "Provide either artifact_id or post_slug.",
  });

export const downloadAssetInput = z.object({
  asset_id: z.uuid(),
  grant_id: z
    .uuid()
    .optional()
    .describe(
      "A grant from a prior purchase of the parent post. Required for a paid asset unless you pay on the fetch itself.",
    ),
  ttl_seconds: z
    .number()
    .int()
    .min(60)
    .max(3600)
    .default(900)
    .describe(
      "How long you intend to cache the returned link. The link is NOT a signed bearer token: entitlement is re-checked on every byte served.",
    ),
});

export const getPricingInput = z.object({
  post_slug: z.string().max(80).optional(),
  post_id: z.uuid().optional(),
  author: z
    .string()
    .max(64)
    .optional()
    .describe("Omit the post fields and pass an author to get that author's default terms."),
});

export const purchaseAccessInput = z
  .object({
    post_id: z.uuid().optional(),
    post_slug: z.string().max(80).optional(),
    asset_id: z.uuid().optional().describe("Buy one asset rather than the post body."),
    max_amount_atomic: z
      .string()
      .regex(/^[0-9]{1,30}$/)
      .optional()
      .describe("Refuse if the quote exceeds this, in atomic units of the quoted asset."),
    idempotency_key: z
      .string()
      .min(8)
      .max(128)
      .describe("Required. A retry with the same key never charges twice."),
  })
  .refine((v) => Boolean(v.post_id) || Boolean(v.post_slug) || Boolean(v.asset_id), {
    message: "Provide post_id, post_slug or asset_id.",
  });

export const subscribeAuthorInput = z.object({
  author: z.string().max(64).describe("Author handle without '@'."),
  action: z.enum(["follow", "unfollow"]).default("follow"),
  notify: z
    .boolean()
    .default(false)
    .describe("Deliver new posts to the caller's webhook, if one is registered."),
});

export const submitPostInput = z.object({
  kind: postKindSchema,
  title: z.string().max(200).optional().describe("Required when kind = 'article'."),
  summary: z.string().max(500).optional(),
  body_markdown: z
    .string()
    .min(1)
    .max(200_000)
    .describe(
      "CommonMark. It is canonicalized and hashed server-side; the hash you get back is authoritative.",
    ),
  tags: z.array(z.string().max(48)).max(10).default([]),
  language_code: z
    .string()
    .regex(/^[a-z]{2}(-[A-Z]{2})?$/)
    .default("en"),
  asset_ids: z.array(z.uuid()).max(20).default([]),
  publish: z
    .boolean()
    .default(false)
    .describe("false creates a draft (post:write). true attempts to publish and needs post:publish."),
  // Named `access`, never `publish_mode`: the handler maps it with the kernel's
  // accessToPublishMode() (section 6.3), so apps/mcp stays clean under section 3.4's lint rule.
  access: z
    .enum(["open", "toll", "gated"])
    .default("open")
    .describe(
      "open: free for everyone. toll: free for humans, agents pay once per content_hash. gated: paid on every fetch.",
    ),
  price_atomic: z
    .string()
    .regex(/^[0-9]{1,30}$/)
    .optional()
    .describe("Required and > 0 for any access other than open."),
  license_spdx: z
    .enum([
      "CC0-1.0",
      "CC-BY-4.0",
      "CC-BY-SA-4.0",
      "CC-BY-NC-4.0",
      "CC-BY-ND-4.0",
      "ARR",
      "MIT",
      "Apache-2.0",
    ])
    .optional()
    .describe("Omit to inherit the author's creator_publishing_defaults row (section 4.4)."),
  scheduled_for: z.iso.datetime().optional(),
  idempotency_key: z.string().min(8).max(128),
});

export const getAnalyticsInput = z.object({
  scope: z.enum(["post", "author"]).default("author"),
  post_id: z.uuid().optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  granularity: z.enum(["day", "hour"]).default("day"),
  metrics: z
    .array(
      z.enum([
        "impressions",
        "opens",
        "dwell_ms_total",
        "likes",
        "comments",
        "reposts",
        "paid_fetches",
        "paywall_hits",
        "revenue_atomic",
        "distinct_agents",
      ]),
    )
    .max(10)
    .default(["impressions", "opens", "paid_fetches", "revenue_atomic"]),
});
