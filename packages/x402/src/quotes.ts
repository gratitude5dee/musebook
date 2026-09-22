// packages/x402/src/quotes.ts — plan.md §6.7.6, verbatim.
import type { PaymentRequired, PaymentRequirements } from "@musebook/schema";
import { X402_ASSETS } from "./assets.js";

export interface Quote {
  readonly id: string;
  readonly contentHash: string;
  readonly network: string;
  readonly asset: string;
  readonly payTo: string;
  readonly amountAtomic: string;
  readonly maxTimeoutSeconds: number; // 60 — the same literal as QUOTE_TTL_SECONDS
  readonly rateSource: "direct_usdc" | "oracle"; // x402_quotes.rate_source (§4.10); v1 writes 'direct_usdc'
  readonly expiresAt: Date;
}

export const QUOTE_TTL_SECONDS = 60; // == maxTimeoutSeconds
export const MIN_PRICE_ATOMIC = 1000n; // 0.001 USDC. Ours, not Cloudflare's — see §6.7.6.

export function requirementsFor(quote: Quote): PaymentRequirements {
  const cfg = X402_ASSETS[quote.network];
  if (cfg === undefined) throw new Error(`no asset config for ${quote.network}`);
  return {
    scheme: "exact",
    network: quote.network,
    amount: quote.amountAtomic,
    asset: cfg.asset,
    payTo: quote.payTo,
    maxTimeoutSeconds: quote.maxTimeoutSeconds,
    extra: { name: cfg.name, version: cfg.version, quoteId: quote.id },
  };
}

/**
 * The v2 402 payload for one pinned quote. THE ONLY builder of PaymentRequired in
 * the repo: the HTTP PaymentPort.challenge adapter and the MCP adapter (§7.7.2)
 * both call this and differ only in the envelope they put it in.
 */
export function buildPaymentRequired(input: {
  quote: Quote;
  resourceUrl: string; // `${NEXT_PUBLIC_SITE_URL}/p/${slug}` — canonical, never a twin
  mimeType: string;
  description: string;
  tags: readonly string[];
  origin: string;
  error?: string;
}): PaymentRequired {
  return {
    x402Version: 2,
    ...(input.error !== undefined ? { error: input.error } : {}),
    resource: {
      url: input.resourceUrl,
      description: input.description,
      mimeType: input.mimeType,
      serviceName: "Musebook",
      tags: input.tags.slice(0, 5).map((t) => t.slice(0, 32)),
      iconUrl: `${input.origin}/icon-512.png`,
    },
    accepts: [requirementsFor(input.quote)], // exactly one entry in v1 (§6.9)
  };
}

export type QuoteCheck =
  | { ok: true; quote: Quote }
  | { ok: false; kind: "expired" }
  | { ok: false; kind: "mismatch"; detail: string };

export function checkAgainstQuote(
  quote: Quote,
  accepted: PaymentRequirements,
  authorization: { to: string; value: string; validBefore: string },
  now: Date,
): QuoteCheck {
  if (quote.expiresAt.getTime() <= now.getTime()) return { ok: false, kind: "expired" };

  const mismatches: string[] = [];
  if (accepted.scheme !== "exact") mismatches.push(`scheme=${accepted.scheme}`);
  if (accepted.network !== quote.network) mismatches.push(`network=${accepted.network}`);
  if (accepted.asset.toLowerCase() !== quote.asset.toLowerCase()) mismatches.push("asset");
  if (accepted.payTo.toLowerCase() !== quote.payTo.toLowerCase()) mismatches.push("payTo");
  if (accepted.amount !== quote.amountAtomic) mismatches.push(`amount=${accepted.amount}`);
  if (authorization.to.toLowerCase() !== quote.payTo.toLowerCase())
    mismatches.push("authorization.to");
  if (authorization.value !== quote.amountAtomic) mismatches.push("authorization.value");
  if (Number(authorization.validBefore) * 1000 <= now.getTime()) mismatches.push("validBefore");

  return mismatches.length === 0
    ? { ok: true, quote }
    : { ok: false, kind: "mismatch", detail: mismatches.join(",") };
}
