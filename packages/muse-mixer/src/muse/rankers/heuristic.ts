// packages/muse-mixer/src/muse/rankers/heuristic.ts
// v1.0 — hand-set logistic priors per head. Coefficients are data: the worker
// adapter passes the `v1.model-heuristic` ranking_weights row in; the optional
// constructor arg is what lets the G-ISO harness and the replay fixture build it
// without a database. p(a) = sigmoid(Σ βᵢ·featᵢ + β₀ᵃ) (§9.15).
import type {
  ActionPrediction,
  CandidateFeatures,
  MuseRanker,
  ViewerContext,
} from "../scorers/muse_scorer.js";
import type { MuseAction, MuseContinuous } from "../actions.js";
import { MUSE_ACTIONS, MUSE_CONTINUOUS } from "../actions.js";

export interface LogisticHead {
  intercept: number;
  coefs: Record<string, number>;
}
export type HeuristicCoefficients = Partial<Record<MuseAction, LogisticHead>> & {
  continuous?: Partial<Record<MuseContinuous, { mean: number; scale: number }>>;
};

/** Flatten a CandidateFeatures into a scalar map — one-hots become `name_<idx>` keys. */
function flatFeatures(f: CandidateFeatures): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(f) as Array<[string, number | number[]]>) {
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) out[`${k}_${i}`] = v[i] ?? 0;
    } else {
      out[k] = v;
    }
  }
  return out;
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/**
 * Launch-day priors. Positive heads: modest intercepts so unseen-but-clean content
 * sits near base rates, with real signal features pulling it up or down. Negative
 * heads: strongly negative intercepts so nothing predicts a negative action on
 * prior alone — only explicit signals (pUnsafe, toxicity via classification) lift
 * them. These priors are what the `v1.model-heuristic` row carries verbatim so a
 * tuning change is one update, not a deploy.
 */
export const HEURISTIC_V1_COEFFICIENTS: HeuristicCoefficients = {
  impression: { intercept: 1.9, coefs: {} },
  view: { intercept: -1.8, coefs: { recencyDecay: 0.6, inNetwork: 0.8, sourceScore: 1.0 } },
  dwell: {
    intercept: -1.2,
    coefs: { quality: 1.2, topicAffinity: 0.3, creatorAffinity: 0.25, recencyDecay: 0.4 },
  },
  play: {
    intercept: -1.5,
    coefs: { kindOneHot_3: 1.2, kindOneHot_4: 1.0, quality: 0.8, recencyDecay: 0.3 },
  },
  play_through: {
    intercept: -1.9,
    coefs: { completionRate24h: 1.6, quality: 0.9, durationBucket_5: -0.4, replays24hLog: 0.1 },
  },
  like: {
    intercept: -2.2,
    coefs: {
      quality: 1.4,
      qAgentValue: 0.6,
      creatorAffinity: 0.5,
      topicAffinity: 0.25,
      inNetwork: 0.6,
      mutualFollow: 0.4,
      likesLog: 0.12,
      engagements24hLog: 0.08,
    },
  },
  comment: {
    intercept: -3.2,
    coefs: {
      quality: 1.0,
      creatorAffinity: 0.45,
      inNetwork: 0.7,
      mutualFollow: 0.5,
      engagements24hLog: 0.1,
    },
  },
  repost: {
    intercept: -3.4,
    coefs: { quality: 1.1, repostsLog: 0.15, engagementVelocity: 0.05, engagements24hLog: 0.1 },
  },
  bookmark: {
    intercept: -2.9,
    coefs: { quality: 1.3, qAgentValue: 0.8, bookmarksLog: 0.12, embSimViewer: 0.7 },
  },
  share: {
    intercept: -3.0,
    coefs: { quality: 0.9, engagementVelocity: 0.05, engagements24hLog: 0.1 },
  },
  follow: {
    intercept: -3.8,
    coefs: { quality: 0.8, creatorAffinity: 0.3, embSimViewer: 0.4, inNetwork: -0.5 },
  },
  remix: {
    intercept: -4.2,
    coefs: { quality: 1.0, isRemixOfEngaged: 1.5, kindOneHot_5: 0.5, kindOneHot_6: 0.5 },
  },
  fork_app: {
    intercept: -4.5,
    coefs: { kindOneHot_5: 1.4, kindOneHot_6: 1.4, quality: 0.8, forksLog: 0.15 },
  },
  install_app: { intercept: -4.0, coefs: { kindOneHot_5: 1.5, kindOneHot_6: 1.5, quality: 0.7 } },
  tip: { intercept: -5.0, coefs: { accessOneHot_2: 0.6, quality: 0.8, creatorAffinity: 0.4 } },
  x402_pay: {
    intercept: -4.6,
    coefs: { accessOneHot_2: 1.2, paidFetchesLog: 0.2, embSimViewer: 0.6, quality: 0.7 },
  },
  agent_crawl: {
    intercept: -3.2,
    coefs: { signedAgentFetches24hLog: 0.25, accessOneHot_2: 0.5 },
  },
  agent_cite: { intercept: -4.0, coefs: { signedAgentFetches24hLog: 0.2, quality: 0.7 } },
  not_interested: {
    intercept: -4.2,
    coefs: { pUnsafe: 1.4, embSimViewer: -0.8, topicAffinity: -0.2 },
  },
  mute_creator: {
    intercept: -5.2,
    coefs: { pUnsafe: 1.6, creatorAffinity: -0.4 },
  },
  block_creator: { intercept: -5.6, coefs: { pUnsafe: 1.8 } },
  report: { intercept: -6.0, coefs: { pUnsafe: 2.0, quality: -1.0 } },
  not_dwelled: {
    intercept: -0.6,
    coefs: { quality: -1.0, recencyDecay: -0.5, embSimViewer: -0.6, sourceScore: -0.6 },
  },
  continuous: {
    dwell_time_s: { mean: 6.0, scale: 4.0 },
    watch_time_ms: { mean: 8000, scale: 12000 },
    scroll_depth: { mean: 0.45, scale: 0.2 },
    active_seconds_5m: { mean: 18, scale: 12 },
    tip_amount_usdc: { mean: 0, scale: 0.5 },
  },
};

/**
 * The per-candidate logistic evaluation both v1.x rankers share — heuristic
 * and learned differ only in where the coefficient blob comes from (constants
 * vs a `ranking_weights` row), never in the math (§9.15).
 */
export function evaluateLogistic(
  coefs: HeuristicCoefficients,
  feats: readonly CandidateFeatures[],
): ActionPrediction[] {
  return feats.map((f) => {
    const flat = flatFeatures(f);
    const discrete: ActionPrediction["discrete"] = {};
    for (const a of MUSE_ACTIONS) {
      const head = coefs[a];
      if (head === undefined) continue;
      let x = head.intercept;
      for (const [name, beta] of Object.entries(head.coefs)) x += beta * (flat[name] ?? 0);
      discrete[a] = sigmoid(x);
    }
    const continuous: ActionPrediction["continuous"] = {};
    for (const cn of MUSE_CONTINUOUS) {
      const spec = coefs.continuous?.[cn];
      if (spec === undefined) continue;
      // posterior mean nudged by the probability of its parent action
      const driver =
        cn === "watch_time_ms"
          ? (discrete.play ?? 0)
          : cn === "dwell_time_s"
            ? (discrete.dwell ?? 0)
            : cn === "scroll_depth"
              ? (discrete.view ?? 0)
              : cn === "tip_amount_usdc"
                ? (discrete.tip ?? 0)
                : (discrete.dwell ?? 0);
      continuous[cn] = spec.mean * (0.5 + driver);
    }
    return { discrete, continuous };
  });
}

export class HeuristicMuseRanker implements MuseRanker {
  readonly modelVersion = "v1.model-heuristic";
  constructor(private readonly coefs: HeuristicCoefficients = HEURISTIC_V1_COEFFICIENTS) {}

  predict(_vc: ViewerContext, feats: readonly CandidateFeatures[]): Promise<ActionPrediction[]> {
    return Promise.resolve(evaluateLogistic(this.coefs, feats));
  }
}
