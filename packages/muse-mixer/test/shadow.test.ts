// packages/muse-mixer/test/shadow.test.ts
import { describe, expect, it } from "vitest";
import type {
  ActionPrediction,
  CandidateFeatures,
  MuseRanker,
  ViewerContext,
} from "../src/muse/scorers/muse_scorer.js";
import type { ShadowScorePoint, TelemetryPort } from "../src/framework/ports.js";
import { shadowScoreEffect } from "../src/muse/sideEffects/index.js";
import { computeWeightedScore } from "../src/muse/scorers/ranking_scorer.js";

import {
  memoryCtx,
  memoryDbHandles,
  memoryWeightsLoader,
  memoryActionWeights,
} from "../src/adapters/memory/index.js";

import { emptySummary } from "../src/framework/summary.js";
import { makeQuery, makeCandidate } from "./factories.js";
import type { MuseCandidate } from "../src/muse/candidate.js";

class FixedRanker implements MuseRanker {
  readonly calls: CandidateFeatures[][] = [];
  constructor(
    readonly modelVersion: string,
    private readonly out: ActionPrediction[],
  ) {}
  predict(_vc: ViewerContext, feats: readonly CandidateFeatures[]): Promise<ActionPrediction[]> {
    this.calls.push([...feats]);
    return Promise.resolve(this.out.slice(0, feats.length));
  }
}

function captureTelemetry(): { port: TelemetryPort; points: ShadowScorePoint[] } {
  const points: ShadowScorePoint[] = [];
  return {
    points,
    port: {
      writeDataPoint() {},
      writeShadowPoint(p) {
        points.push(p);
      },
      insertAgentActions() {
        return Promise.resolve();
      },
    },
  };
}

function effectInput(candidates: MuseCandidate[], surface = "reels") {
  const query = makeQuery({ surface });
  return {
    input: {
      query,
      selected: candidates,
      nonSelected: [],
      removed: [],
      summary: emptySummary("muse-test", Date.now()),
    },
    query,
  };
}

describe("shadowScoreEffect (§9.18)", () => {
  it("emits one point per selected candidate under the shadow's model_version", async () => {
    const { port, points } = captureTelemetry();
    const ctx = memoryCtx({ db: memoryDbHandles({ telemetry: port }) });
    const candidates = [makeCandidate({ postId: "p-1" }), makeCandidate({ postId: "p-2" })];
    const { input, query } = effectInput(candidates);
    const shadow = new FixedRanker("v1.model-learned", [
      { discrete: { like: 0.9 }, continuous: { dwell: 0.4 } },
      { discrete: { like: 0.1 }, continuous: { dwell: 0.1 } },
    ] as ActionPrediction[]);
    const weights = memoryActionWeights();

    await shadowScoreEffect(shadow, memoryWeightsLoader(weights)).run(input, ctx);

    expect(shadow.calls).toHaveLength(1);
    expect(shadow.calls[0]).toHaveLength(2);
    expect(points).toHaveLength(2);
    for (const [i, p] of points.entries()) {
      expect(p.postId).toBe(candidates[i]?.postId);
      expect(p.slateId).toBe(query.slateId);
      expect(p.surface).toBe("reels");
      expect(p.modelVersion).toBe("v1.model-learned");
      expect(p.plane).toBe("human");
      expect(p.position).toBe(i);
      // The shadow's OWN weighted score — its predictions re-weighted by the
      // same ActionWeights — never the incumbent's score relabeled.
      const expected = computeWeightedScore(
        {
          ...candidates[i]!,
          actionScores: { like: i === 0 ? 0.9 : 0.1 },
          continuousPreds: { dwell: i === 0 ? 0.4 : 0.1 },
        },
        query,
        weights,
      );
      expect(p.value).toBe(expected);
    }
  });

  it("serves nothing: it never writes a slate row and skips an empty selection", async () => {
    const { port, points } = captureTelemetry();
    const ctx = memoryCtx({ db: memoryDbHandles({ telemetry: port }) });
    const { input } = effectInput([]);
    const shadow = new FixedRanker("v1.model-learned", []);
    await shadowScoreEffect(shadow, memoryWeightsLoader()).run(input, ctx);
    expect(points).toHaveLength(0);
    expect(shadow.calls).toHaveLength(0);
  });
});
