// packages/muse-mixer/test/isolation-bites.test.ts
// §17.5: proves the isolation gate can fail. A scorer that reads ANY batch-level
// state — here, the batch's own mean likes — produces a different per-candidate
// output alone than inside a batch. If this test ever passes vacuously, the gate
// above it is broken, not the detector.
import { describe, expect, it } from "vitest";
import type { ExecCtx, PerCandidate, Scorer } from "../src/framework/types.js";
import { memoryCtx } from "../src/adapters/memory/index.js";
import { makeQuery, makeCandidate } from "./factories.js";
import type { MuseCandidate } from "../src/muse/candidate.js";
import type { MuseFeedQuery } from "../src/muse/query.js";

function fields(r: PerCandidate<MuseCandidate>): Partial<MuseCandidate> {
  if (typeof r === "symbol") throw new Error("scorer returned SKIP in an isolation fixture");
  return r;
}

/** DELIBERATELY CONTAMINATED: the bug the merge gate exists to catch. */
class ContaminatedScorer implements Scorer<MuseFeedQuery, MuseCandidate> {
  readonly name = "ContaminatedScorer";
  async score(
    _q: MuseFeedQuery,
    candidates: readonly MuseCandidate[],
    _ctx: ExecCtx,
  ): Promise<Array<PerCandidate<MuseCandidate>>> {
    // Reads cross-candidate state: the batch's mean like count.
    const total = candidates.reduce((s, c) => s + (c.counters?.likes ?? 0), 0);
    const mean = total / candidates.length;
    return candidates.map((c) => ({
      weightedScore: (c.counters?.likes ?? 0) - mean,
    }));
  }
}

describe("isolation-bites (the detector itself)", () => {
  it("detects a scorer that reads across the batch", async () => {
    const ctx = memoryCtx();
    const query = makeQuery({ viewerId: "v-1", actionCount: 420 });
    const scorer = new ContaminatedScorer();
    const subject = makeCandidate({
      postId: "p-subject",
      counters: {
        impressions: 1,
        opens: 0,
        likes: 50,
        comments: 0,
        reposts: 0,
        bookmarks: 0,
        paidFetches: 0,
        dwellMsTotal: 0,
      },
    });

    const soloOut = fields((await scorer.score(query, [structuredClone(subject)], ctx))[0]);
    const batch = [
      structuredClone(subject),
      makeCandidate({
        postId: "other",
        counters: {
          impressions: 1,
          opens: 0,
          likes: 10,
          comments: 0,
          reposts: 0,
          bookmarks: 0,
          paidFetches: 0,
          dwellMsTotal: 0,
        },
      }),
    ];
    const crowdOut = fields((await scorer.score(query, batch, ctx))[0]);

    // Contaminated: solo sees mean=50 (only itself), batch sees mean=30.
    expect(crowdOut.weightedScore).not.toBe(soloOut.weightedScore);
  });
});
