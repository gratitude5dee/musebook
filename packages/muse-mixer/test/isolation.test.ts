// packages/muse-mixer/test/isolation.test.ts
import { describe, expect, it } from "vitest";
import { MuseScorer } from "../src/muse/scorers/muse_scorer.js";
import { RankingScorer } from "../src/muse/scorers/ranking_scorer.js";
import { WatchTimeScorer } from "../src/muse/scorers/watch_time_scorer.js";
import {
  HeuristicMuseRanker,
  HEURISTIC_V1_COEFFICIENTS,
} from "../src/muse/rankers/heuristic.js";
import { LearnedMuseRanker } from "../src/muse/rankers/learned.js";
import { memoryCtx, memoryWeightsLoader } from "../src/adapters/memory/index.js";
import { makeQuery, makeCandidate } from "./factories.js";
import type { MuseCandidate } from "../src/muse/candidate.js";
import type { PerCandidate } from "../src/framework/types.js";

/** Scorers may return SKIP; the harness never expects it here. */
function fields(r: PerCandidate<MuseCandidate>): Partial<MuseCandidate> {
  if (typeof r === "symbol") throw new Error("scorer returned SKIP in an isolation fixture");
  return r;
}

describe("candidate isolation (spine invariant 2)", () => {
  // WatchTimeScorer is in this list on purpose: it is the newest scorer, it is the
  // one most tempting to write as "normalize watch time across the slate", and that
  // is exactly the bug this gate exists to stop.
  const stages = [
    new MuseScorer(new HeuristicMuseRanker()),
    // The learned ranker is a second MuseScorer stage, not a new scorer shape —
    // G-ISO must hold for the model that shadow week promotes (§16 M15.5).
    new MuseScorer(new LearnedMuseRanker("v1.model-learned", HEURISTIC_V1_COEFFICIENTS)),
    new RankingScorer(memoryWeightsLoader()),
    new WatchTimeScorer(),
  ] as const;

  it("produces bit-identical scores alone and in a batch of 200", async () => {
    const ctx = memoryCtx();
    const query = makeQuery({ viewerId: "v-1", actionCount: 420, surface: "reels" });
    const batch: MuseCandidate[] = Array.from({ length: 200 }, (_, i) =>
      makeCandidate({ postId: `p-${String(i).padStart(3, "0")}`, kind: "video" }),
    );
    const subject = batch[137];

    for (const stage of stages) {
      // 1. score the subject entirely alone
      const solo = structuredClone(subject);
      const soloOut = fields((await stage.score(query, [solo], ctx))[0]);

      // 2. score the identical candidate inside a batch of 200
      const crowd = batch.map((c) => structuredClone(c));
      const crowdOut = fields((await stage.score(query, crowd, ctx))[137]);

      // bit-identical, not approximately equal: any batch-dependent term shows up here
      expect(Object.is(crowdOut.weightedScore, soloOut.weightedScore)).toBe(true);
      expect(Object.is(crowdOut.score, soloOut.score)).toBe(true);
      expect(crowdOut.actionScores).toStrictEqual(soloOut.actionScores);
      expect(crowdOut.continuousPreds).toStrictEqual(soloOut.continuousPreds);

      // apply so the next stage in the chain sees the same inputs in both runs
      Object.assign(solo, soloOut);
      Object.assign(crowd[137], crowdOut);
    }
  });

  it("is invariant to the position of the candidate within the batch", async () => {
    const ctx = memoryCtx();
    const query = makeQuery({ viewerId: "v-1", actionCount: 420 });
    const subject = makeCandidate({ postId: "p-subject" });
    const filler = Array.from({ length: 199 }, (_, i) => makeCandidate({ postId: `f-${i}` }));
    const scorer = new MuseScorer(new HeuristicMuseRanker());

    const scores: number[] = [];
    for (const at of [0, 1, 99, 198, 199]) {
      const batch = [...filler];
      batch.splice(at, 0, structuredClone(subject));
      const out = fields((await scorer.score(query, batch, ctx))[at]);
      const view = out.actionScores?.view;
      expect(view).toBeTypeOf("number");
      scores.push(view as number);
    }
    expect(new Set(scores).size).toBe(1);
  });

  it("is invariant to batch SIZE", async () => {
    const ctx = memoryCtx();
    const query = makeQuery({ viewerId: "v-1", actionCount: 420 });
    const scorer = new MuseScorer(new HeuristicMuseRanker());
    const subject = makeCandidate({ postId: "p-subject" });

    const results: number[] = [];
    for (const n of [1, 2, 17, 64, 65, 400]) {
      const batch = [
        structuredClone(subject),
        ...Array.from({ length: n - 1 }, (_, i) => makeCandidate({ postId: `f-${i}` })),
      ];
      const out = fields((await scorer.score(query, batch, ctx))[0]);
      results.push(out.weightedScore ?? Number.NaN);
    }
    expect(new Set(results).size).toBe(1); // catches per-chunk normalization at the 64 boundary
  });

  it("is invariant to the warm start (§9.11)", async () => {
    // A reused actionScores row from a previous slate must produce the same
    // weightedScore as a freshly computed one, or page 2 disagrees with page 1
    // for reasons no cursor can explain.
    const ctx = memoryCtx();
    const query = makeQuery({ viewerId: "v-1", actionCount: 420 });
    const scorer = new MuseScorer(new HeuristicMuseRanker());
    const c = makeCandidate({ postId: "p-warm" });
    const cold = fields((await scorer.score(query, [structuredClone(c)], ctx))[0]);
    const warmed = Object.assign(structuredClone(c), cold);
    const warm = fields((await scorer.score(query, [warmed], ctx))[0]);
    expect(warm.actionScores).toStrictEqual(cold.actionScores);
  });
});
