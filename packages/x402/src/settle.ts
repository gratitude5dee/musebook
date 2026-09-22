// packages/x402/src/settle.ts — plan.md §6.8, verbatim.
import type {
  Actor,
  PaymentPayload,
  PaymentRequirements,
  Resource,
  SettleResponse,
} from "@musebook/schema";
import type { SettleOutcome } from "@musebook/kernel";
import { type FacilitatorClient, FacilitatorUnavailable } from "./facilitator";
import { checkAgainstQuote, requirementsFor, type Quote } from "./quotes";

/**
 * The manifest's default (§3.7 `X402_IDEMPOTENT_WINDOW_SECONDS`). It is a DEFAULT,
 * not a read: this package imports no platform API and therefore reads no environment
 * — `process.env` population from bindings on workerd is **UNVERIFIED** and a pure
 * package must not depend on it either way. The adapter passes the live value in
 * `settleOnce({ idempotentWindowSeconds: Number(env.X402_IDEMPOTENT_WINDOW_SECONDS) })`.
 */
export const IDEMPOTENT_WINDOW_SECONDS_DEFAULT = 120;

export interface SettlementStore {
  findQuoteById(id: string): Promise<Quote | null>;
  findLiveQuote(q: {
    contentHash: string;
    network: string;
    asset: string;
    amountAtomic: string;
  }): Promise<Quote | null>;

  /** INSERT ... status='pending'. Returns null on unique violation (23505). */
  insertPending(row: {
    quoteId: string;
    postId: string;
    contentHash: string;
    network: string;
    asset: string;
    payer: string;
    nonce: string;
    amountAtomic: string;
    payTo: string;
    facilitatorUrl: string;
    verifyResponse: unknown;
    revenueShareVersion: string;
    /** D64: the signed authorization, stored so the reconciler can re-/settle. */
    paymentPayload: unknown;
  }): Promise<{ id: string } | null>;

  findExisting(k: { network: string; asset: string; payer: string; nonce: string }): Promise<{
    id: string;
    contentHash: string;
    status: "pending" | "settled" | "failed" | "refunded";
    settledAt: string | null;
    settleResponse: SettleResponse | null;
  } | null>;

  markSettled(id: string, r: SettleResponse): Promise<void>;
  markFailed(id: string, r: SettleResponse | null, errorReason: string): Promise<void>;
  consumeQuote(id: string): Promise<void>;
}

export async function settleOnce(args: {
  store: SettlementStore;
  facilitator: FacilitatorClient;
  resource: Resource;
  actor: Actor;
  now: Date;
  idempotentWindowSeconds?: number;
}): Promise<SettleOutcome> {
  const { store, facilitator, resource, actor, now } = args;
  const idempotentWindow = args.idempotentWindowSeconds ?? IDEMPOTENT_WINDOW_SECONDS_DEFAULT;
  const payment: PaymentPayload | null | undefined = actor.payment;
  if (payment == null) return { kind: "invalid", invalidReason: "no_payment" };
  if (payment.x402Version !== 2) {
    return { kind: "invalid", invalidReason: "unsupported_x402_version" };
  }

  const auth = payment.payload.authorization;
  const payer = auth.from.toLowerCase();
  const nonce = auth.nonce.toLowerCase();
  const accepted = payment.accepted;

  // ── 1. Resolve the pinned quote. ──────────────────────────────────────────
  const quoteId = typeof accepted.extra?.quoteId === "string" ? accepted.extra.quoteId : null;
  const quote =
    (quoteId !== null ? await store.findQuoteById(quoteId) : null) ??
    (await store.findLiveQuote({
      contentHash: resource.contentHash,
      network: accepted.network,
      asset: accepted.asset,
      amountAtomic: accepted.amount,
    }));
  if (quote === null) return { kind: "quote_mismatch", detail: "no_matching_quote" };
  if (quote.contentHash !== resource.contentHash) {
    return { kind: "quote_mismatch", detail: "quote_is_for_other_content_hash" };
  }

  const check = checkAgainstQuote(quote, accepted, auth, now);
  if (!check.ok) {
    return check.kind === "expired"
      ? { kind: "quote_expired" }
      : { kind: "quote_mismatch", detail: check.detail };
  }
  const requirements: PaymentRequirements = requirementsFor(quote);

  // ── 2. Facilitator verify. Cheap, no chain write. ─────────────────────────
  let verified;
  try {
    verified = await facilitator.verify(payment, requirements);
  } catch (err) {
    if (err instanceof FacilitatorUnavailable) return { kind: "unavailable" };
    throw err;
  }
  if (!verified.isValid) {
    return {
      kind: "invalid",
      invalidReason: verified.invalidReason ?? "verification_failed",
    };
  }

  // ── 3. CLAIM THE NONCE BEFORE SERVING ANYTHING. ───────────────────────────
  // Exactly one of N concurrent requests wins this insert.
  const claimed = await store.insertPending({
    quoteId: quote.id,
    postId: resource.postId,
    contentHash: resource.contentHash,
    network: quote.network,
    asset: quote.asset,
    payer,
    nonce,
    amountAtomic: quote.amountAtomic,
    payTo: quote.payTo,
    facilitatorUrl: facilitator.url,
    verifyResponse: verified,
    revenueShareVersion: resource.revenueShareVersion,
    paymentPayload: payment,
  });

  if (claimed === null) {
    // 23505: someone else holds this (network, asset, payer, nonce).
    const existing = await store.findExisting({
      network: quote.network,
      asset: quote.asset,
      payer,
      nonce,
    });
    if (existing === null) return { kind: "invalid", invalidReason: "replay_race_lost" };

    // One signed authorization buys ONE resource.
    if (existing.contentHash !== resource.contentHash) return { kind: "consumed" };

    if (existing.status === "pending") return { kind: "in_flight" };
    if (existing.status !== "settled" || existing.settleResponse === null) {
      return { kind: "consumed" };
    }

    const age = (now.getTime() - Date.parse(existing.settledAt ?? "")) / 1000;
    if (!Number.isFinite(age) || age > idempotentWindow) return { kind: "consumed" };

    return {
      kind: "idempotent",
      settlementId: existing.id,
      payer,
      response: existing.settleResponse,
    };
  }

  // ── 4. Settle on chain. ───────────────────────────────────────────────────
  let response: SettleResponse;
  try {
    response = await facilitator.settle(payment, requirements);
  } catch (err) {
    // A TIMED-OUT OR UNREACHABLE settle is INDETERMINATE — the SDK says so plainly:
    // "the facilitator may still have completed the settlement." Marking the row
    // `failed` here would burn a nonce the chain may have honoured and hand the
    // payer a charge with no bytes. Leave it `pending` and let the reconciler
    // re-settle idempotently against the same nonce.
    if (err instanceof FacilitatorUnavailable) return { kind: "unavailable" };
    await store.markFailed(claimed.id, null, err instanceof Error ? err.message : String(err));
    throw err;
  }

  if (!response.success) {
    await store.markFailed(claimed.id, response, response.errorReason ?? "settle_failed");
    return { kind: "invalid", invalidReason: response.errorReason ?? "settle_failed" };
  }

  await store.markSettled(claimed.id, response);
  await store.consumeQuote(quote.id);
  return { kind: "settled", settlementId: claimed.id, payer, response };
}
