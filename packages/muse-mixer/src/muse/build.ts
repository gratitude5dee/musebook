// packages/muse-mixer/src/muse/build.ts — §9.23's two helpers:
// buildQuery() materializes the pipeline query a build runs over;
// slateRowFor() maps the pass result to the ONE-statement row writeSlate()
// persists (header + items — never a side effect, §9.22).
import type { PostKind, Surface } from "@musebook/schema";
import type { ExecCtx } from "../framework/types.js";
import type { ExecuteResult } from "../framework/pipeline.js";
import type { MuseFeedQuery, ViewerKind } from "./query.js";
import type { MuseCandidate } from "./candidate.js";

// Web Crypto's randomUUID — present in Node ≥19 and workerd alike; the
// package's ES2023 lib deliberately doesn't pull in DOM or node globals.
declare const crypto: { randomUUID(): string };

/** The build request — what the MIXER service binding and the hourly cron both
 *  pass in. `actorUserId`/`actorAgentId` are mutually exclusive: one of them is
 *  always null (an agent viewer has no users row; a human has no agent id). */
export interface BuildSlateRequest {
  surface: Surface;
  actorUserId?: string | null;
  actorAgentId?: string | null;
  viewerWallet?: string | null;
  viewerKind?: ViewerKind;
  country?: string | null;
  languageCode?: string | null;
  sessionId?: string;
  limit?: number;
  includeKinds?: PostKind[];
  topicIds?: string[];
  excludedTopicIds?: string[];
}

export function buildQuery(req: BuildSlateRequest, ctx: ExecCtx): MuseFeedQuery {
  const agentId = req.actorAgentId ?? null;
  return {
    requestId: crypto.randomUUID(),
    // ---- build-time inputs
    viewerId: req.actorUserId ?? null,
    viewerWallet: req.viewerWallet ?? null,
    viewerKind: req.viewerKind ?? (agentId === null ? "human" : "agent"),
    agentId,
    surface: req.surface,
    sessionId: req.sessionId ?? crypto.randomUUID(),
    limit: req.limit ?? ctx.params.num("MuseTopkCandidates", 100),
    countryCode: req.country ?? null,
    languageCode: req.languageCode ?? null,
    includeKinds: req.includeKinds ?? [],
    topicIds: req.topicIds ?? [],
    excludedTopicIds: req.excludedTopicIds ?? [],
    // ---- hydrated defaults (a failed hydrator leaves these in place)
    followedCreatorIds: [],
    mutualFollowCreatorIds: [],
    blockedCreatorIds: [],
    mutedCreatorIds: [],
    mutedKeywords: [],
    blockMuteLoaded: false,
    followedTopicIds: [],
    inferredTopicIds: [],
    installedAppIds: [],
    entitlements: { paidContentHashes: [] },
    viewerEmbedding: null,
    seenBloomSerialized: null,
    seenBloomPrevSerialized: null,
    seenIdsExact: [],
    servedIds: [],
    actionCount: 0,
    // ---- resolved config; the ExperimentBucketQueryHydrator may override
    weightsVersion: ctx.params.str("MuseWeightsVersion", "v1"),
    modelVersion: ctx.params.str("MuseRankerModelId", "v1.model-heuristic"),
    slateId: crypto.randomUUID(),
    viewerContextVersion: "",
  };
}

/** Candidate and action-events surfaces carry the resolved `version/cohort`
 *  pair; `slates.weights_version` is an FK to `ranking_weights.weights_version`
 *  whose PK is the version alone. */
export function weightsRowVersion(weightsVersion: string): string {
  return weightsVersion.split("/")[0] ?? weightsVersion;
}

/** ONE-statement row for `ports.slates.writeSlate()` — the slate that exists
 *  is the slate the pass produced, not a side effect that may never run. */
export function slateRowFor(
  query: MuseFeedQuery,
  result: ExecuteResult<MuseFeedQuery, MuseCandidate>,
): Parameters<ExecCtx["db"]["slates"]["writeSlate"]>[0] {
  return {
    id: query.slateId,
    viewerUserId: query.viewerId,
    viewerAgentId: query.agentId,
    surface: query.surface,
    weightsVersion:
      result.selected[0]?.weightsVersion !== undefined
        ? weightsRowVersion(result.selected[0].weightsVersion)
        : query.weightsVersion,
    modelVersion: query.modelVersion,
    params: {
      viewerContextVersion: query.viewerContextVersion,
      actionCount: query.actionCount,
      limit: query.limit,
    },
    expiresAt: new Date(Date.now() + 900_000),
    items: result.selected.map((c, i) => ({
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
    })),
  };
}
