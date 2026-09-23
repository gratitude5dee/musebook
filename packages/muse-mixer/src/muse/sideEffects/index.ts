// packages/muse-mixer/src/muse/sideEffects/index.ts
// §9.22 — the four side effects, closed over the built slate. They run AFTER the
// pass returns, parallel allSettled; a rejection is a logged counter, not a retry.
import type { ExecCtx, SideEffect, SideEffectInput } from "../../framework/types.js";
import type { MuseFeedQuery } from "../query.js";
import type { MuseCandidate } from "../candidate.js";
import { SeenBloom, bloomParams } from "../bloom.js";

type In = SideEffectInput<MuseFeedQuery, MuseCandidate>;

function isoWeek(now: number): string {
  const d = new Date(now);
  const day = (d.getUTCDay() + 6) % 7;
  const thursday = new Date(d.getTime() - day * 86400000 + 3 * 86400000);
  const firstThursday = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * 86400000));
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** 1 — persist the slate: header + items in ONE statement (§9.7 writeSlate). */
export function writeSlateEffect(): SideEffect<MuseFeedQuery, MuseCandidate> {
  return {
    name: "WriteSlate",
    async run(input: In, ctx: ExecCtx): Promise<void> {
      const q = input.query;
      const items = input.selected.map((c, i) => ({
        position: i,
        postId: c.postId,
        source: c.sourceNames[0] ?? "unknown",
        actionScores: Object.fromEntries(
          Object.entries(c.actionScores ?? {}).filter(
            (e): e is [string, number] => e[1] !== undefined,
          ),
        ),
        weightedScore: c.weightedScore ?? null,
        score: c.score ?? null,
      }));
      await ctx.db.slates.writeSlate({
        id: q.slateId,
        viewerUserId: q.viewerId,
        viewerAgentId: q.agentId,
        surface: q.surface,
        weightsVersion: input.selected[0]?.weightsVersion ?? `${q.weightsVersion}/default`,
        modelVersion: q.modelVersion,
        params: {
          viewerContextVersion: q.viewerContextVersion,
          actionCount: q.actionCount,
          limit: q.limit,
        },
        expiresAt: new Date(ctx.now + 900_000),
        items,
      });
    },
  };
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
          weights_version: c.weightsVersion ?? q.weightsVersion,
          model_version: q.modelVersion,
        }));
        await ctx.db.telemetry.insertAgentActions(rows);
      }
      // Human impressions are written by the edge ingest path on /api/events —
      // the build only persists the slate itself.
    },
  };
}
