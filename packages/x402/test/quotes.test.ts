import { describe, expect, it } from "vitest";
import {
  buildPaymentRequired,
  checkAgainstQuote,
  requirementsFor,
  type Quote,
} from "../src/quotes.js";

const now = new Date("2026-09-22T00:00:00Z");
const quote = (over: Partial<Quote> = {}): Quote => ({
  id: "8d80ab6c-9f51-4f54-9f38-4b2148f95b29",
  postId: "1d80ab6c-9f51-4f54-9f38-4b2148f95b29",
  contentHash: "a".repeat(64),
  network: "eip155:8453",
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  amountAtomic: "250000",
  payTo: "0x1000000000000000000000000000000000000001",
  maxTimeoutSeconds: 60,
  rateSource: "direct_usdc",
  expiresAt: new Date(now.getTime() + 60_000),
  ...over,
});

describe("requirementsFor", () => {
  it("builds accepts[0] for the quote's network, payTo always treasury", () => {
    const r = requirementsFor(quote());
    expect(r).toEqual({
      scheme: "exact",
      network: "eip155:8453",
      amount: "250000",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      payTo: "0x1000000000000000000000000000000000000001",
      maxTimeoutSeconds: 60,
      extra: { name: "USD Coin", version: "2", quoteId: quote().id },
    });
  });

  it("echoes Sepolia's real domain name (USDC, not USD Coin)", () => {
    const r = requirementsFor(quote({ network: "eip155:84532" }));
    expect(r.extra).toMatchObject({ name: "USDC", version: "2" });
    expect(r.asset).toBe("0x036CbD53842c5426634e7929541eC2318f3dCF7e");
  });

  it("throws on a network with no asset config", () => {
    expect(() => requirementsFor(quote({ network: "eip155:1" }))).toThrow(/no asset config/);
  });
});

describe("buildPaymentRequired", () => {
  it("emits x402Version 2, resourceInfo, exactly one accepts entry", () => {
    const pr = buildPaymentRequired({
      quote: quote(),
      resourceUrl: "https://musebook.dev/p/hello",
      mimeType: "text/markdown",
      description: "d",
      tags: ["a", "b", "c", "d", "e", "f"],
      origin: "https://musebook.dev",
    });
    expect(pr.x402Version).toBe(2);
    expect(pr.accepts).toHaveLength(1);
    expect(pr.resource.url).toBe("https://musebook.dev/p/hello");
    expect(pr.resource.tags).toHaveLength(5); // §7.7.1 caps at five
    expect(pr.resource.iconUrl).toBe("https://musebook.dev/icon-512.png");
    expect(pr.error).toBeUndefined();
  });

  it("carries the error string only when given", () => {
    const pr = buildPaymentRequired({
      quote: quote(),
      resourceUrl: "https://musebook.dev/p/x",
      mimeType: "text/markdown",
      description: "",
      tags: [],
      origin: "https://musebook.dev",
      error: "insufficient_funds",
    });
    expect(pr.error).toBe("insufficient_funds");
  });
});

describe("checkAgainstQuote", () => {
  const base = () => ({
    accepted: {
      scheme: "exact" as const,
      network: "eip155:8453",
      amount: "250000",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      payTo: "0x1000000000000000000000000000000000000001",
      maxTimeoutSeconds: 60,
    },
    auth: {
      to: "0x1000000000000000000000000000000000000001",
      value: "250000",
      validBefore: String(Math.floor(now.getTime() / 1000) + 60),
    },
  });

  it("ok on an exact match", () => {
    const { accepted, auth } = base();
    const c = checkAgainstQuote(quote(), accepted, auth, now);
    expect(c.ok).toBe(true);
    if (c.ok) expect(c.quote.id).toBe(quote().id);
  });

  it("expired when expiresAt <= now", () => {
    const { accepted, auth } = base();
    const c = checkAgainstQuote(quote({ expiresAt: now }), accepted, auth, now);
    expect(c).toEqual({ ok: false, kind: "expired" });
  });

  it.each([
    ["scheme", { scheme: "upto" }, "scheme=upto"],
    ["network", { network: "eip155:84532" }, "network=eip155:84532"],
    ["asset", { asset: "0x0000000000000000000000000000000000000009" }, "asset"],
    ["payTo", { payTo: "0x2000000000000000000000000000000000000002" }, "payTo"],
    ["amount", { amount: "1" }, "amount=1"],
  ])("mismatch on %s", (_name, over, detail) => {
    const { accepted, auth } = base();
    const c = checkAgainstQuote(quote(), { ...accepted, ...over } as typeof accepted, auth, now);
    expect(c).toEqual({ ok: false, kind: "mismatch", detail });
  });

  it.each([
    ["authorization.to", { to: "0x2000000000000000000000000000000000000002" }, "authorization.to"],
    ["authorization.value", { value: "1" }, "authorization.value"],
    ["validBefore", { validBefore: String(Math.floor(now.getTime() / 1000)) }, "validBefore"],
  ])("mismatch on %s", (_name, over, detail) => {
    const { accepted, auth } = base();
    const c = checkAgainstQuote(quote(), accepted, { ...auth, ...over }, now);
    expect(c).toEqual({ ok: false, kind: "mismatch", detail });
  });

  it("joins multiple mismatches and lowercases address compares", () => {
    const { accepted, auth } = base();
    const c = checkAgainstQuote(
      quote({ payTo: "0x10000000000000000000000000000000000000aa" }),
      accepted,
      auth,
      now,
    );
    expect(c.ok).toBe(false);
    if (!c.ok && c.kind === "mismatch") expect(c.detail).toBe("payTo,authorization.to");
  });
});
