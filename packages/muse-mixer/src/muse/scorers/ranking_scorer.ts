// packages/muse-mixer/src/muse/scorers/ranking_scorer.ts
// Derived from xai-org/x-algorithm home-mixer/scorers/ranking_scorer.rs (Apache-2.0). See NOTICE.
import { MUSE_ACTIONS, MUSE_CONTINUOUS, MUSE_NEGATIVE_ACTIONS } from "../actions.js";
import type { MuseAction } from "../actions.js";
import type { MuseCandidate } from "../candidate.js";
import type { MuseFeedQuery } from "../query.js";
import type { ExecCtx, PerCandidate, Scorer } from "../../framework/types.js";
import { cohortKeyFor, type ActionWeights, type WeightsLoader } from "../weights.js";

const NEGATIVE_SET: ReadonlySet<string> = new Set<string>(MUSE_NEGATIVE_ACTIONS);

// Gates come from a runtime-loaded jsonb row — coerce with defaults at the edge.
const gnum = (v: number | boolean | undefined, d: number): number =>
  typeof v === "number" ? v : d;
const gbool = (v: number | boolean | undefined, d: boolean): boolean =>
  typeof v === "boolean" ? v : d;

export function computeWeightedScore(
  c: MuseCandidate,
  _q: MuseFeedQuery,
  w: ActionWeights,
): number {
  const p = c.actionScores ?? {};
  const k = c.continuousPreds ?? {};
  const isMedia = c.kind === "video" || c.kind === "audio";
  const isApp = c.kind === "app" || c.kind === "model3d";
  const longEnough = (c.durationMs ?? 0) > gnum(w.gates.minMediaDurationMs, 0);
  const monetizable = c.monetization !== undefined && c.monetization.mode !== "free";
  const mutual = c.mutualFollow === true;

  // Gate: a head contributes 0 when its action is impossible for this candidate.
  // Direct analog of upstream's VQV gate (MinVideoDurationMs in ranking_scorer.rs).
  const gate = (a: MuseAction): number => {
    switch (a) {
      case "impression":
        return 0; // exposure, never a reward
      case "play":
        return isMedia ? 1 : 0;
      case "play_through":
        return isMedia && (!gbool(w.gates.enablePlayThroughDurationCheck, true) || longEnough)
          ? 1
          : 0;
      case "fork_app":
      case "install_app":
        return isApp ? 1 : 0;
      case "x402_pay":
      case "agent_crawl":
        return monetizable ? 1 : 0;
      case "follow":
        return c.inNetwork === true ? 0 : 1;
      case "not_dwelled":
        return (p.impression ?? 0) < 0.05 ? 0 : 1;
      default:
        return 1;
    }
  };

  const weightOf = (a: MuseAction): number => {
    let base = w.discrete[a] ?? 0;
    if (mutual && a === "comment") base *= gnum(w.gates.bidirectionalFollowCommentBoost, 1);
    if (mutual && a === "dwell") base *= gnum(w.gates.bidirectionalFollowDwellBoost, 1);
    return base;
  };

  let combined = 0;
  for (const a of MUSE_ACTIONS) combined += (p[a] ?? 0) * weightOf(a) * gate(a);
  for (const cn of MUSE_CONTINUOUS) combined += (k[cn] ?? 0) * (w.continuous[cn] ?? 0);

  // Exploration bonus for posts nobody has seen yet (upstream PostUnexploredWeight).
  const impressions = c.counters?.impressions ?? 0;
  const unexplored = 1 / (1 + Math.log1p(impressions));
  if (gbool(w.gates.enableMultiplicativePostUnexplored, false)) {
    combined *= 1 + gnum(w.gates.multiplicativePostUnexploredAlpha, 0) * unexplored;
  } else {
    combined += gnum(w.gates.postUnexploredWeight, 0) * unexplored;
  }

  if (c.creatorKind === "agent") combined *= gnum(w.gates.agentAuthoredMultiplier, 1);

  // Continuous heads are unbounded below; clamp so offsetScore's mapping stays in range.
  return offsetScore(Math.max(combined, -w.negativeSum), w);
}

/** Shape of upstream offset_score(); sign convention adapted to signed weights. */
export function offsetScore(combined: number, w: ActionWeights): number {
  const offset = gnum(w.gates.negativeScoresOffset, 100);
  if (w.totalSum === 0) return Math.max(combined, 0);
  if (combined < 0) return ((combined + w.negativeSum) / w.totalSum) * offset;
  return combined + offset;
}

export const negativeActionSet = NEGATIVE_SET;

/** The pipeline stage. Reads `actionScores`, writes `weightedScore`, nothing else. */
export class RankingScorer implements Scorer<MuseFeedQuery, MuseCandidate> {
  readonly name = "RankingScorer";
  constructor(private readonly loader: WeightsLoader) {}
  async score(
    q: MuseFeedQuery,
    candidates: readonly MuseCandidate[],
    ctx: ExecCtx,
  ): Promise<Array<PerCandidate<MuseCandidate>>> {
    // Resolved ONCE per pass, never per candidate. See section 9.12.
    const w = await this.loader.load(cohortKeyFor(q, ctx));
    const weightsVersion = `${w.version}/${w.cohort}`;
    return candidates.map((c) => ({
      weightedScore: computeWeightedScore(c, q, w),
      weightsVersion,
    }));
  }
}
