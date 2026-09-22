// packages/kernel/test/fixtures/ports.ts — stubPorts() (§6.13).
// Deterministic in both runtimes: SEED_EPOCH for the clock, a counter for ids,
// previewChars pinned to 400, a fixed PaymentRequired for the challenge. Nothing
// in the render path may call Date.now() or crypto.randomUUID() directly.
import type { PaymentRequired, Resource } from "@musebook/schema";
import type { KernelPorts, SettleOutcome } from "../../src/ports.js";
import { SEED_EPOCH } from "./actors.js";
import { ROWS } from "./resources.js";

export const ORIGIN = "https://musebook.dev";

export interface StubControls {
  /** SettleOutcome the payment stub returns; default 'settled'. */
  settle?: SettleOutcome;
  /** Agent blocklist answer; default false. */
  blocked?: boolean;
  /** X402_MODE equivalent; default 'live'. */
  mode?: "live" | "shadow" | "off";
  /** Override the grant lookup; default no held grant. */
  heldGrant?: { id: string; settlementId: string } | null;
  /** GrantPort that throws — the fail-closed case. */
  grantsThrow?: boolean;
  /** PaymentPort that throws — the other fail-closed case. */
  paymentsThrow?: boolean;
  /** Recorded log events. */
  logEvents?: Array<Record<string, unknown>>;
}

export const CHALLENGE: (
  resource: Resource,
  resourceUrl: string,
  error?: string,
) => PaymentRequired = (resource, resourceUrl, error) => ({
  x402Version: 2,
  ...(error !== undefined ? { error } : {}),
  resource: { url: resourceUrl, description: resource.summary ?? resource.slug },
  accepts: [
    {
      scheme: "exact",
      network: "eip155:8453",
      amount: resource.priceAtomic,
      asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      payTo: "0x769900f8faad0000000000000000000000000001",
      maxTimeoutSeconds: 60,
      extra: { name: "USD Coin", version: "2" },
    },
  ],
});

export function stubPorts(ctl: StubControls = {}): KernelPorts {
  let counter = 0;
  const settle: SettleOutcome = ctl.settle ?? {
    kind: "settled",
    settlementId: `set-${++counter}`,
    payer: "0x857b06519e91e3a54538791bdbb0e22373e36b66",
    response: {
      success: true,
      transaction: `0x${"ab".repeat(32)}`,
      network: "eip155:8453",
      amount: "2000",
      payer: "0x857b06519e91e3a54538791bdbb0e22373e36b66",
    },
  };

  return {
    now: () => new Date(SEED_EPOCH),
    resources: {
      loadRowBySlug: async (slug) => ROWS.find((r) => r.slug === slug) ?? null,
      loadRowByPostId: async (postId) => ROWS.find((r) => r.post_id === postId) ?? null,
    },
    grants: {
      findLiveGrant: async () => {
        if (ctl.grantsThrow) throw new Error("grant port down");
        return ctl.heldGrant
          ? {
              id: ctl.heldGrant.id,
              settlementId: ctl.heldGrant.settlementId,
              contentHash: "",
              payer: "",
              expiresAt: null,
            }
          : null;
      },
      mintGrant: async (g) => ({
        id: `grant-${++counter}`,
        settlementId: g.settlementId,
        contentHash: g.contentHash,
        payer: g.payer,
        expiresAt: g.expiresAt,
      }),
    },
    payments: {
      challenge: async ({ resource, resourceUrl, error }) => {
        if (ctl.paymentsThrow) throw new Error("payment port down");
        return CHALLENGE(resource, resourceUrl, error);
      },
      settle: async () => {
        if (ctl.paymentsThrow) throw new Error("payment port down");
        return settle;
      },
    },
    policy: {
      isAgentBlocked: async () => ctl.blocked ?? false,
      previewChars: () => 400,
      siteOrigin: () => ORIGIN,
      mode: () => ctl.mode ?? "live",
    },
    log: (event) => {
      ctl.logEvents?.push({ ...event });
    },
  };
}
