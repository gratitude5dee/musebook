// packages/kernel/test/cache.test.ts — the shared-cache rules (§6.13, §6.14).
// Two assertions: decision.cache.shared === false for every non-'free' allow
// reason, and no kernel-produced header map contains CDN-Cache-Control in any
// casing — both CDNs read it, and that is precisely the double-caching bug.
import { describe, expect, it } from "vitest";
import type { AccessDecision } from "@musebook/schema";
import { createKernel } from "../src/index.js";
import { stubPorts } from "./fixtures/ports.js";
import { FREE, HFAP, GATED } from "./fixtures/resources.js";
import { HUMAN, AGENT } from "./fixtures/actors.js";
import type { Actor } from "@musebook/schema";

const REPS = ["html", "markdown", "json", "jsonld", "mcp", "feed"] as const;

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
          from: "0x857b06519e91e3a54538791bdbb0e22373e36b66",
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

describe("shared-cache assertions", () => {
  it("cache.shared === false for every non-free allow reason", async () => {
    const kernel = createKernel(stubPorts());
    const decisions: AccessDecision[] = [
      // settled_now (x402_always, paying human) — no grant minted, still private
      await kernel.resolveAccess(GATED, paying(HUMAN)),
      // settled_now + grant minted (hfap, paying agent)
      await kernel.resolveAccess(HFAP, paying(AGENT)),
      // owner — the author reads private too
      await kernel.resolveAccess(FREE, { ...HUMAN, userId: FREE.authorUserId }),
    ];
    // grant_held needs a stub that answers a live grant
    const heldKernel = createKernel(
      stubPorts({ heldGrant: { id: "g-1", settlementId: "set-0" } }),
    );
    decisions.push(await heldKernel.resolveAccess(HFAP, AGENT));
    // idempotent_replay
    const idemKernel = createKernel(
      stubPorts({
        settle: {
          kind: "idempotent",
          settlementId: "set-0",
          payer: "0x857b06519e91e3a54538791bdbb0e22373e36b66",
          response: { success: true, transaction: `0x${"ab".repeat(32)}`, network: "eip155:8453" },
        },
      }),
    );
    decisions.push(await idemKernel.resolveAccess(HFAP, paying(AGENT)));

    const reasons = decisions.map((d) => (d.allow ? d.reason : "!"));
    expect(reasons.sort()).toEqual(
      ["grant_held", "idempotent_replay", "owner", "settled_now", "settled_now"].sort(),
    );
    for (const d of decisions) {
      expect(d.allow).toBe(true);
      expect(d.cache.shared).toBe(false);
      expect(d.cache.cacheControl).toContain("private");
    }
  });

  it("hfap human is the only public+Vary: Signature-Agent allow reason", async () => {
    const kernel = createKernel(stubPorts());
    const decision = await kernel.resolveAccess(HFAP, HUMAN);
    expect(decision.allow).toBe(true);
    expect(decision.cache.shared).toBe(true);
    expect(decision.cache.vary).toEqual(["Accept", "Accept-Encoding", "Signature-Agent"]);
  });

  it("no kernel header map contains CDN-Cache-Control in any casing", async () => {
    const kernel = createKernel(stubPorts());
    for (const resource of [FREE, HFAP, GATED]) {
      for (const actor of [HUMAN, AGENT]) {
        const decision = await kernel.resolveAccess(resource, actor);
        for (const rep of REPS) {
          const rendered = await kernel.renderResource(resource, rep, decision);
          for (const key of Object.keys(rendered.headers)) {
            expect(key.toLowerCase()).not.toBe("cdn-cache-control");
          }
        }
      }
    }
  });
});
