// packages/classify/src/heuristic.ts
import type { PostState } from "./state.js";

/** Keyed by §4.2's eight-value post_kind; a kind without a mapping is a compile error. */
const MEDIUM_BY_KIND: Record<PostState["kind"], string> = {
  note: "text",
  article: "text",
  image: "image",
  video: "video",
  audio: "audio",
  app: "app",
  model3d: "artifact_3d",
  thread: "text",
};

/**
 * Everything a model would judge stays null. Null is honest; a guess is not.
 * `state` may be null when the failure happened before the state was fetched —
 * the row is still written, so the post is visibly degraded rather than absent.
 */
export function heuristicClassification(contentHash: string, state: PostState | null) {
  const declared = (state?.declared_tags ?? []).map((t) =>
    t.toLowerCase().replace(/[^a-z0-9_]/g, "_"),
  );
  const lang = state?.declared_language ?? "";
  return {
    content_hash: contentHash,
    provider: "heuristic" as const,
    model: "heuristic-v1",
    question_set_version: null,
    taxonomy_version: null,
    medium: state ? MEDIUM_BY_KIND[state.kind] : null,
    medium_confidence: null,
    language_code: /^[a-z]{2}(-[A-Z]{2})?$/.test(lang) ? lang.slice(0, 2) : null,
    topics: declared.slice(0, 5), // creator-declared tags: a prior, explicitly not ground truth
    topic_probabilities: {},
    primary_topic: declared[0] ?? null,
    tone: null,
    quality: null,
    toxicity: null,
    spam: null,
    commercial_intent: null,
    audience_level: null,
    audience_level_label: null,
    agent_value: null,
    agent_value_confidence: null,
    is_nsfw: false,
    is_ai_generated: state?.author.kind === "agent" ? true : null,
    taxonomy_path: [] as string[],
    taxonomy_leaf: null,
    taxonomy_score: null,
    p_unsafe: null,
    p_nsfw: null,
    p_brand_unsafe: null,
    p_ai_generated: null,
    p_discloses_ai: null,
    p_contains_pii: null,
    input_tokens: 0,
    request_id: null,
    latency_ms: 0,
  };
}
