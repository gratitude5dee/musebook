// packages/muse-mixer/test/weights.test.ts
// Weight-cohort + three-score-discipline tests (§9.12, M13 check 7).
import { describe, expect, it } from "vitest";
import { MUSE_ACTIONS, MUSE_CONTINUOUS, MUSE_NEGATIVE_ACTIONS } from "../src/muse/actions.js";
import { cohortCandidates, cohortKeyFor } from "../src/muse/weights.js";
import { RankingScorer } from "../src/muse/scorers/ranking_scorer.js";
import {
  memoryActionWeights,
  memoryCtx,
  memoryWeightsLoader,
} from "../src/adapters/memory/index.js";
import { makeCandidate, makeQuery } from "./factories.js";

describe("MUSE_ACTIONS parity (§9.9 migration enum)", () => {
  it("has exactly 23 values in the documented order", () => {
    expect(MUSE_ACTIONS).toStrictEqual([
      "impression",
      "view",
      "dwell",
      "play",
      "play_through",
      "like",
      "comment",
      "repost",
      "bookmark",
      "share",
      "follow",
      "remix",
      "fork_app",
      "install_app",
      "tip",
      "x402_pay",
      "agent_crawl",
      "agent_cite",
      "not_interested",
      "mute_creator",
      "block_creator",
      "report",
      "not_dwelled",
    ]);
  });
  it("negative and continuous subsets are consistent", () => {
    expect(MUSE_NEGATIVE_ACTIONS).toStrictEqual([
      "not_interested",
      "mute_creator",
      "block_creator",
      "report",
      "not_dwelled",
    ]);
    expect(MUSE_CONTINUOUS).toStrictEqual([
      "dwell_time_s",
      "watch_time_ms",
      "scroll_depth",
      "active_seconds_5m",
      "tip_amount_usdc",
    ]);
  });
});

describe("cohort resolution (§9.12)", () => {
  it("orders exp:<bucket> first, default last", () => {
    const cands = cohortCandidates(
      cohortKeyFor(makeQuery({ weightsVersion: "v1", slateId: "slate-exp" }), memoryCtx()),
    );
    expect(cands[0]).toMatch(/^exp:b\d+$/);
    expect(cands[cands.length - 1]).toBe("default");
    expect(cands).toContain("surface:home");
  });
  it("same slateId always lands in the same exp bucket", () => {
    const a = cohortKeyFor(makeQuery({ weightsVersion: "v1", slateId: "stable-id" }), memoryCtx());
    const b = cohortKeyFor(makeQuery({ weightsVersion: "v1", slateId: "stable-id" }), memoryCtx());
    expect(a.experimentBucket).toBe(b.experimentBucket);
  });
  it("agent viewers get the agent cohort candidate", () => {
    const cands = cohortCandidates(
      cohortKeyFor(makeQuery({ weightsVersion: "v1", viewerKind: "agent" }), memoryCtx()),
    );
    expect(cands).toContain("agent");
  });
  it("new users (ranker threshold) get the newuser cohort", () => {
    const cands = cohortCandidates(
      cohortKeyFor(makeQuery({ weightsVersion: "v1", actionCount: 2 }), memoryCtx()),
    );
    expect(cands).toContain("newuser");
  });
  it("country codes land when present", () => {
    const cands = cohortCandidates(
      cohortKeyFor(makeQuery({ weightsVersion: "v1", countryCode: "US" }), memoryCtx()),
    );
    expect(cands).toContain("country:US");
  });
});

describe("weight changes change the slate without a deploy (§9.11)", () => {
  it("flipping one β reorders the output", async () => {
    const q = makeQuery({ weightsVersion: "v1", actionCount: 100 });
    const a = makeCandidate({
      postId: "heavy-a",
      counters: {
        impressions: 1,
        opens: 0,
        likes: 0,
        comments: 0,
        reposts: 0,
        bookmarks: 0,
        paidFetches: 0,
        dwellMsTotal: 0,
      },
    });
    const b = makeCandidate({
      postId: "heavy-b",
      counters: {
        impressions: 1,
        opens: 0,
        likes: 0,
        comments: 0,
        reposts: 0,
        bookmarks: 0,
        paidFetches: 0,
        dwellMsTotal: 0,
      },
    });

    // First pass: identical actionScores → weightedScore ties → postId order.
    const base = memoryActionWeights();
    const scorer1 = new RankingScorer(memoryWeightsLoader(base));
    const cands1 = [
      { ...a, actionScores: { view: 0.5 }, contentHash: "h1" },
      { ...b, actionScores: { view: 0.5 }, contentHash: "h2" },
    ];
    const out1 = await scorer1.score(q, cands1 as any, memoryCtx());
    cands1.forEach((c, i) => Object.assign(c, out1[i]));

    // Second pass: bump `view` to 10000 — same request, different weights row.
    const boosted = memoryActionWeights();
    boosted.version = "v1.tuned";
    boosted.discrete.view = 10000;
    boosted.totalSum += 10000;
    const scorer2 = new RankingScorer(memoryWeightsLoader(boosted));
    const cands2 = [
      { ...a, actionScores: { view: 0.5 }, contentHash: "h1" },
      { ...b, actionScores: { view: 0.5 }, contentHash: "h2" },
    ];
    const out2 = await scorer2.score(q, cands2 as any, memoryCtx());
    cands2.forEach((c, i) => Object.assign(c, out2[i]));

    expect(cands2[0].weightedScore).not.toBe(cands1[0].weightedScore);
    expect(cands2[0].weightsVersion).not.toBe(cands1[0].weightsVersion);
  });

  it("weights_version stamped on each candidate differs per weights row", async () => {
    const q = makeQuery({ weightsVersion: "v1" });
    const w1 = memoryActionWeights({ version: "v1", cohort: "default" });
    const w2 = memoryActionWeights({ version: "v1.tuned", cohort: "default" });
    const s1 = new RankingScorer(memoryWeightsLoader(w1));
    const s2 = new RankingScorer(memoryWeightsLoader(w2));
    const c1 = [makeCandidate({ postId: "p1", actionScores: { view: 0.1 }, contentHash: "ch1" })];
    const c2 = [makeCandidate({ postId: "p1", actionScores: { view: 0.1 }, contentHash: "ch1" })];
    Object.assign(c1[0], (await s1.score(q, c1 as any, memoryCtx()))[0]);
    Object.assign(c2[0], (await s2.score(q, c2 as any, memoryCtx()))[0]);
    expect(c1[0].weightsVersion).toBe("v1/default");
    expect(c2[0].weightsVersion).toBe("v1.tuned/default");
  });
});
