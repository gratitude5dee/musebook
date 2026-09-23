// packages/muse-mixer/src/muse/scorers/cold_start_scorer.ts
// Cold-start creators — Thompson sampling over a Beta posterior, ported
// near-verbatim from home-mixer/scorers/author_cold_start.rs (§9.14).
// The RNG is seeded from slateId — never Math.random() — so a rebuild and the
// replay harness reproduce the same slate exactly.
import type { ExecCtx, PerCandidate, Scorer } from "../../framework/types.js";
import type { MuseFeedQuery } from "../query.js";
import type { MuseCandidate } from "../candidate.js";
import { slateRng } from "../rng.js";

/** Gamma(a, 1) via Marsaglia–Tsang, with the α<1 boost: Gamma(α) = Gamma(α+1)·U^(1/α). */
function sampleGamma(alpha: number, rand: () => number): number {
  if (alpha < 1) {
    return sampleGamma(alpha + 1, rand) * Math.pow(Math.max(rand(), 1e-12), 1 / alpha);
  }
  const d = alpha - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    // Box–Muller normal
    for (;;) {
      const u1 = Math.max(rand(), 1e-12);
      const u2 = rand();
      x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      v = 1 + c * x;
      if (v > 0) break;
    }
    v = v * v * v;
    const u = Math.max(rand(), 1e-12);
    if (u < 1 - 0.0331 * (x * x) * (x * x)) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

function sampleBeta(alpha: number, beta: number, rand: () => number): number {
  const x = sampleGamma(alpha, rand);
  const y = sampleGamma(beta, rand);
  return x + y === 0 ? 0.5 : x / (x + y);
}

function eligible(c: MuseCandidate, q: MuseFeedQuery, ctx: ExecCtx): boolean {
  if (c.remixOf !== undefined) return false;
  const followerCap = ctx.params.num("ColdStartFollowerCap", 200);
  const impressionThreshold = ctx.params.num("ColdStartImpressionThreshold", 50);
  const maxPostAgeMs = ctx.params.num("ColdStartMaxPostAgeMs", 72 * 3600 * 1000);
  if ((c.creatorFollowers ?? 0) > followerCap) return false;
  if ((c.counters?.impressions ?? 0) >= impressionThreshold) return false;
  if (ctx.now - c.publishedAt > maxPostAgeMs) return false;
  void q;
  return true;
}

export class ColdStartScorer implements Scorer<MuseFeedQuery, MuseCandidate> {
  readonly name = "ColdStartScorer";

  score(
    q: MuseFeedQuery,
    candidates: readonly MuseCandidate[],
    ctx: ExecCtx,
  ): Promise<Array<PerCandidate<MuseCandidate>>> {
    if (!ctx.params.bool("ColdStartEnabled", true)) {
      return Promise.resolve(candidates.map(() => ({})));
    }
    const rand = slateRng(q.slateId);
    const impressionScale = ctx.params.num("ColdStartImpressionScale", 1.0);
    const alpha0 = ctx.params.num("ColdStartBetaAlpha0", 1.0);
    const beta0 = ctx.params.num("ColdStartBetaBeta0", 100.0);
    const tsTopK = Math.max(1, Math.floor(ctx.params.num("ColdStartTsTopK", 5)));
    const slotMin = ctx.params.num("ColdStartSlotMin", 5);
    const slotMax = ctx.params.num("ColdStartSlotMax", 15);
    const useThompson = ctx.params.bool("ColdStartUseThompsonSampling", true);
    const maxPosRatio = ctx.params.num("ColdStartMaxPositionRatio", 0.2);

    // Eligibility + posterior — pure per candidate.
    const sampled = candidates
      .map((c, i) => {
        if (!eligible(c, q, ctx)) return { i, reward: -1 };
        const impressions = c.counters?.impressions ?? 0;
        const positives = c.rolling?.engagements24h ?? 0;
        const n = impressionScale * impressions;
        const x = Math.min(positives, n);
        const alpha = alpha0 + x;
        const beta = beta0 + Math.max(0, n - x);
        return { i, reward: useThompson ? sampleBeta(alpha, beta, rand) : alpha / (alpha + beta) };
      })
      .sort((a, b) => b.reward - a.reward);

    // Winner(s): best of top-tsTopK. The cap keeps cold starts a minority of the slate.
    const maxBoosts = Math.max(0, Math.floor(candidates.length * maxPosRatio));
    const winners = sampled.filter((s) => s.reward >= 0).slice(0, Math.min(tsTopK, maxBoosts));

    // Boost to the weightedScore occupying a uniform slot in [slotMin, slotMax].
    const sorted = [...candidates]
      .map((c) => c.score ?? c.weightedScore ?? 0)
      .sort((a, b) => b - a);
    const out: Array<PerCandidate<MuseCandidate>> = candidates.map(() => ({}));
    for (const w of winners) {
      const lo = Math.min(slotMin, Math.max(0, sorted.length - 1));
      const hi = Math.min(Math.max(slotMin, slotMax), Math.max(0, sorted.length - 1));
      const slot = Math.floor(lo + rand() * (hi - lo + 1));
      const target = sorted[Math.min(slot, sorted.length - 1)] ?? 0;
      const c = candidates[w.i];
      if (c === undefined) continue;
      out[w.i] = {
        score: Math.max(c.score ?? c.weightedScore ?? 0, target),
        debug: { ...c.debug, coldStartBoost: 1, thompsonReward: w.reward, boostSlot: slot },
      };
    }
    return Promise.resolve(out);
  }
}
