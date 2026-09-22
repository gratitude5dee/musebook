// packages/kernel/test/projections.test.ts — the projection surface (§6.3, §14.1).
// Code outside the kernel that needs an answer depending on publish_mode calls
// one of these — never the column.
import { describe, expect, it } from "vitest";
import {
  accessToPublishMode,
  formatPriceUsd,
  loadResource,
  mintsDurableGrant,
  pricingLineFor,
  toAccessBadge,
  variantIntentFor,
  configureKernel,
} from "../src/index.js";
import { stubPorts } from "./fixtures/ports.js";
import { FREE, FREE_ROW, HFAP, GATED, GATED_ROW } from "./fixtures/resources.js";

describe("mintsDurableGrant", () => {
  it("is true only for human_free_agent_paid", () => {
    expect(mintsDurableGrant(FREE)).toBe(false);
    expect(mintsDurableGrant(HFAP)).toBe(true);
    expect(mintsDurableGrant(GATED)).toBe(false);
  });
});

describe("accessToPublishMode", () => {
  it("maps the three badge kinds exhaustively", () => {
    expect(accessToPublishMode("open")).toBe("free");
    expect(accessToPublishMode("toll")).toBe("human_free_agent_paid");
    expect(accessToPublishMode("gated")).toBe("x402_always");
  });
});

describe("pricingLineFor", () => {
  it("emits the three literal lines", () => {
    expect(pricingLineFor(FREE)).toBe("Free for humans and agents.");
    expect(pricingLineFor(HFAP)).toBe(
      "Free for humans. Agents: 0.00 USDC once per content_hash (x402, eip155:8453).",
    );
    expect(pricingLineFor(GATED)).toBe("0.25 USDC per fetch, human or agent (x402, eip155:8453).");
  });
});

describe("toAccessBadge", () => {
  it("maps modes to badge kinds with the §14.1 rules", () => {
    expect(toAccessBadge(FREE)).toEqual({
      kind: "open",
      rule: "Free for everyone, human and machine.",
    });
    expect(toAccessBadge(HFAP)).toEqual({
      kind: "toll",
      priceUsd: "0.00",
      rule: "Free for people. Agents pay once to crawl it.",
    });
    expect(toAccessBadge(GATED)).toEqual({
      kind: "gated",
      priceUsd: "0.25",
      rule: "Every read is paid, human or agent.",
    });
  });
});

describe("variantIntentFor", () => {
  it("returns 'teaser' only for x402_always; 'full' otherwise", async () => {
    configureKernel(stubPorts());
    expect(await variantIntentFor(FREE_ROW.post_id)).toBe("full");
    expect(await variantIntentFor(GATED_ROW.post_id)).toBe("teaser");
  });

  it("throws on an unknown post", async () => {
    configureKernel(stubPorts());
    await expect(variantIntentFor("00000000-0000-4000-8000-ffffffffffff")).rejects.toThrow(
      "no live post",
    );
  });
});

describe("formatPriceUsd", () => {
  it("formats atomic units to a fixed two-place string", () => {
    expect(formatPriceUsd("0", 6)).toBe("0.00");
    expect(formatPriceUsd("2000", 6)).toBe("0.00"); // rounds half-up on the third place
    expect(formatPriceUsd("250000", 6)).toBe("0.25");
    expect(formatPriceUsd("255000", 6)).toBe("0.26"); // half-up rounds up
    expect(formatPriceUsd("9999", 6)).toBe("0.01");
    expect(formatPriceUsd("100000000", 6)).toBe("100.00");
  });
});

describe("loadResource", () => {
  it("is the single snake_case -> camelCase boundary", () => {
    const r = loadResource(GATED_ROW);
    expect(r.postId).toBe(GATED_ROW.post_id);
    expect(r.authorHandle).toBe(GATED_ROW.author_handle);
    expect(r.publishMode).toBe("x402_always");
    expect(r.trainAi).toBe(false);
  });

  it("derives priceUsd: null when atomic is '0', formatted otherwise", () => {
    expect(loadResource(FREE_ROW).priceUsd).toBeNull();
    expect(loadResource(GATED_ROW).priceUsd).toBe("0.25");
    expect(loadResource({ ...GATED_ROW, price_atomic: "2000" }).priceUsd).toBe("0.00");
  });
});
