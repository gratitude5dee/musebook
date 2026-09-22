// packages/x402/src/facilitator.ts — plan.md §6.7.5.
import {
  settleResponseSchema,
  verifyResponseSchema,
  type PaymentPayload,
  type PaymentRequirements,
  type SettleResponse,
  type VerifyResponse,
} from "@musebook/schema";

export interface FacilitatorConfig {
  readonly url: string; // no trailing slash
  /** CAIP-2 network this client serves (e.g. 'eip155:8453'). */
  readonly network: string;
  /**
   * Auth headers, minted PER REQUEST PATH ('verify' | 'settle' | 'supported').
   * The CDP facilitator wants a short-lived bearer JWT; the Worker signs it with
   * WebCrypto (§6.7.5) so neither `@coinbase/cdp-sdk` nor viem enters the bundle.
   * Returning {} is correct for the testnet facilitator, which is unauthenticated.
   */
  readonly authHeaders?: (
    path: "verify" | "settle" | "supported",
  ) => Promise<Readonly<Record<string, string>>>;
  readonly timeoutMs: number; // 8000. The SDK's own default is 90_000.
}

export class FacilitatorUnavailable extends Error {}

export class FacilitatorClient {
  private consecutiveFailures = 0;
  private openUntil = 0;

  constructor(private readonly cfg: FacilitatorConfig) {
    // The public testnet facilitator does not settle Base mainnet; pointing a
    // mainnet deploy at it produces plausible-looking 402s that never settle.
    if (cfg.url.includes("x402.org") && cfg.network === "eip155:8453") {
      throw new Error("x402.org facilitator cannot settle eip155:8453");
    }
  }

  /** Recorded on every x402_settlements row (`facilitator_url`) by settleOnce (§6.8). */
  get url(): string {
    return this.cfg.url;
  }

  async verify(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    const json = await this.post("/verify", {
      x402Version: 2,
      paymentPayload,
      paymentRequirements,
    });
    return verifyResponseSchema.parse(json);
  }

  async settle(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    const json = await this.post("/settle", {
      x402Version: 2,
      paymentPayload,
      paymentRequirements,
    });
    return settleResponseSchema.parse(json);
  }

  /** GET /supported -> { kinds: [{x402Version, scheme, network, extra?}], extensions, signers } */
  async supported(): Promise<{
    kinds: Array<{ x402Version: number; scheme: string; network: string }>;
  }> {
    try {
      const res = await fetch(`${this.cfg.url}/supported`, {
        headers: await this.authFor("supported"),
      });
      if (!res.ok) throw new FacilitatorUnavailable(`/supported ${res.status}`);
      return await res.json();
    } catch (err) {
      throw err instanceof FacilitatorUnavailable ? err : new FacilitatorUnavailable(String(err));
    }
  }

  private async authFor(path: "verify" | "settle" | "supported") {
    return this.cfg.authHeaders === undefined ? {} : await this.cfg.authHeaders(path);
  }

  private async post(path: "/verify" | "/settle", body: unknown): Promise<unknown> {
    if (Date.now() < this.openUntil) throw new FacilitatorUnavailable("circuit open");

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.cfg.timeoutMs);
    try {
      const res = await fetch(`${this.cfg.url}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(await this.authFor(path === "/verify" ? "verify" : "settle")),
        },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
      if (!res.ok) throw new FacilitatorUnavailable(`${path} ${res.status}`);
      this.consecutiveFailures = 0;
      return await res.json();
    } catch (err) {
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= 5) this.openUntil = Date.now() + 30_000;
      throw err instanceof FacilitatorUnavailable ? err : new FacilitatorUnavailable(String(err));
    } finally {
      clearTimeout(timer);
    }
  }
}
