// packages/schema/src/kernel.ts
import { z } from "zod";
// THE ONE Actor (§5.6). actor.ts imports paymentPayloadSchema from this file, so the
// two modules form an ESM cycle. It is safe because this file uses actorSchema only
// in type positions and re-exports — never at module-evaluation time. Keep it that way.

export const representationSchema = z.enum(["html", "markdown", "json", "jsonld", "mcp", "feed"]);
export type Representation = z.infer<typeof representationSchema>;

const evmAddress = z.string().regex(/^0x[0-9a-f]{40}$/, "lowercased EVM address");
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, "sha256 hex");
const caip2 = z.string().regex(/^[a-z0-9-]{3,8}:[a-zA-Z0-9_-]{1,32}$/, "CAIP-2 network id");
const atomic = z.string().regex(/^[0-9]{1,78}$/, "atomic units as a decimal string");

// ─── x402 v2 wire objects (spec: specs/x402-specification-v2.md §5) ──────────

export const paymentRequirementsSchema = z.object({
  scheme: z.string(), // 'exact'
  network: caip2, // 'eip155:8453'
  amount: atomic, // v2's rename of the v1 amount field
  asset: z.string(), // ERC-20 contract address, always
  payTo: z.string(),
  maxTimeoutSeconds: z.number().int().positive(),
  extra: z.record(z.string(), z.unknown()).optional(),
});
export type PaymentRequirements = z.infer<typeof paymentRequirementsSchema>;

export const resourceInfoSchema = z.object({
  url: z.string(),
  description: z.string().optional(),
  mimeType: z.string().optional(),
  serviceName: z.string().max(32).optional(),
  tags: z.array(z.string().max(32)).max(5).optional(),
  iconUrl: z.string().max(2048).optional(),
});

export const paymentRequiredSchema = z.object({
  x402Version: z.literal(2),
  error: z.string().optional(),
  resource: resourceInfoSchema,
  accepts: z.array(paymentRequirementsSchema).min(1),
  extensions: z.record(z.string(), z.unknown()).optional(),
});
export type PaymentRequired = z.infer<typeof paymentRequiredSchema>;

export const exactEvmPayloadSchema = z.object({
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
  authorization: z.object({
    from: z.string(),
    to: z.string(),
    value: atomic,
    validAfter: z.string(),
    validBefore: z.string(),
    nonce: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  }),
});

export const paymentPayloadSchema = z.object({
  x402Version: z.literal(2),
  resource: resourceInfoSchema.optional(),
  accepted: paymentRequirementsSchema,
  payload: exactEvmPayloadSchema,
  extensions: z.record(z.string(), z.unknown()).optional(),
});
export type PaymentPayload = z.infer<typeof paymentPayloadSchema>;

export const settleResponseSchema = z.object({
  success: z.boolean(),
  errorReason: z.string().optional(),
  payer: z.string().optional(),
  transaction: z.string(), // '' when nothing was broadcast
  network: caip2,
  amount: atomic.optional(),
  extensions: z.record(z.string(), z.unknown()).optional(),
});
export type SettleResponse = z.infer<typeof settleResponseSchema>;

export const verifyResponseSchema = z.object({
  isValid: z.boolean(),
  invalidReason: z.string().optional(),
  payer: z.string().optional(),
  extensions: z.record(z.string(), z.unknown()).optional(),
  extra: z.record(z.string(), z.unknown()).optional(),
});
export type VerifyResponse = z.infer<typeof verifyResponseSchema>;

// ─── Actor ───────────────────────────────────────────────────────────────────
// Declared in ./actor (§5.6) and imported above. Nothing here.

// ─── Resource ────────────────────────────────────────────────────────────────

export const postKindSchema = z.enum([
  "note",
  "article",
  "image",
  "video",
  "audio",
  "app",
  "model3d",
  "thread",
]); // == §4.2 post_kind, the one kind vocabulary
export type PostKind = z.infer<typeof postKindSchema>;

export const publishModeSchema = z.enum(["free", "human_free_agent_paid", "x402_always"]);
export type PublishMode = z.infer<typeof publishModeSchema>;

export const licenseSpdxSchema = z.enum([
  "CC0-1.0",
  "CC-BY-4.0",
  "CC-BY-SA-4.0",
  "CC-BY-NC-4.0",
  "CC-BY-ND-4.0",
  "ARR",
  "MIT",
  "Apache-2.0",
]); // == §4.4 posts_license_spdx_allowed == §11.11 manifest
export type LicenseSpdx = z.infer<typeof licenseSpdxSchema>;

export const resourceSchema = z.object({
  postId: z.uuid(),
  authorUserId: z.uuid(),
  authorDisplayName: z.string(),
  authorHandle: z.string(),
  authorWallet: evmAddress.nullable(),
  kind: postKindSchema,
  status: z.enum(["draft", "pending_approval", "scheduled", "published", "unlisted", "removed"]),
  publishMode: publishModeSchema,
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,79}$/), // == §4.4 posts_slug_shape; GLOBALLY unique
  title: z.string().nullable(),
  summary: z.string().nullable(),
  canonicalUrl: z.string().nullable(),
  languageCode: z.string(),
  tags: z.array(z.string()),
  contentHash: sha256Hex,
  canonicalMarkdown: z.string(),
  priceAtomic: atomic, // numeric(78,0) — a string, never a JS number
  /**
   * Derived projection, computed ONCE in loadResource() by formatPriceUsd():
   * priceAtomic ÷ 10^decimals, formatted to 2 decimal places, e.g. "0.25".
   * Null when priceAtomic is "0". A decimal USD STRING end to end (§14.4.5) — the
   * badge (§14.1 toAccessBadge) and the llms.txt formatter (§6.3 pricingLineFor)
   * both read this field and never re-derive it.
   */
  priceUsd: z
    .string()
    .regex(/^[0-9]+\.[0-9]{2}$/)
    .nullable(),
  priceAsset: z.string().nullable(),
  priceNetwork: caip2.nullable(),
  revenueShareVersion: z.string(),
  // License is first-class on posts (§4.4) and is never derived from publishMode.
  licenseSpdx: licenseSpdxSchema,
  licenseUrl: z.string().nullable(),
  trainAi: z.boolean(),
  aiUse: z.boolean(),
  searchIndexable: z.boolean(),
  attributionRequired: z.boolean(),
  citationTemplate: z.string().nullable(),
  publishedAt: z.string().nullable(),
  updatedAt: z.string(),
});
export type Resource = z.infer<typeof resourceSchema>;

// ─── AccessDecision ──────────────────────────────────────────────────────────

export type AllowReason =
  | "mode_free" // publish_mode = 'free'
  | "owner" // the author, or an agent delegated by the author
  | "human_plane" // human_free_agent_paid served to a non-agent
  | "grant_held" // a live access_grants row for (payer, content_hash)
  | "settled_now" // this request settled successfully
  | "idempotent_replay"; // same (network,asset,payer,nonce), already settled, inside the window

export type DenyReason =
  | "not_published"
  | "blocked_agent"
  | "payment_required"
  | "payment_invalid"
  | "quote_expired"
  | "quote_mismatch"
  | "replay_in_flight"
  | "authorization_consumed"
  | "facilitator_unavailable"
  | "kernel_error";

export interface CachePolicy {
  readonly cacheControl: string;
  readonly vary: readonly string[];
  readonly shared: boolean;
}

export type AccessDecision =
  | {
      readonly allow: true;
      readonly reason: AllowReason;
      readonly bodyKind: "full";
      readonly grantId: string | null;
      readonly settlementId: string | null;
      readonly settlement: SettleResponse | null; // echoed in PAYMENT-RESPONSE
      readonly cache: CachePolicy;
    }
  | {
      readonly allow: false;
      readonly reason: DenyReason;
      readonly bodyKind: "preview" | "empty";
      readonly httpStatus: 402 | 403 | 404 | 409 | 503;
      readonly challenge: PaymentRequired | null;
      readonly cache: CachePolicy;
    };

// ─── Rendered ────────────────────────────────────────────────────────────────

export interface Rendered {
  readonly status: number;
  readonly mediaType: string;
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly etag: string | null; // etagFor(resource, as) — per representation, §6.6
  readonly bodyKind: "full" | "preview" | "empty";
  /**
   * The parsed object `body` serialises, for representations whose body is JSON.
   * Populated by render/json.ts (the `.json` twin envelope) and render/mcp.ts (the
   * tool result's `structuredContent`); `null` for html and markdown. render/jsonld.ts
   * and render/feed.ts also populate it, since they are JSON documents too. `body`
   * and `structured` are two projections of one value and MUST agree — §7.4 asserts it.
   */
  readonly structured: unknown; // `| null` is redundant — `unknown` already includes null
  /** Only populated for `as === 'mcp'`: the tool result's `_meta` object. */
  readonly mcpMeta: Readonly<Record<string, unknown>> | null;
}

// ─── AccessBadgeView (§14.1) ─────────────────────────────────────────────────
// The ONE definition of both types; the kernel re-exports them, nothing redeclares.

/** What the UI is allowed to know about access. Deliberately not the enum. */
export type AccessBadgeKind = "open" | "toll" | "gated";

export interface AccessBadgeView {
  kind: AccessBadgeKind;
  /** Decimal USD string, e.g. "0.25". Present for 'toll' and 'gated', absent for 'open'. */
  priceUsd?: string;
  /** Human-readable one-liner used as the badge's aria-label and tooltip. */
  rule: string;
}
