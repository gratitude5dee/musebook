// packages/ui/test/webgl-budget.test.ts — §11.16's MAX_LIVE_CONTEXTS = 2 gate.
import { describe, expect, it } from "vitest";
import { acquireWebglSlot, MAX_LIVE_CONTEXTS, releaseWebglSlot } from "../src/webglBudget";

describe("webglBudget", () => {
  it("MAX_LIVE_CONTEXTS is exactly 2", () => {
    expect(MAX_LIVE_CONTEXTS).toBe(2);
  });

  it("a third acquire returns false while two are held, true after a release", () => {
    expect(acquireWebglSlot("a")).toBe(true);
    expect(acquireWebglSlot("b")).toBe(true);
    expect(acquireWebglSlot("c")).toBe(false);
    releaseWebglSlot("a");
    expect(acquireWebglSlot("c")).toBe(true);
    releaseWebglSlot("b");
    releaseWebglSlot("c");
  });

  it("re-acquiring a held slot is a no-op, not a new slot", () => {
    expect(acquireWebglSlot("x")).toBe(true);
    expect(acquireWebglSlot("x")).toBe(true);
    expect(acquireWebglSlot("y")).toBe(true);
    expect(acquireWebglSlot("z")).toBe(false);
    releaseWebglSlot("x");
    releaseWebglSlot("y");
    releaseWebglSlot("z");
  });
});
