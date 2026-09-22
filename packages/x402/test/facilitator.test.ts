import { afterEach, describe, expect, it, vi } from "vitest";
import { FacilitatorClient, FacilitatorUnavailable } from "../src/facilitator.js";
import type { PaymentPayload, PaymentRequirements } from "@musebook/schema";

const req: PaymentRequirements = {
  scheme: "exact",
  network: "eip155:84532",
  amount: "1000",
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  payTo: "0x1000000000000000000000000000000000000001",
  maxTimeoutSeconds: 60,
};
const pay = { x402Version: 2 } as unknown as PaymentPayload;

const fac = (over: Partial<ConstructorParameters<typeof FacilitatorClient>[0]> = {}) =>
  new FacilitatorClient({
    url: "https://x402.org/facilitator",
    network: "eip155:84532",
    timeoutMs: 5000,
    ...over,
  });

function stubFetch(handler: (url: string, init?: RequestInit) => Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn(handler));
}
afterEach(() => vi.unstubAllGlobals());

describe("FacilitatorClient", () => {
  it("refuses x402.org for mainnet at construction", () => {
    expect(() => fac({ url: "https://x402.org/facilitator", network: "eip155:8453" })).toThrow(
      /cannot settle eip155:8453/,
    );
  });

  it("exposes url for the settlement row", () => {
    expect(fac().url).toBe("https://x402.org/facilitator");
  });

  it("verify POSTs {x402Version:2,paymentPayload,paymentRequirements} and parses", async () => {
    let seen: unknown;
    stubFetch(async (url, init) => {
      expect(url).toBe("https://x402.org/facilitator/verify");
      seen = JSON.parse(String(init?.body));
      return Response.json({ isValid: true, payer: "0xabc" });
    });
    const r = await fac().verify(pay, req);
    expect(r.isValid).toBe(true);
    expect(seen).toMatchObject({ x402Version: 2, paymentPayload: pay });
  });

  it("settle parses SettleResponse", async () => {
    stubFetch(async () =>
      Response.json({ success: true, transaction: "0x", network: "eip155:84532" }),
    );
    const r = await fac().settle(pay, req);
    expect(r.success).toBe(true);
  });

  it("supported GETs and returns kinds", async () => {
    stubFetch(async (url) => {
      expect(url).toBe("https://x402.org/facilitator/supported");
      return Response.json({
        kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:84532" }],
      });
    });
    const s = await fac().supported();
    expect(s.kinds[0]?.network).toBe("eip155:84532");
  });

  it("non-2xx and unreachable throw FacilitatorUnavailable", async () => {
    stubFetch(async () => new Response("nope", { status: 500 }));
    await expect(fac().verify(pay, req)).rejects.toBeInstanceOf(FacilitatorUnavailable);
    stubFetch(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(fac().supported()).rejects.toBeInstanceOf(FacilitatorUnavailable);
  });

  it("opens the circuit after five consecutive failures", async () => {
    stubFetch(async () => new Response("x", { status: 502 }));
    const f = fac();
    for (let i = 0; i < 5; i++) {
      await expect(f.verify(pay, req)).rejects.toBeInstanceOf(FacilitatorUnavailable);
    }
    await expect(f.verify(pay, req)).rejects.toThrow(/circuit open/);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(5); // sixth attempt never hit the wire
  });

  it("success resets the failure counter", async () => {
    let n = 0;
    stubFetch(async () => {
      n += 1;
      return n <= 4 ? new Response("x", { status: 502 }) : Response.json({ isValid: true });
    });
    const f = fac();
    for (let i = 0; i < 4; i++) await expect(f.verify(pay, req)).rejects.toThrow();
    await expect(f.verify(pay, req)).resolves.toMatchObject({ isValid: true });
  });

  it("schema-invalid facilitator bodies fail closed on parse", async () => {
    stubFetch(async () => Response.json({ unexpected: true }));
    await expect(fac().verify(pay, req)).rejects.toThrow();
  });

  it("sends authHeaders per path when configured", async () => {
    const seen: string[] = [];
    stubFetch(async (url, init) => {
      seen.push(url);
      expect((init?.headers as Record<string, string>).Authorization).toMatch(/^Bearer /);
      return Response.json(url.endsWith("supported") ? { kinds: [] } : { isValid: true });
    });
    const f = fac({
      authHeaders: async (path) => ({ Authorization: `Bearer tok-${path}` }),
    });
    await f.verify(pay, req);
    await f.supported();
    expect(seen.map((u) => u.split("/").pop())).toEqual(["verify", "supported"]);
  });
});
