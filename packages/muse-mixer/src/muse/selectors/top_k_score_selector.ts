// packages/muse-mixer/src/muse/selectors/top_k_score_selector.ts
// Sorts by `score` — NEVER by weightedScore (§9.11: conflating the two is the
// single most common port bug; its symptom is duplicates on page 2).
import type { ExecCtx, SelectResult, Selector } from "../../framework/types.js";
import type { MuseFeedQuery } from "../query.js";
import type { MuseCandidate } from "../candidate.js";

export class TopKScoreSelector implements Selector<MuseFeedQuery, MuseCandidate> {
  readonly name = "TopKScoreSelector";

  scoreOf(c: MuseCandidate): number {
    return c.score ?? c.weightedScore ?? 0;
  }

  size(_q: MuseFeedQuery, ctx: ExecCtx): number {
    return Math.floor(ctx.params.num("TopKCandidatesToSelect", 100));
  }

  select(
    _q: MuseFeedQuery,
    candidates: MuseCandidate[],
    _ctx: ExecCtx,
  ): SelectResult<MuseCandidate> {
    const k = this.size(_q, _ctx);
    // Deterministic: ties break on postId so a rebuild reproduces the same order.
    const sorted = [...candidates].sort(
      (a, b) =>
        this.scoreOf(b) - this.scoreOf(a) ||
        (a.postId < b.postId ? -1 : a.postId > b.postId ? 1 : 0),
    );
    return { selected: sorted.slice(0, k), nonSelected: sorted.slice(k) };
  }
}
