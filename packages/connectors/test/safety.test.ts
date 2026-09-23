// safety.test.ts — §10.12 checks 10 (zero-width fuzz → sanitized bytes) +
// 14-adjacent (reputation EMA) + crypto round-trip.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { sanitizeAgentText, wrapUntrusted } from "../src/safety/untrusted.js";
import { nextReputation } from "../src/safety/reputation.js";
import { sealCredential, openCredential } from "../src/crypto.js";

const ZERO_WIDTH = ["​", "‌", "‍", "⁠", "﻿", "‪", "‮"];

describe("sanitizeAgentText", () => {
  it("strips zero-width and bidi characters (check 10)", () => {
    for (const zw of ZERO_WIDTH) {
      expect(sanitizeAgentText(`hello${zw}world`)).toBe("helloworld");
    }
    expect(sanitizeAgentText("​‌‍⁠﻿")).toBe("");
  });

  it("the hash input is over sanitized bytes — fuzzed", () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const out = sanitizeAgentText(raw);
        // No invisible or control codepoint survives.
        for (const ch of out) {
          const cp = ch.codePointAt(0) ?? 0;
          const isCtl = (cp < 0x20 && ch !== "\t" && ch !== "\n") || (cp >= 0x7f && cp <= 0x9f);
          expect(isCtl).toBe(false);
        }
        return true;
      }),
      { numRuns: 500 },
    );
  });

  it("enforces the length cap", () => {
    expect(sanitizeAgentText("x".repeat(30_000))).toHaveLength(20_000);
    expect(sanitizeAgentText("x".repeat(30_000), 100)).toHaveLength(100);
  });

  it("keeps ordinary markdown intact", () => {
    const md = "# Title\n\n- a **bold** claim about https://musebook.dev\n";
    expect(sanitizeAgentText(md)).toBe(md);
  });
});

describe("wrapUntrusted", () => {
  it("wraps in a delimited untrusted block with escaped attributes", () => {
    const out = wrapUntrusted("agent <b>content</b>", {
      source: "mcp",
      connector: 'evil"onload="x',
      delegation: "del-1",
    });
    expect(out).toContain("<untrusted-content");
    expect(out).toContain('source="mcp"');
    expect(out).toContain('connector="evil&#34;onload=&#34;x"');
    expect(out).toContain("agent <b>content</b>");
    expect(out).toContain("</untrusted-content>");
  });
});

describe("seal/open credential", () => {
  const KEK = new Uint8Array(32).fill(7);

  it("round-trips and refuses tampering", async () => {
    const { ciphertext, keyId } = await sealCredential(
      KEK,
      "k1",
      "del-1",
      "SEED_CONNECTOR_CREDENTIAL",
    );
    expect(ciphertext.byteLength).toBeGreaterThan(29);
    expect(keyId).toBe("k1");
    expect(await openCredential(KEK, "del-1", ciphertext)).toBe("SEED_CONNECTOR_CREDENTIAL");
    const tampered = new Uint8Array(ciphertext);
    tampered[tampered.length - 1] ^= 1;
    await expect(openCredential(KEK, "del-1", tampered)).rejects.toThrow();
  });

  it("binds to the delegation id — another delegation cannot open", async () => {
    const { ciphertext } = await sealCredential(KEK, "k1", "del-1", "token");
    await expect(openCredential(KEK, "del-2", ciphertext)).rejects.toThrow();
  });
});

describe("nextReputation", () => {
  const neutral = {
    previous: 50,
    humanEngagementPer1k: 0,
    forkRate: 0,
    completionRate: 0,
    reportRate: 0,
    approvalRejectionRate: 0,
    safetyBlockRate: 0,
    refundRate: 0,
  };

  it("EMA-smooths: one bad day does not destroy a good agent", () => {
    const good = { ...neutral, humanEngagementPer1k: 1, forkRate: 0.5, completionRate: 0.8 };
    const n = nextReputation(good);
    expect(n).toBeGreaterThan(50);
    expect(n).toBeLessThan(100);
  });

  it("clamps to [0, 100] and decays on bad signals", () => {
    const awful = {
      ...neutral,
      previous: 90,
      reportRate: 1,
      approvalRejectionRate: 1,
      safetyBlockRate: 1,
      refundRate: 1,
      humanEngagementPer1k: -1,
      forkRate: -1,
      completionRate: -1,
    };
    const n = nextReputation(awful);
    expect(n).toBeLessThan(90);
    expect(n).toBeGreaterThanOrEqual(0);
    expect(n).toBeLessThanOrEqual(100);
  });
});
