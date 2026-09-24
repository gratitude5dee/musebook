// packages/muse-mixer/test/learned.test.ts
import { describe, expect, it } from "vitest";
import { HeuristicMuseRanker, HEURISTIC_V1_COEFFICIENTS } from "../src/muse/rankers/heuristic.js";
import { LearnedMuseRanker } from "../src/muse/rankers/learned.js";
import {
  MuseScorer,
  candidateFeatures,
  viewerContextFor,
} from "../src/muse/scorers/muse_scorer.js";
import { memoryCtx } from "../src/adapters/memory/index.js";
import { makeQuery, makeCandidate } from "./factories.js";

describe("LearnedMuseRanker (§9.15 v1.1)", () => {
  it("is the same math as the heuristic on the same coefficients", async () => {
    const ctx = memoryCtx();
    const query = makeQuery();
    const candidates = [makeCandidate({ postId: "p-a" }), makeCandidate({ postId: "p-b" })];
    const vc = viewerContextFor(query, ctx);
    const feats = candidates.map((c) => candidateFeatures(c, query, vc, ctx));

    const heuristic = await new HeuristicMuseRanker().predict(vc, feats);
    const learned = await new LearnedMuseRanker(
      "v1.model-learned",
      HEURISTIC_V1_COEFFICIENTS,
    ).predict(vc, feats);
    expect(learned).toStrictEqual(heuristic);
  });

  it("its own coefficient blob drives its own predictions", async () => {
    const ctx = memoryCtx();
    const query = makeQuery();
    const c = makeCandidate({ postId: "p-a" });
    const vc = viewerContextFor(query, ctx);
    const feats = [candidateFeatures(c, query, vc, ctx)];

    const boosted = structuredClone(HEURISTIC_V1_COEFFICIENTS);
    const head = boosted["like"];
    expect(head).toBeDefined();
    if (head === undefined) return;
    boosted["like"] = { ...head, intercept: head.intercept + 10 };

    const base = await new LearnedMuseRanker("v1.model-learned", HEURISTIC_V1_COEFFICIENTS).predict(
      vc,
      feats,
    );
    const up = await new LearnedMuseRanker("v1.model-learned", boosted).predict(vc, feats);
    expect(up[0]?.discrete["like"]).toBeGreaterThan(base[0]?.discrete["like"] ?? -1);
  });

  it("stamps the registry model version, never the heuristic constant", async () => {
    const learned = new LearnedMuseRanker("v1.model-learned", HEURISTIC_V1_COEFFICIENTS);
    expect(learned.modelVersion).toBe("v1.model-learned");
    const scorer = new MuseScorer(learned);
    const ctx = memoryCtx();
    const out = await scorer.score(makeQuery(), [makeCandidate()], ctx);
    expect(out[0]).not.toBeTypeOf("symbol");
  });

  it("predicts an empty slate as empty", async () => {
    const learned = new LearnedMuseRanker("v1.model-learned", HEURISTIC_V1_COEFFICIENTS);
    const ctx = memoryCtx();
    const vc = viewerContextFor(makeQuery(), ctx);
    await expect(learned.predict(vc, [])).resolves.toStrictEqual([]);
  });
});
