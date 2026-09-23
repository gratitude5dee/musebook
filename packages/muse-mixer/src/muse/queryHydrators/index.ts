// packages/muse-mixer/src/muse/queryHydrators/index.ts
// §9.6 — the 13 query hydrators, verbatim names + dependsOn DAG. All run in
// allSettled layers; each writes ONLY its own MuseFeedQuery fields (Partial<Q>
// makes that a type error to break). A rejection leaves the default in place —
// with the single documented exception: blockMuteLoaded stays false, which makes
// BlockMuteFilter degrade CLOSED (§9.6's fail-closed note).
import type { ExecCtx, QueryHydrator } from "../../framework/types.js";
import type { MuseFeedQuery } from "../query.js";
import { stableBucket } from "../weights.js";
import { fnv1a32 } from "../rng.js";

type Ctx = ExecCtx;

/** 1 — actionCount from viewer_recent_actions (§13.7.5: never action_events). */
export class ViewerProfileQueryHydrator implements QueryHydrator<MuseFeedQuery> {
  readonly name = "ViewerProfileQueryHydrator";
  async hydrate(q: MuseFeedQuery, ctx: Ctx): Promise<Partial<MuseFeedQuery>> {
    if (q.viewerId === null) return { actionCount: 0 };
    const seq = await ctx.db.recent.loadViewerSequence(q.viewerId, q.agentId);
    return { actionCount: seq?.actionCount ?? 0 };
  }
}

/** 2 — follows where follower_user_id = $viewer and target_kind = 'user'. */
export class FollowGraphQueryHydrator implements QueryHydrator<MuseFeedQuery> {
  readonly name = "FollowGraphQueryHydrator";
  async hydrate(q: MuseFeedQuery, ctx: Ctx): Promise<Partial<MuseFeedQuery>> {
    if (q.viewerId === null) return { followedCreatorIds: [] };
    return { followedCreatorIds: await ctx.db.graph.followedCreatorIds(q.viewerId) };
  }
}

/** 3 — reverse edge ∩ followedCreatorIds → mutualFollowCreatorIds. */
export class MutualFollowQueryHydrator implements QueryHydrator<MuseFeedQuery> {
  readonly name = "MutualFollowQueryHydrator";
  readonly dependsOn = ["FollowGraphQueryHydrator"] as const;
  async hydrate(q: MuseFeedQuery, ctx: Ctx): Promise<Partial<MuseFeedQuery>> {
    if (q.viewerId === null) return { mutualFollowCreatorIds: [] };
    const followers = await ctx.db.graph.followerCreatorIds(q.viewerId);
    const followerSet = new Set(followers);
    return { mutualFollowCreatorIds: q.followedCreatorIds.filter((id) => followerSet.has(id)) };
  }
}

/** 4 — blocks + active mutes + muted keywords. Sets blockMuteLoaded = true. */
export class BlockMuteQueryHydrator implements QueryHydrator<MuseFeedQuery> {
  readonly name = "BlockMuteQueryHydrator";
  async hydrate(q: MuseFeedQuery, ctx: Ctx): Promise<Partial<MuseFeedQuery>> {
    if (q.viewerId === null) {
      return {
        blockedCreatorIds: [],
        mutedCreatorIds: [],
        mutedKeywords: [],
        blockMuteLoaded: true,
      };
    }
    const [blocked, muted] = await Promise.all([
      ctx.db.graph.blockedUserIds(q.viewerId),
      ctx.db.graph.mutedBy(q.viewerId),
    ]);
    return {
      blockedCreatorIds: blocked,
      mutedCreatorIds: muted.userIds,
      mutedKeywords: muted.keywords,
      blockMuteLoaded: true,
    };
  }
}

/** 5 — the last-128-actions sequence, internal, feeds MuseScorer's ViewerContext. */
export class ScoringSequenceQueryHydrator implements QueryHydrator<MuseFeedQuery> {
  readonly name = "ScoringSequenceQueryHydrator";
  async hydrate(q: MuseFeedQuery, ctx: Ctx): Promise<Partial<MuseFeedQuery>> {
    if (q.viewerId === null) return { viewerSequence: null };
    return { viewerSequence: await ctx.db.recent.loadViewerSequence(q.viewerId, q.agentId) };
  }
}

/** 6 — same row for the retrieval path (new-user index embedding inputs). */
export class RetrievalSequenceQueryHydrator implements QueryHydrator<MuseFeedQuery> {
  readonly name = "RetrievalSequenceQueryHydrator";
  async hydrate(q: MuseFeedQuery, ctx: Ctx): Promise<Partial<MuseFeedQuery>> {
    if (q.viewerId === null) return { retrievalSequence: null };
    return { retrievalSequence: await ctx.db.recent.loadViewerSequence(q.viewerId, q.agentId) };
  }
}

/** 7 — user_embeddings where user_id = $viewer, or the new-user centroid fallback. */
export class ViewerEmbeddingQueryHydrator implements QueryHydrator<MuseFeedQuery> {
  readonly name = "ViewerEmbeddingQueryHydrator";
  readonly dependsOn = ["RetrievalSequenceQueryHydrator"] as const;
  async hydrate(q: MuseFeedQuery, ctx: Ctx): Promise<Partial<MuseFeedQuery>> {
    if (q.viewerId === null) return { viewerEmbedding: null };
    const own = await ctx.db.retrieval.viewerEmbedding(q.viewerId);
    if (own !== null) return { viewerEmbedding: own };
    // 1–19-action viewers get the cohort centroid (§9.14), not a zero vector.
    const n = q.retrievalSequence?.actionCount ?? 0;
    const threshold = ctx.params.num("MuseRetrievalNewUserActionThreshold", 20);
    if (n > 0 && n < threshold) {
      return { viewerEmbedding: await ctx.db.retrieval.newUserIndexEmbedding("new-user") };
    }
    return { viewerEmbedding: null };
  }
}

/** 8 — follows where follower_user_id = $viewer and target_kind = 'topic'. */
export class FollowedTopicsQueryHydrator implements QueryHydrator<MuseFeedQuery> {
  readonly name = "FollowedTopicsQueryHydrator";
  async hydrate(q: MuseFeedQuery, ctx: Ctx): Promise<Partial<MuseFeedQuery>> {
    if (q.viewerId === null) return { followedTopicIds: [] };
    return { followedTopicIds: await ctx.db.graph.followedTopicIds(q.viewerId) };
  }
}

/** 9 — viewer_recent_actions.topic_counts, top 8 keys by count. */
export class InferredTopicsQueryHydrator implements QueryHydrator<MuseFeedQuery> {
  readonly name = "InferredTopicsQueryHydrator";
  readonly dependsOn = ["ScoringSequenceQueryHydrator"] as const;
  hydrate(q: MuseFeedQuery): Promise<Partial<MuseFeedQuery>> {
    const seq = q.viewerSequence;
    if (seq === null || seq === undefined) return Promise.resolve({ inferredTopicIds: [] });
    return Promise.resolve({
      inferredTopicIds: [...seq.topicCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([t]) => t),
    });
  }
}

/** 10 — viewer_seen_bloom.filter_json + prev_filter_json. */
export class ImpressionBloomQueryHydrator implements QueryHydrator<MuseFeedQuery> {
  readonly name = "ImpressionBloomQueryHydrator";
  async hydrate(q: MuseFeedQuery, ctx: Ctx): Promise<Partial<MuseFeedQuery>> {
    if (q.viewerId === null) return { seenBloomSerialized: null, seenBloomPrevSerialized: null };
    const seen = await ctx.db.bloom.loadSeen(q.viewerId);
    if (seen === null) return { seenBloomSerialized: null, seenBloomPrevSerialized: null };
    return {
      seenBloomSerialized: seen.filterJson === null ? null : JSON.stringify(seen.filterJson),
      seenBloomPrevSerialized:
        seen.prevFilterJson === null ? null : JSON.stringify(seen.prevFilterJson),
    };
  }
}

/** 11 — viewer_seen_bloom.recent_ids (the exact last-MUSE_SEEN_EXACT_WINDOW ids). */
export class SeenIdsExactQueryHydrator implements QueryHydrator<MuseFeedQuery> {
  readonly name = "SeenIdsExactQueryHydrator";
  async hydrate(q: MuseFeedQuery, ctx: Ctx): Promise<Partial<MuseFeedQuery>> {
    if (q.viewerId === null) return { seenIdsExact: [] };
    const seen = await ctx.db.bloom.loadSeen(q.viewerId);
    return { seenIdsExact: seen?.recentIds ?? [] };
  }
}

/**
 * 12 — access_grants (HYPERDRIVE_FRESH — the one hydrator off the cached binding,
 * §9.6's grant-read rule) + install_app actions → installedAppIds.
 */
export class EntitlementsQueryHydrator implements QueryHydrator<MuseFeedQuery> {
  readonly name = "EntitlementsQueryHydrator";
  async hydrate(q: MuseFeedQuery, ctx: Ctx): Promise<Partial<MuseFeedQuery>> {
    if (q.viewerId === null)
      return { entitlements: { paidContentHashes: [] }, installedAppIds: [] };
    const [paidContentHashes, seq] = await Promise.all([
      ctx.db.graph.paidContentHashes(q.viewerId, q.viewerWallet),
      ctx.db.recent.loadViewerSequence(q.viewerId, q.agentId),
    ]);
    return {
      entitlements: { paidContentHashes },
      installedAppIds: (seq?.actions ?? [])
        .filter((a) => a.action === "install_app")
        .map((a) => a.postId)
        .filter((x): x is string => x !== null),
    };
  }
}

/**
 * 13 — pure: hash(viewerId) % 100 → experiment bucket; resolves weightsVersion /
 * modelVersion and computes viewerContextVersion (the warm-start key, §9.11).
 */
export class ExperimentBucketQueryHydrator implements QueryHydrator<MuseFeedQuery> {
  readonly name = "ExperimentBucketQueryHydrator";
  hydrate(q: MuseFeedQuery, ctx: Ctx): Promise<Partial<MuseFeedQuery>> {
    const bucket = stableBucket(q.viewerId ?? q.slateId);
    const weightsVersion = ctx.params.str(`MuseWeightsVersion.${bucket}`, q.weightsVersion);
    const modelVersion = ctx.params.str(`MuseModelVersion.${bucket}`, q.modelVersion);
    // §9.6: hash of (max(follows.created_at), seq.computed_at 5-min bucket,
    // user_embeddings.updated_at). The ports expose the latter two; the follows
    // component rides along in computedAt's bucket.
    const seqBucket = Math.floor(
      (q.viewerSequence?.computedAt === null ||
      q.viewerSequence === null ||
      q.viewerSequence === undefined
        ? 0
        : Date.parse(q.viewerSequence.computedAt)) /
        (5 * 60 * 1000),
    );
    const viewerContextVersion = `vc-${fnv1a32(`${q.viewerId ?? ""}:${seqBucket}:${q.actionCount}`).toString(16)}`;
    return Promise.resolve({ weightsVersion, modelVersion, viewerContextVersion });
  }
}

export const MUSE_QUERY_HYDRATORS = [
  ViewerProfileQueryHydrator,
  FollowGraphQueryHydrator,
  MutualFollowQueryHydrator,
  BlockMuteQueryHydrator,
  ScoringSequenceQueryHydrator,
  RetrievalSequenceQueryHydrator,
  ViewerEmbeddingQueryHydrator,
  FollowedTopicsQueryHydrator,
  InferredTopicsQueryHydrator,
  ImpressionBloomQueryHydrator,
  SeenIdsExactQueryHydrator,
  EntitlementsQueryHydrator,
  ExperimentBucketQueryHydrator,
] as const;
