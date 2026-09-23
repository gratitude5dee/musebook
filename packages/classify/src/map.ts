// packages/classify/src/map.ts
import {
  AGENT_VALUE_LEVELS,
  AUDIENCE_LEVELS,
  POST_BATTERY,
  QUALITY_LEVELS,
  QUESTION_SET_VERSION,
  TOPIC_TAGS,
} from "./battery.js";
import { TAXONOMY_VERSION } from "./taxonomy.js";
import type { TaxonomyResult } from "./walk.js";

export const TAG_THRESHOLD = 0.5; // PLACEHOLDER — calibrate on the golden set (§8.11)
export const NSFW_THRESHOLD = 0.5; // PLACEHOLDER
export const AI_THRESHOLD = 0.5; // PLACEHOLDER

/**
 * A structural view of the battery's answers. Typed structurally rather than by
 * importing the SDK's `SystemOneResult`, because which type names `@typesafe-ai/sdk`
 * re-exports from its package root could not be confirmed against a primary source.
 * Full inference is still available at the call site: inside `classifyOne` the SDK
 * narrows `answers.medium.choice` to the literal label union, and this widening
 * happens only at the storage boundary, where every value becomes a column anyway.
 */
type BatteryAnswer = {
  type: "noul" | "choice" | "score";
  noul?: number;
  choice?: string;
  score?: number;
  confidence?: number | null;
  probabilities?: Record<string, number>;
  legend?: Record<string, unknown>;
};
export type BatteryAnswers = Record<keyof typeof POST_BATTERY, BatteryAnswer>;

/** score() returns a probability-weighted expected value in [0, levels-1]. */
const norm = (s: number, levels: number) => Math.min(1, Math.max(0, s / (levels - 1)));

export function toNarrowRow(
  contentHash: string,
  answers: BatteryAnswers,
  taxonomy: TaxonomyResult,
  meta: {
    model: string;
    inputTokens: number;
    requestId: string | null;
    latencyMs: number;
  },
) {
  const a = answers;

  const topicProbabilities = Object.fromEntries(
    TOPIC_TAGS.map((t) => [t, a[`tag_${t}`].noul ?? 0]),
  ) as Record<(typeof TOPIC_TAGS)[number], number>;

  const ranked = TOPIC_TAGS.map((t) => [t, topicProbabilities[t]] as const).sort(
    (x, y) => y[1] - x[1],
  );
  const topics = ranked.filter(([, p]) => p >= TAG_THRESHOLD).map(([t]) => t);

  const lang = a.language.choice ?? "none";

  // content_hash is the FIRST field because it is the idempotency key: this whole
  // object is passed to app.write_classification() as jsonb and lands on
  // post_classifications' primary key (§8.9).
  return {
    content_hash: contentHash,
    provider: "typesafe_jev" as const,
    model: meta.model,
    question_set_version: QUESTION_SET_VERSION,
    taxonomy_version: TAXONOMY_VERSION,

    primary_topic: topics.length > 0 ? topics[0]! : null,
    topics,
    topic_probabilities: topicProbabilities,
    language_code: lang === "other" || lang === "none" ? null : lang,

    quality: norm(a.quality.score ?? 0, QUALITY_LEVELS.length),
    toxicity: a.toxic.noul ?? null,
    spam: a.spam.noul ?? null,
    commercial_intent: a.commercial_intent.noul ?? null,
    is_nsfw: (a.nsfw.noul ?? 0) >= NSFW_THRESHOLD,
    is_ai_generated: (a.ai_generated.noul ?? 0) >= AI_THRESHOLD,

    taxonomy_path: taxonomy.path,
    taxonomy_leaf: taxonomy.leaf,
    taxonomy_score: taxonomy.score,

    medium: a.medium.choice ?? null,
    medium_confidence: a.medium.confidence ?? null,
    tone: a.tone.choice ?? null,

    audience_level: norm(a.audience_level.score ?? 0, AUDIENCE_LEVELS.length),
    audience_level_label:
      AUDIENCE_LEVELS[
        Math.min(AUDIENCE_LEVELS.length - 1, Math.round(a.audience_level.score ?? 0))
      ] ?? null,
    agent_value: norm(a.agent_value.score ?? 0, AGENT_VALUE_LEVELS.length),
    agent_value_confidence: a.agent_value.confidence ?? null,

    p_unsafe: a.unsafe.noul ?? null,
    p_nsfw: a.nsfw.noul ?? null,
    p_brand_unsafe: a.brand_unsafe.noul ?? null,
    p_ai_generated: a.ai_generated.noul ?? null,
    p_discloses_ai: a.discloses_ai.noul ?? null,
    p_contains_pii: a.contains_pii.noul ?? null,

    input_tokens: meta.inputTokens,
    request_id: meta.requestId,
    latency_ms: meta.latencyMs,
  };
}
