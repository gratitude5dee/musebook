import { describe, expect, it, vi } from "vitest";
import { settleOnce, type SettlementStore } from "../src/settle.js";
import { FacilitatorClient, FacilitatorUnavailable } from "../src/facilitator.js";
import type { Actor, PaymentPayload, Resource } from "@musebook/schema";
import type { Quote } from "../src/quotes.js";

const NOW = new Date("2026-09-22T00:00:00Z");
const PAYER = "0xda3840c0F8BB1dB0e86CD1Bf9b2398C1dc112F96";
const PAY_TO = "0x1000000000000000000000000000000000000001";
const CH = "b".repeat(64);

const quote = (over: Partial<Quote> = {}): Quote => ({
  id: "8d80ab6c-9f51-4f54-9f38-4b2148f95b29",
  postId: "1d80ab6c-9f51-4f54-9f38-4b2148f95b29",
  contentHash: CH,
  network: "eip155:8453",
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  amountAtomic: "250000",
  payTo: PAY_TO,
  maxTimeoutSeconds: 60,
  rateSource: "direct_usdc",
  expiresAt: new Date(NOW.getTime() + 60_000),
  ...over,
});

const payment = (over: Record<string, unknown> = {}): PaymentPayload =>
  ({
    x402Version: 2,
    accepted: {
      scheme: "exact",
      network: "eip155:8453",
      amount: "250000",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      payTo: PAY_TO,
      maxTimeoutSeconds: 60,
      extra: { name: "USD Coin", version: "2", quoteId: quote().id },
    },
    payload: {
      signature: `0x${"ab".repeat(65)}`,
      authorization: {
        from: PAYER,
        to: PAY_TO,
        value: "250000",
        validAfter: "0",
        validBefore: "9999999999",
        nonce: `0x${"cd".repeat(32)}`,
      },
    },
    ...over,
  }) as PaymentPayload;

const actor = (p: PaymentPayload | null): Actor => ({ payment: p }) as Actor;
const resource = (over: Partial<Resource> = {}): Resource =>
  ({
    postId: "1d80ab6c-9f51-4f54-9f38-4b2148f95b29",
    contentHash: CH,
    revenueShareVersion: "rs_2026_09_v1",
    ...over,
  }) as Resource;

interface StoreFns {
  insertResult: { id: string } | null;
  existing: Awaited<ReturnType<SettlementStore["findExisting"]>>;
  quoteById: Quote | null;
  liveQuote: Quote | null;
  calls: string[];
}
const makeStore = (fns: Partial<StoreFns> = {}): SettlementStore & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    findQuoteById: vi.fn(async () => {
      calls.push("findQuoteById");
      return fns.quoteById ?? null;
    }),
    findLiveQuote: vi.fn(async () => {
      calls.push("findLiveQuote");
      return fns.liveQuote ?? null;
    }),
    insertPending: vi.fn(async () => {
      calls.push("insertPending");
      return fns.insertResult !== undefined ? fns.insertResult : { id: "s-1" };
    }),
    findExisting: vi.fn(async () => {
      calls.push("findExisting");
      return fns.existing ?? null;
    }),
    markSettled: vi.fn(async () => void calls.push("markSettled")),
    markFailed: vi.fn(async () => void calls.push("markFailed")),
    consumeQuote: vi.fn(async () => void calls.push("consumeQuote")),
  };
};

const okFacilitator = (
  settleResult = { success: true, transaction: "0x1", network: "eip155:8453" },
) =>
  ({
    url: "https://x402.org/facilitator",
    verify: vi.fn(async () => ({ isValid: true, payer: PAYER })),
    settle: vi.fn(async () => settleResult),
  }) as unknown as FacilitatorClient;

const settle = (
  store: SettlementStore,
  facilitator: FacilitatorClient,
  p: PaymentPayload | null = payment(),
  r: Resource = resource(),
  idempotentWindowSeconds = 120,
) =>
  settleOnce({
    store,
    facilitator,
    resource: r,
    actor: actor(p),
    now: NOW,
    idempotentWindowSeconds,
  });

describe("settleOnce — preflight", () => {
  it("no payment → invalid", async () => {
    expect(await settle(makeStore(), okFacilitator(), null)).toEqual({
      kind: "invalid",
      invalidReason: "no_payment",
    });
  });

  it("x402Version ≠ 2 → unsupported_x402_version", async () => {
    const p = payment({ x402Version: 1 });
    expect(await settle(makeStore(), okFacilitator(), p)).toEqual({
      kind: "invalid",
      invalidReason: "unsupported_x402_version",
    });
  });
});

describe("settleOnce — quote resolution", () => {
  it("prefers findQuoteById when extra.quoteId is present", async () => {
    const store = makeStore({ quoteById: quote() });
    const f = okFacilitator();
    const out = await settle(store, f);
    expect(store.calls[0]).toBe("findQuoteById");
    expect(out.kind).toBe("settled");
  });

  it("falls back to findLiveQuote on content_hash+network+asset+amount", async () => {
    const p = payment();
    (p.accepted as { extra?: unknown }).extra = undefined; // no quoteId on the wire
    const store = makeStore({ liveQuote: quote() });
    const out = await settle(store, okFacilitator(), p);
    expect(store.calls[0]).toBe("findLiveQuote");
    expect(out.kind).toBe("settled");
  });

  it("no matching quote → quote_mismatch", async () => {
    expect(await settle(makeStore(), okFacilitator())).toEqual({
      kind: "quote_mismatch",
      detail: "no_matching_quote",
    });
  });

  it("quote for another content_hash → quote_mismatch", async () => {
    const store = makeStore({ quoteById: quote({ contentHash: "c".repeat(64) }) });
    expect(await settle(store, okFacilitator())).toEqual({
      kind: "quote_mismatch",
      detail: "quote_is_for_other_content_hash",
    });
  });

  it("expired quote → quote_expired", async () => {
    const store = makeStore({ quoteById: quote({ expiresAt: NOW }) });
    expect(await settle(store, okFacilitator())).toEqual({ kind: "quote_expired" });
  });

  it("field mismatch → quote_mismatch with detail", async () => {
    const p = payment();
    (p.accepted as { amount: string }).amount = "1";
    const store = makeStore({ quoteById: quote() });
    expect(await settle(store, okFacilitator(), p)).toEqual({
      kind: "quote_mismatch",
      detail: "amount=1",
    });
  });
});

describe("settleOnce — verify and claim", () => {
  it("facilitator unreachable at verify → unavailable", async () => {
    const f = {
      url: "u",
      verify: vi.fn(async () => {
        throw new FacilitatorUnavailable("down");
      }),
      settle: vi.fn(),
    } as unknown as FacilitatorClient;
    expect(await settle(makeStore({ quoteById: quote() }), f)).toEqual({ kind: "unavailable" });
  });

  it("non-verified payment → invalid with the facilitator's reason", async () => {
    const f = {
      url: "u",
      verify: vi.fn(async () => ({
        isValid: false,
        invalidReason: "invalid_exact_evm_payload_signature",
      })),
      settle: vi.fn(),
    } as unknown as FacilitatorClient;
    expect(await settle(makeStore({ quoteById: quote() }), f)).toEqual({
      kind: "invalid",
      invalidReason: "invalid_exact_evm_payload_signature",
    });
    expect(f.settle).not.toHaveBeenCalled();
  });

  it("isValid:false without a reason → verification_failed", async () => {
    const f = {
      url: "u",
      verify: vi.fn(async () => ({ isValid: false })),
      settle: vi.fn(),
    } as unknown as FacilitatorClient;
    expect(await settle(makeStore({ quoteById: quote() }), f)).toEqual({
      kind: "invalid",
      invalidReason: "verification_failed",
    });
  });
});

describe("settleOnce — the race matrix", () => {
  const dupStore = (existing: StoreFns["existing"]) =>
    makeStore({ quoteById: quote(), insertResult: null, existing });

  it("lost insert + nothing found → replay_race_lost", async () => {
    expect(await settle(dupStore(null), okFacilitator())).toEqual({
      kind: "invalid",
      invalidReason: "replay_race_lost",
    });
  });

  it("existing row is another content_hash → consumed", async () => {
    const s = dupStore({
      id: "s-2",
      contentHash: "z".repeat(64),
      status: "settled",
      settledAt: NOW.toISOString(),
      settleResponse: { success: true } as never,
    });
    expect(await settle(s, okFacilitator())).toEqual({ kind: "consumed" });
  });

  it("existing still pending → in_flight", async () => {
    const s = dupStore({
      id: "s-2",
      contentHash: CH,
      status: "pending",
      settledAt: null,
      settleResponse: null,
    });
    expect(await settle(s, okFacilitator())).toEqual({ kind: "in_flight" });
  });

  it("existing failed → consumed (nonce is burned)", async () => {
    const s = dupStore({
      id: "s-2",
      contentHash: CH,
      status: "failed",
      settledAt: null,
      settleResponse: null,
    });
    expect(await settle(s, okFacilitator())).toEqual({ kind: "consumed" });
  });

  it("existing settled but no response → consumed", async () => {
    const s = dupStore({
      id: "s-2",
      contentHash: CH,
      status: "settled",
      settledAt: NOW.toISOString(),
      settleResponse: null,
    });
    expect(await settle(s, okFacilitator())).toEqual({ kind: "consumed" });
  });

  it("existing settled outside the idempotent window → consumed", async () => {
    const s = dupStore({
      id: "s-2",
      contentHash: CH,
      status: "settled",
      settledAt: new Date(NOW.getTime() - 121_000).toISOString(),
      settleResponse: { success: true, transaction: "0x", network: "eip155:8453" },
    });
    expect(await settle(s, okFacilitator())).toEqual({ kind: "consumed" });
  });

  it("existing settled inside the window → idempotent with the receipt", async () => {
    const response = { success: true, transaction: "0x9f", network: "eip155:8453" };
    const s = dupStore({
      id: "s-2",
      contentHash: CH,
      status: "settled",
      settledAt: new Date(NOW.getTime() - 60_000).toISOString(),
      settleResponse: response,
    });
    expect(await settle(s, okFacilitator())).toEqual({
      kind: "idempotent",
      settlementId: "s-2",
      payer: PAYER.toLowerCase(),
      response,
    });
  });
});

describe("settleOnce — settle and flip", () => {
  it("success path: insert → settle → markSettled → consumeQuote → settled", async () => {
    const store = makeStore({ quoteById: quote() });
    const out = await settle(store, okFacilitator());
    expect(out).toMatchObject({ kind: "settled", settlementId: "s-1" });
    expect(store.calls).toEqual(["findQuoteById", "insertPending", "markSettled", "consumeQuote"]);
  });

  it("insert row carries the payer, nonce, verify response and payload (D64)", async () => {
    const insertPending = vi.fn(async () => ({ id: "s-9" }));
    const store = makeStore({ quoteById: quote() });
    (store as { insertPending: unknown }).insertPending = insertPending;
    await settle(store, okFacilitator());
    expect(insertPending).toHaveBeenCalledWith(
      expect.objectContaining({
        payer: PAYER.toLowerCase(),
        nonce: `0x${"cd".repeat(32)}`,
        revenueShareVersion: "rs_2026_09_v1",
      }),
    );
  });

  it("settle timeout → row stays pending, outcome unavailable (indeterminate)", async () => {
    const f = {
      url: "u",
      verify: vi.fn(async () => ({ isValid: true })),
      settle: vi.fn(async () => {
        throw new FacilitatorUnavailable("timeout");
      }),
    } as unknown as FacilitatorClient;
    const store = makeStore({ quoteById: quote() });
    expect(await settle(store, f)).toEqual({ kind: "unavailable" });
    expect(store.calls).not.toContain("markFailed");
    expect(store.calls).not.toContain("markSettled");
  });

  it("settle throws a non-Unavailable error → markFailed + rethrow", async () => {
    const f = {
      url: "u",
      verify: vi.fn(async () => ({ isValid: true })),
      settle: vi.fn(async () => {
        throw new TypeError("bad json");
      }),
    } as unknown as FacilitatorClient;
    const store = makeStore({ quoteById: quote() });
    await expect(settle(store, f)).rejects.toThrow("bad json");
    expect(store.calls).toContain("markFailed");
  });

  it("facilitator reports success:false → markFailed + invalid", async () => {
    const f = {
      url: "u",
      verify: vi.fn(async () => ({ isValid: true })),
      settle: vi.fn(async () => ({
        success: false,
        errorReason: "insufficient_funds",
        transaction: "",
        network: "eip155:8453",
      })),
    } as unknown as FacilitatorClient;
    const store = makeStore({ quoteById: quote() });
    expect(await settle(store, f)).toEqual({
      kind: "invalid",
      invalidReason: "insufficient_funds",
    });
    expect(store.calls).toContain("markFailed");
  });
});
