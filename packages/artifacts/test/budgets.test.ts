// packages/artifacts/test/budgets.test.ts — M16 gate 3: an over-budget GLB
// is refused at ingest with the number reported, and no silent down-res.
import { describe, expect, it } from "vitest";
import { BUDGETS, BudgetError, enforceBudget, type SceneMetrics } from "../src/budgets";

const metrics = (over: Partial<SceneMetrics>): SceneMetrics => ({
  triangles: 0,
  textureBytes: 0,
  drawCallEstimate: 0,
  fileBytes: 0,
  ...over,
});

describe("enforceBudget (M16.3)", () => {
  it.each(["feed", "fullscreen", "mobile"] as const)("refuses %s one triangle over", (tier) => {
    const over = BUDGETS[tier].maxTriangles + 1;
    try {
      enforceBudget(tier, metrics({ triangles: over }));
      expect.unreachable("over-budget scene must throw");
    } catch (e) {
      expect(e).toBeInstanceOf(BudgetError);
      const err = e as BudgetError;
      expect(err.code).toBe("too_many_triangles");
      // The creator is told the number, not just that it failed.
      expect(err.measured).toBe(over);
      expect(err.limit).toBe(BUDGETS[tier].maxTriangles);
    }
  });

  it.each(["feed", "fullscreen", "mobile"] as const)("passes %s at the ceiling", (tier) => {
    expect(() =>
      enforceBudget(
        tier,
        metrics({
          triangles: BUDGETS[tier].maxTriangles,
          textureBytes: BUDGETS[tier].maxTextureBytes,
          drawCallEstimate: BUDGETS[tier].maxDrawCalls,
          fileBytes: BUDGETS[tier].maxFileBytes,
        }),
      ),
    ).not.toThrow();
  });

  it("refuses oversized textures with the byte count reported", () => {
    const over = BUDGETS.feed.maxTextureBytes + 1;
    const err = (() => {
      try {
        enforceBudget("feed", metrics({ textureBytes: over }));
      } catch (e) {
        return e as BudgetError;
      }
      throw new Error("expected BudgetError");
    })();
    expect(err.code).toBe("textures_too_large");
    expect(err.measured).toBe(over);
  });
});
