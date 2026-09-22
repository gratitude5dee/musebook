// packages/schema/src/actor.ts
import { z } from "zod";
// paymentPayloadSchema is defined in ./kernel (section 6.2), which in turn imports
// actorSchema from this file. The ESM cycle is safe ONLY because kernel.ts uses
// actorSchema in type positions and inside function bodies, never at module-
// evaluation time. If section 6 ever needs actorSchema at top level, move
// paymentPayloadSchema and its dependencies into packages/schema/src/x402.ts and
// import it from there in both files.
import { paymentPayloadSchema } from "./kernel";

/** How a claim about this principal was established. Ordered most → least reliable. */
export const evidenceKind = z.enum([
  "siwe_session", // mb_session cookie resolved against sessions.token_sha256
  "delegation_token", // mb_dlg_ bearer resolved via app.resolve_delegation()
  "mcp_oauth_token", // access token verified by workers-oauth-provider (§7)
  "web_bot_auth", // RFC 9421 Ed25519 signature verified by web-bot-auth@0.2.0
  "verified_crawler_rdns", // forward-confirmed reverse DNS + published IP range
  "cf_verified_bot", // request.cf.verifiedBot / verifiedBotCategory. Weak.
  "cf_bot_score", // request.cf.score. Weaker. Analytics and tiering only.
  "ua_declared", // the request told us what it is. Evidence, not proof.
  "none",
]);
export type EvidenceKind = z.infer<typeof evidenceKind>;

export const actorEvidence = z.object({
  kind: evidenceKind,
  detail: z.string().max(200).optional(),
  verifiedAt: z.iso.datetime(),
});

const evmAddress = z.string().regex(/^0x[0-9a-f]{40}$/);

/**
 * Fields every member carries. `plane` is deliberately NOT here: it is a literal on
 * each member, and `common` is spread FIRST so a member literal can never be
 * overwritten by a spread. (Spreading `common` after the literal silently widened
 * `plane` back to the enum on every member and allowed
 * `{ class: 'human_creator', plane: 'agent' }` — which writes a human session into
 * `action_events_agent`.)
 */
const common = {
  evidence: z.array(actorEvidence).min(1),
  requestId: z.string().min(1),
  /** Address that may hold or mint an x402 grant. Null ⇒ nothing is purchasable. */
  payerAddress: evmAddress.nullable(),

  // ── The four kernel fields (section 6.2). Present on every member. ──────────
  /**
   * The signed x402 authorization, if the request carried one. It lives on the
   * Actor and not on a third argument because in x402 the signed authorization IS
   * an identity claim: it proves control of `payload.authorization.from`. Keeping
   * it here preserves the spine's two-argument resolveAccess signature exactly.
   */
  payment: paymentPayloadSchema.nullable(),
  /** Where the payment payload was read from: the PAYMENT-SIGNATURE header or
   *  MCP `_meta["x402/payment"]`. Null when `payment` is null. */
  paymentTransport: z.enum(["http", "mcp"]).nullable(),
  /** Declared, never observed (section 6.14). Nothing validates it. */
  declaredIntent: z.enum(["read", "crawl", "train", "unknown"]),
  /** RFC 7638 / RFC 8037 A.3 JWK thumbprint of the Web Bot Auth key that
   *  verified — i.e. web-bot-auth's `keyid` verbatim — else null. */
  directoryKeyid: z.string().nullable(),
};

export const humanReaderActor = z.object({
  ...common,
  class: z.literal("human_reader"),
  plane: z.literal("human"),
  userId: z.uuid().nullable(),
  sessionId: z.uuid().nullable(),
  walletAddress: evmAddress.nullable(),
  scopes: z.tuple([]),
});

export const humanCreatorActor = z.object({
  ...common,
  class: z.literal("human_creator"),
  plane: z.literal("human"),
  userId: z.uuid(),
  sessionId: z.uuid(),
  walletAddress: evmAddress.nullable(),
  scopes: z.tuple([]),
});

export const ownerAgentActor = z.object({
  ...common,
  class: z.literal("owner_agent"),
  plane: z.literal("agent"),
  /** The HUMAN this agent acts for. Everything is attributed here. */
  userId: z.uuid(),
  delegationId: z.uuid(),
  agentIdentityId: z.uuid(),
  connectorSlug: z.string(),
  scopes: z.array(z.string()).readonly(),
  requiresApproval: z.boolean(),
  walletAddress: evmAddress.nullable(),
});

export const crawlerAgentActor = z.object({
  ...common,
  class: z.literal("crawler_agent"),
  plane: z.literal("agent"),
  userId: z.null(),
  agentIdentityId: z.uuid().nullable(),
  /** Value of the Signature-Agent header, when one was verified. */
  signatureAgent: z.string().nullable(),
  verification: z.enum(["none", "web_bot_auth", "verified_crawler", "owner_delegated", "moltbook"]),
  /** A crawler that pays with x402 has a payer wallet; otherwise null. */
  walletAddress: evmAddress.nullable(),
  scopes: z.tuple([]),
});

export const actorSchema = z.discriminatedUnion("class", [
  humanReaderActor,
  humanCreatorActor,
  ownerAgentActor,
  crawlerAgentActor,
]);
export type Actor = z.infer<typeof actorSchema>;

/** Narrow helper the kernel uses; exported so route handlers do not re-derive it. */
export const canWrite = (
  a: Actor,
): a is z.infer<typeof humanCreatorActor> | z.infer<typeof ownerAgentActor> =>
  a.class === "human_creator" || a.class === "owner_agent";
