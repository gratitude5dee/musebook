// packages/muse-mixer/src/muse/sideEffects/index.ts
// §9.22 — the side effects, closed over the built slate. They run AFTER the
// pass returns, parallel allSettled; a rejection is a logged counter, not a retry.
// The slate write itself is NOT one of them (§9.22: PersistSlateSideEffect is
// gone — the pass writes it in one statement, synchronously).
import type { ExecCtx, SideEffect, SideEffectInput } from "../../framework/types.js";
import type { MuseFeedQuery } from "../query.js";
import type { MuseCandidate } from "../candidate.js";
import type { MuseRanker } from "../scorers/muse_scorer.js";
import type { WeightsLoader } from "../weights.js";
import { candidateFeatures, viewerContextFor } from "../scorers/muse_scorer.js";
import { computeWeightedScore } from "../scorers/ranking_scorer.js";
import { cohortKeyFor } from "../weights.js";
import { SeenBloom, bloomParams } from "../bloom.js";
import { weightsRowVersion } from "../build.js";

type In = SideEffectInput<MuseFeedQuery, MuseCandidate>;

function isoWeek(now: number): string {
  const d = new Date(now);
  const day = (d.getUTCDay() + 6) % 7;
  const thursday = new Date(d.getTime() - day * 86400000 + 3 * 86400000);
  const firstThursday = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * 86400000));
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** 2 — update the seen bloom + exact ring buffer (§9.16). */
export function updateSeenBloomEffect(): SideEffect<MuseFeedQuery, MuseCandidate> {
  return {
    name: "UpdateSeenBloom",
    async run(input: In, ctx: ExecCtx): Promise<void> {
      const q = input.query;
      if (q.viewerId === null) return;
      const servedIds = input.selected.map((c) => c.postId);
      const capacity = ctx.params.num("MuseSeenBloomCapacity", 5000);
      const errorRate = ctx.params.num("MuseSeenBloomErrorRate", 0.001);
      const { m, k } = bloomParams(capacity, errorRate);
      const bloom =
        q.seenBloomSerialized === null
          ? SeenBloom.create(m, k)
          : (SeenBloom.deserialize(q.seenBloomSerialized) ?? SeenBloom.create(m, k));
      for (const id of servedIds) bloom.add(id);
      await ctx.db.bloom.updateSeen({
        viewerUserId: q.viewerId,
        isoWeek: isoWeek(ctx.now),
        filterJson: JSON.parse(bloom.serialize()),
        servedIds,
        maxRecentIds: ctx.params.num("MuseSeenExactWindow", 500),
      });
    },
  };
}

/** 3 — telemetry: the served slate's summary row (AE + stats counters). */
export function telemetryEffect(): SideEffect<MuseFeedQuery, MuseCandidate> {
  return {
    name: "SlateTelemetry",
    run(input: In, ctx: ExecCtx): Promise<void> {
      const q = input.query;
      ctx.db.telemetry.writeDataPoint("muse.slate.size", input.selected.length, {
        surface: q.surface,
        weights_version: q.weightsVersion,
        model_version: q.modelVersion,
      });
      ctx.db.telemetry.writeDataPoint("muse.slate.pool", input.nonSelected.length, {
        surface: q.surface,
      });
      if (input.selected.length === 0) {
        ctx.db.telemetry.writeDataPoint("muse.slate.empty", 1, { surface: q.surface });
      }
      return Promise.resolve();
    },
  };
}

/** 4 — impression rows: the slate items are impressions by definition. */
export function slateImpressionsEffect(): SideEffect<MuseFeedQuery, MuseCandidate> {
  return {
    name: "SlateImpressions",
    async run(input: In, ctx: ExecCtx): Promise<void> {
      const q = input.query;
      if (q.agentId !== null) {
        // Agent viewers report through the server-side plane (§13): insert directly.
        const rows = input.selected.map((c, i) => ({
          action: "impression",
          post_id: c.postId,
          content_hash: c.contentHash,
          slate_id: q.slateId,
          position: i,
          surface: q.surface,
          agent_id: q.agentId,
          // action_events.weights_version is an FK into ranking_weights' PK —
          // the version alone, never the candidate's version/cohort compound.
          weights_version: weightsRowVersion(c.weightsVersion ?? q.weightsVersion),
          model_version: q.modelVersion,
        }));
        await ctx.db.telemetry.insertAgentActions(rows);
      }
      // Human impressions are written by the edge ingest path on /api/events —
      // the build only persists the slate itself.
    },
  };
}

/**
 * 5 — §9.18's shadow scoring. When `model_registry` holds a `shadow` row the
 * candidate ranker scores every built slate and serves nothing: one
 * `muse.shadow_score` Analytics Engine point per selected candidate, carrying
 * the shadow model's OWN weighted score (its predictions re-weighted by the
 * same resolved ActionWeights the incumbent's RankingScorer used) — never the
 * incumbent's score relabeled. It writes no table: section 4 is canonical and
 * AE retains the week the comparison needs.
 */
export function shadowScoreEffect(
  shadow: MuseRanker,
  weightsLoader: WeightsLoader,
): SideEffect<MuseFeedQuery, MuseCandidate> {
  return {
    name: "ShadowScore",
    async run(input: In, ctx: ExecCtx): Promise<void> {
      const q = input.query;
      if (input.selected.length === 0) return;
      const vc = q.viewerContext ?? viewerContextFor(q, ctx);
      const w = await weightsLoader.load(cohortKeyFor(q, ctx));
      const weightsVersion = weightsRowVersion(`${w.version}/${w.cohort}`);
      const feats = input.selected.map((c) => candidateFeatures(c, q, vc, ctx));
      const preds = await shadow.predict(vc, feats);
      input.selected.forEach((c, i) => {
        const pr = preds[i];
        if (pr === undefined) return;
        const shadowScore = computeWeightedScore(
          { ...c, actionScores: pr.discrete, continuousPreds: pr.continuous },
          q,
          w,
        );
        ctx.db.telemetry.writeShadowPoint({
          postId: c.postId,
          slateId: q.slateId,
          surface: q.surface,
          weightsVersion,
          modelVersion: shadow.modelVersion,
          plane: q.agentId !== null ? "agent" : "human",
          position: i,
          value: shadowScore,
        });
      });
    },
  };
}
