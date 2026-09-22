// packages/kernel/test/access.test.ts — the decision table (§6.4).
import { describe, expect, it } from "vitest";
import type { Actor } from "@musebook/schema";
import { createKernel } from "../src/index.js";
import { stubPorts } from "./fixtures/ports.js";
import { FREE, HFAP, GATED } from "./fixtures/resources.js";
import { HUMAN, AGENT } from "./fixtures/actors.js";

function paying(actor: Actor): Actor {
  return {
    ...actor,
    payment: {
      x402Version: 2,
      accepted: {
        scheme: "exact",
        network: "eip155:8453",
        amount: "2000",
        asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        payTo: "0x769900f8faad0000000000000000000000000001",
        maxTimeoutSeconds: 60,
      },
      payload: {
        signature: `0x${"cd".repeat(65)}`,
        authorization: {
          from: "0x857B06519E91E3A54538791BDBB0E22373E36B66",
          to: "0x769900f8faad0000000000000000000000000001",
          value: "2000",
          validAfter: "0",
          validBefore: "9999999999",
          nonce: `0x${"ef".repeat(32)}`,
        },
      },
    },
    paymentTransport: "http",
  };
}

const kernel = createKernel(stubPorts());

describe("resolveAccess — servability and identity rows", () => {
  it("a non-published post is 404 for everyone but its author", async () => {
    const draft = { ...GATED, status: "draft" as const };
    const decision = await kernel.resolveAccess(draft, HUMAN);
    expect(decision).toMatchObject({
      allow: false,
      reason: "not_published",
      httpStatus: 404,
      bodyKind: "empty",
    });

    const asAuthor = await kernel.resolveAccess(draft, {
      ...HUMAN,
      userId: draft.authorUserId,
    });
    expect(asAuthor.allow).toBe(true);
    expect(asAuthor.allow && asAuthor.reason).toBe("owner");
  });

  it("the author (and their delegated agent) reads free as 'owner'", async () => {
    const decision = await kernel.resolveAccess(GATED, {
      ...HUMAN,
      userId: GATED.authorUserId,
    });
    expect(decision).toMatchObject({ allow: true, reason: "owner", bodyKind: "full" });
    expect(decision.cache.shared).toBe(false);
  });

  it("a blocked agent gets 403 with an empty body, never a teaser", async () => {
    const blocked = createKernel(stubPorts({ blocked: true }));
    const decision = await blocked.resolveAccess(HFAP, AGENT);
    expect(decision).toMatchObject({
      allow: false,
      reason: "blocked_agent",
      httpStatus: 403,
      bodyKind: "empty",
    });
  });
});

describe("resolveAccess — free mode", () => {
  it("both planes get full, public, cacheable", async () => {
    for (const actor of [HUMAN, AGENT]) {
      const d = await kernel.resolveAccess(FREE, actor);
      expect(d).toMatchObject({ allow: true, reason: "mode_free", bodyKind: "full" });
      expect(d.cache.shared).toBe(true);
      expect(d.cache.vary).toEqual(["Accept", "Accept-Encoding"]);
    }
  });
});

describe("resolveAccess — human_free_agent_paid", () => {
  it("human plane gets full with Vary: Signature-Agent", async () => {
    const d = await kernel.resolveAccess(HFAP, HUMAN);
    expect(d).toMatchObject({ allow: true, reason: "human_plane", bodyKind: "full" });
    expect(d.cache.vary).toContain("Signature-Agent");
  });

  it("agent with a live grant gets full as grant_held", async () => {
    const held = createKernel(stubPorts({ heldGrant: { id: "g-1", settlementId: "set-9" } }));
    const d = await held.resolveAccess(HFAP, AGENT);
    expect(d).toMatchObject({
      allow: true,
      reason: "grant_held",
      bodyKind: "full",
      grantId: "g-1",
      settlementId: "set-9",
    });
    expect(d.cache.shared).toBe(false);
  });

  it("agent with no grant and no payment gets a 402 preview with a challenge", async () => {
    const d = await kernel.resolveAccess(HFAP, AGENT);
    expect(d).toMatchObject({
      allow: false,
      reason: "payment_required",
      httpStatus: 402,
      bodyKind: "preview",
    });
    if (!d.allow) {
      expect(d.challenge).not.toBeNull();
      expect(d.challenge?.x402Version).toBe(2);
      expect(d.challenge?.accepts[0]?.amount).toBe("2000");
    }
  });

  it("agent who settles gets settled_now and a durable grant is minted", async () => {
    const logEvents: Array<Record<string, unknown>> = [];
    const kernel2 = createKernel(stubPorts({ logEvents }));
    const d = await kernel2.resolveAccess(HFAP, paying(AGENT));
    expect(d).toMatchObject({ allow: true, reason: "settled_now", bodyKind: "full" });
    if (d.allow) {
      expect(d.grantId).toMatch(/^grant-/);
      expect(d.settlementId).toMatch(/^set-/);
    }
  });
});

describe("resolveAccess — x402_always", () => {
  it("human with no payment gets a 402 preview", async () => {
    const d = await kernel.resolveAccess(GATED, HUMAN);
    expect(d).toMatchObject({
      allow: false,
      reason: "payment_required",
      httpStatus: 402,
      bodyKind: "preview",
    });
  });

  it("a paying human settles but mints NO grant", async () => {
    const d = await kernel.resolveAccess(GATED, paying(HUMAN));
    expect(d).toMatchObject({ allow: true, reason: "settled_now", bodyKind: "full" });
    if (d.allow) expect(d.grantId).toBeNull();
  });
});

describe("resolveAccess — settle outcome branches", () => {
  const outcomes = [
    ["in_flight", { kind: "in_flight" }, "replay_in_flight", 409],
    ["consumed", { kind: "consumed" }, "authorization_consumed", 402],
    ["quote_expired", { kind: "quote_expired" }, "quote_expired", 402],
    [
      "quote_mismatch",
      { kind: "quote_mismatch", detail: "amount drifted" },
      "quote_mismatch",
      402,
    ],
    ["invalid", { kind: "invalid", invalidReason: "bad sig" }, "payment_invalid", 402],
    ["unavailable", { kind: "unavailable" }, "facilitator_unavailable", 503],
  ] as const;

  for (const [name, settle, reason, status] of outcomes) {
    it(`${name} -> ${reason} ${status}`, async () => {
      const k = createKernel(stubPorts({ settle }));
      const d = await k.resolveAccess(GATED, paying(AGENT));
      expect(d).toMatchObject({ allow: false, reason, httpStatus: status });
      if (!d.allow && status === 402) expect(d.challenge).not.toBeNull();
    });
  }

  it("idempotent -> idempotent_replay 200 full", async () => {
    const k = createKernel(
      stubPorts({
        settle: {
          kind: "idempotent",
          settlementId: "set-77",
          payer: "0x857b06519e91e3a54538791bdbb0e22373e36b66",
          response: {
            success: true,
            transaction: `0x${"ab".repeat(32)}`,
            network: "eip155:8453",
          },
        },
      }),
    );
    const d = await k.resolveAccess(GATED, paying(AGENT));
    expect(d).toMatchObject({ allow: true, reason: "idempotent_replay", bodyKind: "full" });
  });
});

describe("resolveAccess — mode kill switches", () => {
  it("mode 'off' serves mode_free with private cache", async () => {
    const k = createKernel(stubPorts({ mode: "off" }));
    const d = await k.resolveAccess(GATED, HUMAN);
    expect(d).toMatchObject({ allow: true, reason: "mode_free", bodyKind: "full" });
    expect(d.cache.shared).toBe(false);
  });

  it("mode 'shadow' computes the 402, logs it, serves 200, never settles", async () => {
    const logEvents: Array<Record<string, unknown>> = [];
    const k = createKernel(stubPorts({ mode: "shadow", logEvents }));
    const d = await k.resolveAccess(GATED, paying(HUMAN));
    expect(d).toMatchObject({ allow: true, reason: "mode_free", bodyKind: "full" });
    const shadowLog = logEvents.find((e) => e.msg === "x402 shadow");
    expect(shadowLog).toBeDefined();
    expect(shadowLog?.paymentPresented).toBe(true);
    expect(shadowLog?.wouldCharge).toBe("250000");
  });
});
