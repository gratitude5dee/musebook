// apps/web/app/pay/[postId]/_islands/unlock.ts — the client-side x402 flow
// (§14.4.2). decodePaymentRequired / encodePaymentPayload are the v2 header
// codecs from @musebook/x402 — the ONE x402 implementation. Nothing here talks
// to thirdweb's x402 module or hand-rolls the base64 envelope.
import { decodePaymentRequired, encodePaymentPayload } from "@musebook/x402";
import type { PaymentRequirements } from "@musebook/schema";

/** The wallet's half of §14.4.2's `signer`: everything is echoed from the
 *  offered PaymentRequirements — never hardcode the EIP-712 domain (Base
 *  mainnet USDC is "USD Coin", Sepolia is "USDC", both at version "2"). */
export interface PaymentSigner {
  signTransferWithAuthorization(input: {
    /** CAIP-2 — the EIP-712 domain's chainId is parsed out of it (eip155:<id>). */
    network: string;
    asset: string;
    domainName: string;
    domainVersion: string;
    value: string;
    payTo: string;
    maxTimeoutSeconds: number;
  }): Promise<{
    signature: string;
    authorization: {
      from: string;
      to: string;
      value: string;
      validAfter: string;
      validBefore: string;
      nonce: string;
    };
  }>;
}

export type UnlockResult =
  | { kind: "unlocked"; body: string }
  | { kind: "already_free"; response: Response }
  | { kind: "error"; code: string; newPriceUsd?: string };

export async function unlock(
  slug: string,
  signer: PaymentSigner,
  fetchFn: typeof fetch = fetch,
): Promise<UnlockResult> {
  // /p/{slug}.json is served by musebook-edge, same origin — headers readable
  // with no CORS exposure (§14.4.2).
  const probe = await fetchFn(`/p/${slug}.json`, {
    headers: { accept: "application/json" },
  });
  if (probe.status !== 402) {
    return probe.ok
      ? { kind: "already_free", response: probe }
      : { kind: "error", code: "kernel_error" };
  }

  const required = decodePaymentRequired(probe.headers.get("PAYMENT-REQUIRED"));
  if (required === null) return { kind: "error", code: "kernel_error" };
  const chosen: PaymentRequirements | undefined = required.accepts[0]; // one offer in v1
  if (chosen?.extra === undefined) return { kind: "error", code: "kernel_error" };

  const signed = await signer.signTransferWithAuthorization({
    network: chosen.network,
    asset: chosen.asset,
    domainName: String(chosen.extra.name),
    domainVersion: String(chosen.extra.version),
    value: chosen.amount,
    payTo: chosen.payTo,
    maxTimeoutSeconds: chosen.maxTimeoutSeconds,
  });

  const paid = await fetchFn(`/p/${slug}.json`, {
    headers: {
      accept: "application/json",
      "PAYMENT-SIGNATURE": encodePaymentPayload({
        x402Version: 2,
        accepted: chosen,
        payload: signed,
      }),
    },
  });
  if (paid.ok) return { kind: "unlocked", body: await paid.text() };
  if (paid.status === 402) {
    const err = paid.headers.get("PAYMENT-REQUIRED");
    const again = err === null ? null : decodePaymentRequired(err);
    const code = (again?.error as string | undefined) ?? "payment_invalid";
    const newPrice =
      again?.accepts[0]?.extra?.priceUsd !== undefined
        ? String(again.accepts[0].extra.priceUsd)
        : undefined;
    return { kind: "error", code, ...(newPrice !== undefined ? { newPriceUsd: newPrice } : {}) };
  }
  if (paid.status === 409) return { kind: "error", code: "replay_in_flight" };
  if (paid.status === 503) return { kind: "error", code: "facilitator_unavailable" };
  return { kind: "error", code: "kernel_error" };
}
