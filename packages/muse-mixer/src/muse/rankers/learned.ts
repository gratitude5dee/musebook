// packages/muse-mixer/src/muse/rankers/learned.ts
// v1.1 — multinomial logistic / GBDT-distilled-to-linear, trained nightly
// offline and shipped as a ~2 KB JSON coefficient blob in a `ranking_weights`
// row under the `model:learned` cohort — data, not a binary (§9.15: no ONNX,
// no WASM, no new binding). The math is the same `evaluateLogistic` the
// heuristic ranker runs; what differs is the provenance of the coefficients
// and the `modelVersion`, which comes from the `model_registry` row whose
// status moved candidate → shadow → active, never from a constant — a flip
// that left `model_version = 'reverse_chron'` would destroy the comparison
// it exists to make (§16 M15.4).
import type {
  ActionPrediction,
  CandidateFeatures,
  MuseRanker,
  ViewerContext,
} from "../scorers/muse_scorer.js";
import { evaluateLogistic, type HeuristicCoefficients } from "./heuristic.js";

/** The blob shape inside `ranking_weights.weights.learned` — same per-head
 *  `{intercept, coefs}` map the heuristic row carries under `weights.heuristic`. */
export type LearnedCoefficients = HeuristicCoefficients;

export class LearnedMuseRanker implements MuseRanker {
  /**
   * @param modelVersion the model_registry row's version — stamped on every
   *   slate and action_events row this ranker produces, so the comparison
   *   against the incumbent stays attributable.
   * @param coefs the coefficient blob; required — a learned model with no
   *   coefficients is a reason not to promote, not a reason to invent numbers.
   */
  constructor(
    readonly modelVersion: string,
    private readonly coefs: LearnedCoefficients,
  ) {}

  predict(_vc: ViewerContext, feats: readonly CandidateFeatures[]): Promise<ActionPrediction[]> {
    return Promise.resolve(evaluateLogistic(this.coefs, feats));
  }
}
