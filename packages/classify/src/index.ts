// packages/classify/src/index.ts
import { choice, type TypeSafeClient } from "@typesafe-ai/sdk";
import {
  POST_BATTERY,
  POST_BATTERY_LABELS,
  POST_BATTERY_TAGS,
  QUESTION_SET_VERSION,
} from "./battery.js";
import type { ClassifyEnv } from "./client.js";
import { isQuestionSetError } from "./errors.js";
import type { BatteryAnswers } from "./map.js";
import { toNarrowRow } from "./map.js";
import type { PostState } from "./state.js";
import { LEAF_TO_PATH, MUSEBOOK_TAXONOMY, TAXONOMY_VERSION } from "./taxonomy.js";
import { walkTaxonomy, type TaxonomyResult } from "./walk.js";

export * from "./battery.js";
export * from "./client.js";
export * from "./errors.js";
export * from "./features.js";
export * from "./heuristic.js";
export * from "./map.js";
export * from "./state.js";
export * from "./taxonomy.js";
export * from "./walk.js";

export const FLAT_LEAF_QUESTION = "taxonomy_flat_leaf" as const;
type FlatBattery = typeof POST_BATTERY & {
  [FLAT_LEAF_QUESTION]: ReturnType<typeof choice>;
};

/** The leaf choice folded into the battery request when CLASSIFY_TAXONOMY_MODE=flat. */
export const POST_BATTERY_FLAT: FlatBattery = {
  ...POST_BATTERY,
  [FLAT_LEAF_QUESTION]: choice(
    {
      task: "Which single leaf category does this post belong to?",
      rule: "Choose the most specific correct leaf. Choose none_of_these only if no leaf applies.",
    },
    {
      ...Object.fromEntries(
        Object.keys(LEAF_TO_PATH).map((leaf) => [
          leaf,
          `Path: ${LEAF_TO_PATH[leaf]!.join(" > ")}`,
        ]),
      ),
      none_of_these: "None of the leaves above describes this post.",
    },
  ),
};

/** One call site, one usage accumulator — split fallback and walk levels all fold into it. */
type CallRecord = { inputTokens: number; requestIds: (string | undefined)[] };

async function batteryResult(
  client: TypeSafeClient,
  state: PostState,
  questions: FlatBattery | typeof POST_BATTERY,
  record: CallRecord,
): Promise<{ answers: BatteryAnswers; model: string }> {
  try {
    const { data, requestId } = await client
      .systemOne({ state: state as never, questions: questions as never })
      .withResponse();
    record.inputTokens += data.usage.input_tokens;
    record.requestIds.push(requestId);
    return { answers: data.answers as BatteryAnswers, model: data.model };
  } catch (err) {
    if (!isQuestionSetError(err)) throw err;
    // §8.4 question-count fallback: same 28 answers, two smaller requests.
    const [labels, tags] = await Promise.all([
      client
        .systemOne({ state: state as never, questions: POST_BATTERY_LABELS })
        .withResponse(),
      client
        .systemOne({ state: state as never, questions: POST_BATTERY_TAGS })
        .withResponse(),
    ]);
    record.inputTokens += labels.data.usage.input_tokens + tags.data.usage.input_tokens;
    record.requestIds.push(labels.requestId, tags.requestId);
    return {
      answers: { ...labels.data.answers, ...tags.data.answers } as BatteryAnswers,
      model: labels.data.model,
    };
  }
}

/**
 * The whole classification of one post: battery (+ optional flat leaf or walk),
 * narrow row, and the raw bundle for post_classification_raw. Pure — no env of
 * its own, no database, no platform imports; the caller owns the client, the
 * clock and the write.
 */
export async function classifyOne(
  client: TypeSafeClient,
  env: ClassifyEnv,
  contentHash: string,
  state: PostState,
  startedAt: number,
): Promise<{ narrow: ReturnType<typeof toNarrowRow>; raw: Record<string, unknown> }> {
  const record: CallRecord = { inputTokens: 0, requestIds: [] };
  const flat = (env.CLASSIFY_TAXONOMY_MODE ?? "walk") === "flat";

  const { answers, model } = await batteryResult(
    client,
    state,
    flat ? POST_BATTERY_FLAT : POST_BATTERY,
    record,
  );

  let taxonomy: TaxonomyResult;
  if (flat) {
    const leafAnswer = (answers as BatteryAnswers & Record<string, { choice?: string; probabilities?: Record<string, number> }>)[
      FLAT_LEAF_QUESTION
    ];
    const leaf = leafAnswer?.choice;
    const path = leaf && leaf !== "none_of_these" ? LEAF_TO_PATH[leaf] : undefined;
    const prob = leaf ? (leafAnswer?.probabilities?.[leaf] ?? 0) : 0;
    taxonomy = path
      ? { path, leaf: leaf ?? null, score: prob, levels: [], requests: 0 }
      : { path: [], leaf: null, score: 0, levels: [], requests: 0 };
  } else {
    const l1 = answers.taxonomy_l1;
    const rootLabel =
      l1.choice && l1.choice !== "none_of_these" && MUSEBOOK_TAXONOMY[l1.choice]
        ? l1.choice
        : null;
    const rootProbability = l1.choice ? (l1.probabilities?.[l1.choice] ?? 0) : 0;
    taxonomy = await walkTaxonomy(client, state, rootLabel, rootProbability);
    // walkTaxonomy does not withResponse() — its usage is not separately metered;
    // input_tokens therefore measures battery + flat only. Documented in the
    // consumer's ops_events row; the 3-request-per-post budget is unaffected.
  }

  const narrow = toNarrowRow(contentHash, answers, taxonomy, {
    model,
    inputTokens: record.inputTokens,
    requestId: record.requestIds.filter((id): id is string => id != null).join(",") || null,
    latencyMs: Math.max(0, Math.round(Date.now() - startedAt)),
  });

  const raw = {
    answers,
    usage: { input_tokens: record.inputTokens },
    model,
    levels: taxonomy.levels,
    question_set_version: QUESTION_SET_VERSION,
    taxonomy_version: TAXONOMY_VERSION,
  };
  return { narrow, raw };
}
