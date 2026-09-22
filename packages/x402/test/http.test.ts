import { describe, expect, it } from "vitest";
import {
  decodePaymentPayload,
  decodePaymentRequired,
  encodePaymentPayload,
  encodePaymentRequired,
  paymentRequiredHttp,
  withSettlement,
} from "../src/http.js";
import type { AccessDecision } from "@musebook/schema";
import { paymentPayloadSchema, paymentRequiredSchema } from "@musebook/schema";

const required = {
  x402Version: 2 as const,
  resource: { url: "https://musebook.dev/p/hello", serviceName: "Musebook" },
  accepts: [
    {
      scheme: "exact" as const,
      network: "eip155:8453",
      amount: "250000",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      payTo: "0x1000000000000000000000000000000000000001",
      maxTimeoutSeconds: 60,
    },
  ],
};

const payload = {
  x402Version: 2 as const,
  accepted: required.accepts[0],
  payload: {
    signature: `0x${"ab".repeat(65)}`,
    authorization: {
      from: "0xda3840c0F8BB1dB0e86CD1Bf9b2398C1dc112F96",
      to: "0x1000000000000000000000000000000000000001",
      value: "250000",
      validAfter: "0",
      validBefore: "9999999999",
      nonce: `0x${"cd".repeat(32)}`,
    },
  },
};

const decision = (over: Partial<AccessDecision> = {}): AccessDecision =>
  ({
    allow: false,
    httpStatus: 402,
    challenge: required,
    settlement: null,
    ...over,
  }) as AccessDecision;

describe("header codecs", () => {
  it("round-trips PaymentRequired through base64 JSON", () => {
    const decoded = decodePaymentRequired(encodePaymentRequired(required));
    expect(decoded).toEqual(required);
  });

  it("round-trips PaymentPayload", () => {
    const decoded = decodePaymentPayload(encodePaymentPayload(payload));
    expect(decoded).toEqual(payload);
  });

  it("returns null on a null header", () => {
    expect(decodePaymentRequired(null)).toBeNull();
    expect(decodePaymentPayload(null)).toBeNull();
  });

  it("returns null when the payload fails the schema", () => {
    expect(decodePaymentRequired(btoa(JSON.stringify({ x402Version: 1 })))).toBeNull();
    expect(decodePaymentPayload(btoa(JSON.stringify({ x402Version: 2 })))).toBeNull();
  });
});

describe("paymentRequiredHttp", () => {
  it("402s with PAYMENT-REQUIRED and an empty body", async () => {
    const res = paymentRequiredHttp(decision());
    expect(res.status).toBe(402);
    const decoded = decodePaymentRequired(res.headers.get("PAYMENT-REQUIRED"));
    expect(decoded).toEqual(required);
    expect(await res.text()).toBe(""); // v2: all protocol data rides headers
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it("omits the header when the decision carries no challenge", () => {
    const res = paymentRequiredHttp(decision({ challenge: null }));
    expect(res.headers.get("PAYMENT-REQUIRED")).toBeNull();
  });

  it("is unreachable on an allow decision", () => {
    const res = paymentRequiredHttp(decision({ allow: true }));
    expect(res.status).toBe(500);
  });
});

describe("withSettlement", () => {
  const settled = {
    success: true,
    transaction: `0x${"ef".repeat(32)}`,
    network: "eip155:8453",
  };

  it("attaches PAYMENT-RESPONSE on a paid 200", () => {
    const res = withSettlement(
      new Response("bytes", { status: 200 }),
      decision({ allow: true, settlement: settled, challenge: null }),
    );
    expect(res.headers.get("PAYMENT-RESPONSE")).toBe(btoa(JSON.stringify(settled)));
    return res.text().then((t) => expect(t).toBe("bytes"));
  });

  it("is a no-op on deny or missing settlement", () => {
    const deny = withSettlement(new Response("x"), decision());
    expect(deny.headers.get("PAYMENT-RESPONSE")).toBeNull();
    const noReceipt = withSettlement(
      new Response("x"),
      decision({ allow: true, settlement: null }),
    );
    expect(noReceipt.headers.get("PAYMENT-RESPONSE")).toBeNull();
  });
});
