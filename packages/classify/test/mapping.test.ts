// packages/classify/test/mapping.test.ts — §8.4 narrow-row map + §8.9
// heuristic fallback row shape. Golden answers in, golden row out; the
// heuristic row must already satisfy every narrow NOT NULL because
// jsonb_populate_record turns missing keys into explicit nulls.
import { describe, expect, it } from "vitest";
import {
  toNarrowRow,
  heuristicClassification,
  POST_BATTERY,
  RUBRIC_FEATURES,
  PROBABILITY_FEATURES,
  type BatteryAnswers,
  type PostState,
} from "../src/index.js";
import type { TaxonomyResult } from "../src/walk.js";

/** A synthetic answer set: deterministic, hits every threshold branch. */
function goldenAnswers(): BatteryAnswers {
  const a: Record<string, unknown> = {};
  for (const [name, q] of Object.entries(POST_BATTERY)) {
    if (q.type === "noul") {
      // Alternating probabilities so ≥/over thresholds take both branches.
      a[name] = {
        type: "noul",
        noul: name === "tag_ai_ml" || name === "tag_software_dev" ? 0.9 : 0.1,
      };
    } else if (q.type === "score") {
      a[name] = {
        type: "score",
        score: name === "audience_level" ? 2 : 3,
        confidence: 0.9,
        probabilities: {},
      };
    } else {
      const labels = Object.keys(q.criteria as object).filter((l) => l !== "none_of_these");
      const pick = name === "language" ? "en" : name === "medium" ? "video" : labels[0];
      a[name] = {
        type: "choice",
        choice: pick,
        confidence: 0.95,
        probabilities: { [pick!]: 0.95, none_of_these: 0.05 },
      };
    }
  }
  a.language = { type: "choice", choice: "en", confidence: 0.99, probabilities: { en: 0.99 } };
  return a as BatteryAnswers;
}

const taxonomy: TaxonomyResult = {
  path: ["media", "music", "original_track"],
  leaf: "original_track",
  score: 0.81,
  levels: [],
  requests: 2,
};

const meta = { model: "jev-test", inputTokens: 111, requestId: "req_1", latencyMs: 42 };

describe("toNarrowRow (§8.4)", () => {
  it("maps answers to the narrow row with content_hash first", () => {
    const row = toNarrowRow("hash123", goldenAnswers(), taxonomy, meta);
    expect(row.content_hash).toBe("hash123");
    expect(Object.keys(row)[0]).toBe("content_hash");
    expect(row.provider).toBe("typesafe_jev");
    expect(row.model).toBe("jev-test");
  });

  it("topics are probability-sorted and thresholded, primary_topic is the top tag", () => {
    const row = toNarrowRow("h", goldenAnswers(), taxonomy, meta);
    expect([...row.topics].sort()).toEqual(["ai_ml", "software_dev"]);
    expect(row.topics).toEqual(
      [...row.topics].sort(
        (a, b) => (row.topic_probabilities[b] ?? 0) - (row.topic_probabilities[a] ?? 0),
      ),
    );
    expect(row.primary_topic).toBe(row.topics[0]);
    // Every tag probability is present under its non-tag_* name.
    expect(Object.keys(row.topic_probabilities)).toHaveLength(12);
    expect(row.topic_probabilities.ai_ml).toBeCloseTo(0.9);
    expect(row.topic_probabilities.games_interactive).toBeCloseTo(0.1);
  });

  it("norm() bounds rubric scores to [0,1] and labels the audience", () => {
    const row = toNarrowRow("h", goldenAnswers(), taxonomy, meta);
    for (const v of [row.quality, row.audience_level, row.agent_value]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    expect(row.audience_level_label).toContain("Practitioner"); // score 2 → index 2
    expect(row.audience_level).toBeCloseTo(2 / 3);
    expect(row.quality).toBeCloseTo(1); // score 3 → levels-1
  });

  it("language other/none maps to null; medium/tone passthrough with confidence", () => {
    const answers = goldenAnswers();
    answers.language = { type: "choice", choice: "other", confidence: 0.5 };
    const row = toNarrowRow("h", answers, taxonomy, meta);
    expect(row.language_code).toBeNull();
    expect(row.medium).toBe("video");
    expect(row.medium_confidence).toBeCloseTo(0.95);
  });

  it("never mixes rubric and noul families — features are disjoint sets", () => {
    for (const f of RUBRIC_FEATURES) expect(PROBABILITY_FEATURES).not.toContain(f);
    for (const f of PROBABILITY_FEATURES) expect(RUBRIC_FEATURES).not.toContain(f);
  });

  it("taxonomy passthrough + every NOT NULL narrow column is non-null", () => {
    const row = toNarrowRow("h", goldenAnswers(), taxonomy, meta);
    expect(row.taxonomy_path).toEqual(["media", "music", "original_track"]);
    expect(row.taxonomy_leaf).toBe("original_track");
    for (const col of [
      "content_hash",
      "provider",
      "model",
      "topics",
      "topic_probabilities",
      "taxonomy_path",
      "is_nsfw",
      "question_set_version",
      "taxonomy_version",
    ] as const) {
      expect(row[col], col).not.toBeNull();
    }
  });
});

describe("heuristicClassification (§8.9 fallback row)", () => {
  const state: PostState = {
    kind: "article",
    title: "T",
    summary: null,
    body: "body",
    declared_tags: ["Tech", "news"],
    declared_language: "en",
    media: null,
    artifact: null,
    author: { id: "a1", kind: "human", name: "n", reputation: null },
    link_hosts: [],
  };

  it("emits a row jsonb_populate_record can't violate", () => {
    const row = heuristicClassification("h", state);
    expect(row.provider).toBe("heuristic");
    expect(row.topics).toEqual(["tech", "news"]); // declared tags normalized
    expect(row.is_nsfw).toBe(false);
    expect(row.is_ai_generated).toBeNull(); // human author → unknown
    for (const col of ["topics", "topic_probabilities", "taxonomy_path", "is_nsfw"] as const) {
      expect(row[col], col).not.toBeNull();
    }
    expect(row.input_tokens).toBe(0);
    expect(row.latency_ms).toBe(0);
  });

  it("agent-authored posts infer is_ai_generated=true", () => {
    const row = heuristicClassification("h", {
      ...state,
      author: { ...state.author, kind: "agent" },
    });
    expect(row.is_ai_generated).toBe(true);
  });
});
