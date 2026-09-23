import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { countEffective } from "../src/count";
import { splitIntoThread, truncateTo } from "../src/split";

const OPTS = {
  method: "utf16" as const,
  maxChars: 100,
  urlCountsAsChars: null,
  numberingReserve: 8,
  maxParts: 10,
};

describe("splitIntoThread", () => {
  it("returns a single part when the body fits", () => {
    expect(splitIntoThread("short body", OPTS)).toEqual(["short body"]);
  });

  it("splits on sentence boundaries and appends (i/n) numbering", () => {
    const body =
      "Sentence one is here. Sentence two is here. Sentence three is here. Sentence four is here. Sentence five is here.";
    const parts = splitIntoThread(body, { ...OPTS, maxChars: 60 });
    expect(parts.length).toBeGreaterThan(1);
    parts.forEach((p, i) => {
      expect(p.endsWith(`(${i + 1}/${parts.length})`)).toBe(true);
      expect(countEffective("utf16", p, null)).toBeLessThanOrEqual(60);
    });
  });

  it("respects maxParts by packing the remainder into the last part", () => {
    const body = Array.from({ length: 40 }, (_, i) => `Sentence ${i} ends.`).join(" ");
    const parts = splitIntoThread(body, { ...OPTS, maxParts: 4 });
    expect(parts.length).toBeLessThanOrEqual(4);
  });

  it("property: every emitted part is within budget incl. numbering", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 800 }), (s) => {
        const parts = splitIntoThread(s, { ...OPTS, maxChars: 80, maxParts: 25 });
        return parts.every((p) => countEffective("utf16", p, null) <= 80);
      }),
      { numRuns: 200 },
    );
  });
});

describe("truncateTo", () => {
  it("cuts at a word boundary and appends the suffix", () => {
    const t = truncateTo("alpha beta gamma delta epsilon", { ...OPTS, maxChars: 20 }, "…");
    expect(countEffective("utf16", t, null)).toBeLessThanOrEqual(20);
    expect(t.endsWith("…")).toBe(true);
  });

  it("keeps a required suffix (the canonical URL) within budget", () => {
    const url = " https://musebook.dev/p/x";
    const t = truncateTo("word ".repeat(80), { ...OPTS, maxChars: 60 }, url);
    expect(t.endsWith(url)).toBe(true);
    expect(countEffective("utf16", t, null)).toBeLessThanOrEqual(60);
  });
});
