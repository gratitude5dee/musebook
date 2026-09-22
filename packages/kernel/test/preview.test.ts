// packages/kernel/test/preview.test.ts — deterministic teaser (§6.13).
// 1,000 generated bodies: same input -> same bytes, forever; and a fenced code
// block is never split.
import { describe, expect, it } from "vitest";
import { previewOf } from "../src/render/preview.js";

const SENTINEL = "<!-- musebook:paywall -->";

/** A deterministic pseudo-random block generator — xorshift, no Date/Math.random. */
function* blocks(seed: number, n: number): Generator<string> {
  let s = seed || 1;
  for (let i = 0; i < n; i += 1) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    yield `block ${i} of ${(s >>> 0) % 997} characters ${"x".repeat((s >>> 0) % 120)}`;
  }
}

describe("previewOf determinism", () => {
  it("1,000 generated bodies render byte-identically on a second pass", () => {
    for (let i = 0; i < 1000; i += 1) {
      const md = [...blocks(i + 1, 2 + (i % 6))].join("\n\n");
      expect(previewOf(md, 400)).toBe(previewOf(md, 400));
    }
  });

  it("never splits a fenced code block", () => {
    const fence = "```ts\nconst a = 1;\nconst b = 2;\nconst c = 3;\n```";
    const md = `intro paragraph\n\n${fence}\n\ntail block`;
    const preview = previewOf(md, 30); // the fence alone exceeds maxChars after intro
    expect(preview).not.toContain("const c = 3;");
    // the fence is indivisible: either whole or absent — and absent here
    expect(preview).not.toContain("const a = 1;");
    expect(preview).toContain("intro paragraph");
    expect(preview).toContain(SENTINEL);
  });

  it("always returns at least the first block, even when it exceeds maxChars", () => {
    const big = "x".repeat(900);
    const preview = previewOf(`${big}\n\nsecond block`, 50);
    expect(preview).toContain(big);
    expect(preview.endsWith(SENTINEL)).toBe(true);
  });

  it("ends with the paywall sentinel and nothing after it", () => {
    const preview = previewOf("one\n\ntwo\n\nthree", 400);
    expect(preview).toBe(`one\n\ntwo\n\nthree\n\n${SENTINEL}`);
  });

  it("strips front matter before taking blocks", () => {
    const md = "---\ntitle: x\n---\nreal first block\n\nsecond";
    const preview = previewOf(md, 400);
    expect(preview).toContain("real first block");
    expect(preview).not.toContain("title: x");
  });

  it("returns the empty string for an empty body", () => {
    expect(previewOf("", 400)).toBe("");
    expect(previewOf("---\nx: y\n---\n", 400)).toBe("");
  });
});
