// packages/x402/src/http.ts — the x402 v2 HTTP envelope.
// PAYMENT-REQUIRED (402) / PAYMENT-SIGNATURE (retry) / PAYMENT-RESPONSE (200):
// every protocol object travels base64-encoded in a header, never the body.
import type {
  AccessDecision,
  PaymentPayload,
  PaymentRequired,
  SettleResponse,
} from "@musebook/schema";
import { paymentPayloadSchema, paymentRequiredSchema } from "@musebook/schema";

const b64 = (v: unknown): string => btoa(JSON.stringify(v));

export function encodePaymentRequired(required: PaymentRequired): string {
  return b64(required);
}

export function decodePaymentRequired(header: string | null): PaymentRequired | null {
  if (header === null) return null;
  const parsed = paymentRequiredSchema.safeParse(JSON.parse(atob(header)));
  return parsed.success ? parsed.data : null;
}

export function encodePaymentPayload(payload: PaymentPayload): string {
  return b64(payload);
}

/** The client's signed payment, from PAYMENT-SIGNATURE or null. */
export function decodePaymentPayload(header: string | null): PaymentPayload | null {
  if (header === null) return null;
  const parsed = paymentPayloadSchema.safeParse(JSON.parse(atob(header)));
  return parsed.success ? parsed.data : null;
}

/**
 * The 402 (or the access-denied status the kernel chose) with the quote on the
 * wire. decision.challenge is the pinned PaymentRequired built by
 * PaymentPort.challenge — a 402 without it is a dead end for the client.
 */
export function paymentRequiredHttp(decision: AccessDecision): Response {
  if (decision.allow) return new Response(null, { status: 500 }); // unreachable by contract
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "private, no-store",
  };
  if (decision.challenge !== null) {
    headers["PAYMENT-REQUIRED"] = encodePaymentRequired(decision.challenge);
  }
  // v2 carries ALL protocol information in headers (§9708) — v1's response-body
  // requirements are gone, so the 402 body is empty.
  return new Response(null, { status: decision.httpStatus, headers });
}

/** SettleResponse echoes on the paid 200 so the client has its receipt. */
export function withSettlement(response: Response, decision: AccessDecision): Response {
  if (!decision.allow || decision.settlement === null) return response;
  const headers = new Headers(response.headers);
  headers.set("PAYMENT-RESPONSE", b64(decision.settlement));
  return new Response(response.body, { status: response.status, headers });
}

export type { SettleResponse };
