// packages/muse-mixer/src/muse/scorers/diversity_scorer.ts
import type { PostKind } from "@musebook/schema";
import type { ExecCtx, PerCandidate, Scorer } from "../../framework/types.js";
import type { MuseFeedQuery } from "../query.js";
import type { MuseCandidate } from "../candidate.js";

export function attenuation(pos: number, decay: number, floor: number): number {
  return (1 - floor) * Math.pow(decay, pos) + floor;
}

export class DiversityScorer implements Scorer<MuseFeedQuery, MuseCandidate> {
  readonly name = "DiversityScorer";

  score(
    _q: MuseFeedQuery,
    candidates: readonly MuseCandidate[],
    ctx: ExecCtx,
  ): Promise<Array<PerCandidate<MuseCandidate>>> {
    const cDecay = ctx.params.num("CreatorDiversityDecayFactor", 0.8);
    const cFloor = ctx.params.num("CreatorDiversityFloor", 0.1);
    const kDecay = ctx.params.num("KindDiversityDecayFactor", 0.85);
    const kFloor = ctx.params.num("KindDiversityFloor", 0.25);

    // Walk in score-descending order, but WRITE BACK IN INPUT ORDER.
    // Ties break on postId so the walk is deterministic and a recompute reproduces it.
    const order = candidates
      .map((c, i) => ({
        i,
        s: c.score ?? c.weightedScore ?? Number.NEGATIVE_INFINITY,
        id: c.postId,
      }))
      .sort((a, b) => b.s - a.s || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    const creatorSeen = new Map<string, number>();
    const kindSeen = new Map<PostKind, number>();
    const out: Array<PerCandidate<MuseCandidate>> = new Array<PerCandidate<MuseCandidate>>(
      candidates.length,
    );

    for (const { i } of order) {
      const c = candidates[i];
      if (c === undefined) continue;
      const cp = creatorSeen.get(c.creatorId) ?? 0;
      const kp = kindSeen.get(c.kind) ?? 0;
      const mult = attenuation(cp, cDecay, cFloor) * attenuation(kp, kDecay, kFloor);
      const base = c.score ?? c.weightedScore ?? 0;
      out[i] = {
        score: base * mult,
        debug: { ...c.debug, divMult: mult, creatorPos: cp, kindPos: kp },
      };
      creatorSeen.set(c.creatorId, cp + 1);
      kindSeen.set(c.kind, kp + 1);
    }
    return Promise.resolve(out);
  }
}
