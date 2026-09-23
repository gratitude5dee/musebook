// packages/muse-mixer/src/muse/scorers/watch_time_scorer.ts
import type { ExecCtx, PerCandidate, Scorer } from "../../framework/types.js";
import type { MuseFeedQuery } from "../query.js";
import type { MuseCandidate } from "../candidate.js";

/**
 * Pure per (viewer, candidate). Reads nothing about the batch — no mean duration,
 * no rank, no candidates.length. §9.19's isolation gate covers this class, and it
 * is in that list precisely because "normalize watch time across the slate" is the
 * tempting, wrong implementation.
 */
export function watchUtility(
  c: MuseCandidate,
  w: {
    capMs: number;
    idealMs: number;
    partial: number;
    priorWeight: number;
  },
): number {
  const dur = Math.min(c.durationMs ?? 0, w.capMs);
  if (dur <= 0) return 0;
  const pPlay = c.actionScores?.play ?? 0;
  const pThrough = c.actionScores?.play_through ?? 0;

  // Expected milliseconds watched, from this viewer's own predicted probabilities.
  const expected = pPlay * (pThrough * dur + (1 - pThrough) * w.partial * dur);

  // Expected completion in [0,1]: duration divides out, so a 15 s clip watched to the
  // end beats a 4 min clip watched a fifth of the way through.
  let completion = expected / dur;

  // Blend in the post's own observed completion rate, which is a population prior on
  // the same quantity. post_stats_rolling is refreshed hourly from the DAILY rollups
  // (§13.7.2), so a clip published this morning has 0 here — hence a blend, never a
  // multiply, or every new clip would score zero and ColdStartScorer would be the
  // only thing that ever surfaced one.
  const prior = c.rolling?.completionRate24h ?? 0;
  completion = (1 - w.priorWeight) * completion + w.priorWeight * prior;

  // Length penalty: beyond ReelsIdealDurationMs, decay smoothly. This is what stops
  // the surface drifting toward long-form, which is a different product.
  const over = Math.max(0, (c.durationMs ?? 0) - w.idealMs);
  const lengthPenalty = 1 / (1 + over / w.idealMs);

  return completion * lengthPenalty; // ∈ [0,1]
}

export class WatchTimeScorer implements Scorer<MuseFeedQuery, MuseCandidate> {
  readonly name = "WatchTimeScorer";
  enable(q: MuseFeedQuery): boolean {
    return q.surface === "reels";
  }

  score(
    _q: MuseFeedQuery,
    candidates: readonly MuseCandidate[],
    ctx: ExecCtx,
  ): Promise<Array<PerCandidate<MuseCandidate>>> {
    const w = {
      capMs: ctx.params.num("ReelsWatchCapMs", 90000),
      idealMs: ctx.params.num("ReelsIdealDurationMs", 20000),
      partial: ctx.params.num("ReelsPartialWatchFraction", 0.35),
      priorWeight: ctx.params.num("ReelsCompletionPriorWeight", 0.35),
    };
    const floor = ctx.params.num("ReelsWatchFloor", 0.3);

    return Promise.resolve(
      candidates.map((c) => {
        const u = watchUtility(c, w);
        // Bounded attenuation of a positive number, exactly like §9.13's diversity
        // multiplier and for the same reason: weightedScore is offset-shifted by
        // NegativeScoresOffset, so an additive term of unknown scale would be
        // meaningless and a raw multiply could invert the offset.
        const mult = floor + (1 - floor) * u;
        return {
          score: (c.weightedScore ?? 0) * mult,
          debug: { ...c.debug, watchUtility: u, watchMult: mult },
        };
      }),
    );
  }
}
