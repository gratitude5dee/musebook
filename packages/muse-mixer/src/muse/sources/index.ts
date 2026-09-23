// packages/muse-mixer/src/muse/sources/index.ts
// §9.7 — the 11 parallel sources + ReverseChronSource fallback. Each is capped at
// MUSE_MAX_CANDIDATES_PER_SOURCE (400) by the caller's OWN limit; the executor
// clamps the wall clock via ctx.budgetMs('sources'). None of these files imports
// a platform library — SQL text lives in adapters/postgres/sql/*.sql, resolved
// through ctx.db.posts.runSourceQuery().
import type { ExecCtx, Source } from "../../framework/types.js";
import type { MuseFeedQuery } from "../query.js";
import type { MuseCandidate } from "../candidate.js";
import type { PostKind } from "@musebook/schema";

const MAX_PER_SOURCE = 400;

function base(id: string, source: string, extras: Partial<MuseCandidate> = {}): MuseCandidate {
  return {
    candidateId: id,
    postId: id,
    contentHash: extras.contentHash ?? "",
    kind: extras.kind ?? "note",
    creatorId: extras.creatorId ?? "",
    creatorKind: extras.creatorKind ?? "human",
    publishedAt: extras.publishedAt ?? 0,
    sourceNames: [source],
    inNetwork: extras.inNetwork ?? false,
    mutualFollow: extras.mutualFollow ?? false,
    monetization: extras.monetization ?? { mode: "free", priceUsd: null, viewerEntitled: false },
    ...extras,
  };
}

function toCandidate(
  row: {
    postId: string;
    contentHash: string;
    authorUserId: string;
    creatorKind: "human" | "agent";
    kind: PostKind;
    publishedAtMs: number;
    remixRootId: string | null;
    sim?: number;
  },
  source: string,
  extras: Partial<MuseCandidate> = {},
): MuseCandidate {
  const fields: Partial<MuseCandidate> = {
    contentHash: row.contentHash,
    creatorId: row.authorUserId,
    creatorKind: row.creatorKind,
    kind: row.kind,
    publishedAt: row.publishedAtMs,
  };
  if (row.remixRootId !== null) fields.remixRootId = row.remixRootId;
  if (row.sim !== undefined) fields.sourceScore = row.sim;
  return base(row.postId, source, { ...fields, ...extras });
}

function reelsKinds(q: MuseFeedQuery): PostKind[] | null {
  return q.surface === "reels"
    ? ["video", "audio"]
    : q.includeKinds.length === 0
      ? null
      : q.includeKinds;
}

/** 1 — in-network posts from followed creators, 48 h (thunder_source). */
export class FollowGraphSource implements Source<MuseFeedQuery, MuseCandidate> {
  readonly name = "FollowGraphSource";
  enable(q: MuseFeedQuery): boolean {
    return q.followedCreatorIds.length > 0;
  }
  async source(q: MuseFeedQuery, ctx: ExecCtx): Promise<MuseCandidate[]> {
    const rows = await ctx.db.posts.runSourceQuery("follow_graph", [
      q.followedCreatorIds,
      q.viewerId,
      reelsKinds(q),
      MAX_PER_SOURCE,
    ]);
    const mutual = new Set(q.mutualFollowCreatorIds);
    return rows.map((r) =>
      toCandidate(r, this.name, { inNetwork: true, mutualFollow: mutual.has(r.authorUserId) }),
    );
  }
}

/** 2 — pgvector ANN over post_embeddings with viewerEmbedding as the probe (phoenix_source). */
export class EmbeddingRetrievalSource implements Source<MuseFeedQuery, MuseCandidate> {
  readonly name = "EmbeddingRetrievalSource";
  enable(q: MuseFeedQuery): boolean {
    return q.viewerEmbedding !== null;
  }
  async source(q: MuseFeedQuery, ctx: ExecCtx): Promise<MuseCandidate[]> {
    const rows = await ctx.db.retrieval.similarPosts(q.viewerEmbedding as number[], {
      hours: 24 * 30,
      kinds: reelsKinds(q),
      excludeAuthorIds: q.viewerId === null ? [] : [q.viewerId],
      limit: MAX_PER_SOURCE,
      efSearch: ctx.params.num("MuseAnnEfSearch", 200),
    });
    return rows.map((r) => toCandidate(r, this.name));
  }
}

/** 3 — GIN topics over followed + inferred ids (phoenix_topics_source). */
export class TopicSource implements Source<MuseFeedQuery, MuseCandidate> {
  readonly name = "TopicSource";
  enable(q: MuseFeedQuery): boolean {
    return q.followedTopicIds.length + q.inferredTopicIds.length + q.topicIds.length > 0;
  }
  async source(q: MuseFeedQuery, ctx: ExecCtx): Promise<MuseCandidate[]> {
    const topics = [...new Set([...q.topicIds, ...q.followedTopicIds, ...q.inferredTopicIds])];
    const rows = await ctx.db.posts.runSourceQuery("topic", [
      topics,
      reelsKinds(q),
      MAX_PER_SOURCE,
    ]);
    return rows.map((r) => toCandidate(r, this.name));
  }
}

/** 4 — velocity-ranked recent posts (popular_topics_source). */
export class TrendingSource implements Source<MuseFeedQuery, MuseCandidate> {
  readonly name = "TrendingSource";
  async source(q: MuseFeedQuery, ctx: ExecCtx): Promise<MuseCandidate[]> {
    const rows = await ctx.db.posts.trending({
      hours: 24 * 7,
      kinds: reelsKinds(q),
      limit: MAX_PER_SOURCE,
    });
    return rows.map((r) => toCandidate(r, this.name, { sourceScore: 0 }));
  }
}

/** 5 — creator-cluster analog of simclusters_source (§9.7). */
export class CoEngagementSource implements Source<MuseFeedQuery, MuseCandidate> {
  readonly name = "CoEngagementSource";
  enable(q: MuseFeedQuery): boolean {
    return q.actionCount >= 10;
  }
  async source(q: MuseFeedQuery, ctx: ExecCtx): Promise<MuseCandidate[]> {
    if (q.viewerId === null) return [];
    const clusters = await ctx.db.clusters.viewerClusters(q.viewerId, 8);
    if (clusters.length === 0) return [];
    const creators = await ctx.db.clusters.creatorsForClusters(
      clusters.map((c) => c.clusterId),
      60,
    );
    const exclude = new Set([q.viewerId]);
    const creatorIds = creators.map((c) => c.creatorId).filter((id) => !exclude.has(id));
    if (creatorIds.length === 0) return [];
    const rows = await ctx.db.posts.runSourceQuery("by_authors_recent", [
      creatorIds,
      reelsKinds(q),
      MAX_PER_SOURCE,
    ]);
    const weight = new Map(creators.map((c) => [c.creatorId, c.weight]));
    return rows.map((r) => {
      const w0 = weight.get(r.authorUserId);
      return toCandidate(r, this.name, w0 === undefined ? {} : { sourceScore: w0 });
    });
  }
}

/** 6 — posts authored by an agent identity (Musebook-specific). */
export class AgentAuthoredSource implements Source<MuseFeedQuery, MuseCandidate> {
  readonly name = "AgentAuthoredSource";
  async source(q: MuseFeedQuery, ctx: ExecCtx): Promise<MuseCandidate[]> {
    const rows = await ctx.db.posts.runSourceQuery("agent_authored", [
      reelsKinds(q),
      MAX_PER_SOURCE,
    ]);
    return rows.map((r) => toCandidate(r, this.name));
  }
}

/** 7 — app/model3d artifacts, ordered by co-install over viewer actions (jetfuel_frame_source). */
export class AppArtifactSource implements Source<MuseFeedQuery, MuseCandidate> {
  readonly name = "AppArtifactSource";
  enable(q: MuseFeedQuery): boolean {
    return q.includeKinds.some((k) => k === "app" || k === "model3d");
  }
  async source(q: MuseFeedQuery, ctx: ExecCtx): Promise<MuseCandidate[]> {
    const rows = await ctx.db.posts.runSourceQuery("app_artifact", [q.viewerId, MAX_PER_SOURCE]);
    return rows.map((r) => toCandidate(r, this.name));
  }
}

/** 8 — same fork tree as something the viewer remixed/forked (no-op before M16 artifacts). */
export class RemixLineageSource implements Source<MuseFeedQuery, MuseCandidate> {
  readonly name = "RemixLineageSource";
  async source(q: MuseFeedQuery, ctx: ExecCtx): Promise<MuseCandidate[]> {
    if (q.viewerId === null) return [];
    const seq = await ctx.db.recent.loadViewerSequence(q.viewerId, q.agentId);
    const engaged = (seq?.actions ?? []).filter(
      (a) => a.action === "remix" || a.action === "fork_app",
    );
    if (engaged.length === 0) return [];
    const roots = [...new Set(engaged.map((a) => a.postId).filter((x): x is string => x !== null))];
    const rows = await ctx.db.posts.runSourceQuery("remix_lineage", [
      roots,
      reelsKinds(q),
      MAX_PER_SOURCE,
    ]);
    return rows.map((r) => toCandidate(r, this.name));
  }
}

/** 9 — fresh posts below the impression threshold, for exploration (seed_candidates_source). */
export class ColdStartSeedSource implements Source<MuseFeedQuery, MuseCandidate> {
  readonly name = "ColdStartSeedSource";
  async source(q: MuseFeedQuery, ctx: ExecCtx): Promise<MuseCandidate[]> {
    if (!ctx.params.bool("ColdStartEnabled", true)) return [];
    const rows = await ctx.db.posts.runSourceQuery("cold_start_seed", [
      ctx.params.num("ColdStartImpressionThreshold", 50),
      reelsKinds(q),
      MAX_PER_SOURCE,
    ]);
    return rows.map((r) => toCandidate(r, this.name));
  }
}

/** 10 — reels: velocity top-500 re-ranked in memory by completion_rate_24h (§9.24). */
export class CompletionTrendingSource implements Source<MuseFeedQuery, MuseCandidate> {
  readonly name = "CompletionTrendingSource";
  enable(q: MuseFeedQuery): boolean {
    return q.surface === "reels";
  }
  async source(_q: MuseFeedQuery, ctx: ExecCtx): Promise<MuseCandidate[]> {
    const rows = await ctx.db.posts.runSourceQuery("completion_trending", [
      ["video", "audio"],
      500,
    ]);
    const stats = await ctx.db.posts.loadPostStats(rows.map((r) => r.postId));
    return rows
      .map((r) => ({ r, completion: stats.get(r.postId)?.rolling.completionRate24h ?? 0 }))
      .sort((a, b) => b.completion - a.completion)
      .slice(0, MAX_PER_SOURCE)
      .map(({ r, completion }) => toCandidate(r, this.name, { sourceScore: completion }));
  }
}

/** 11 — reels: other posts carrying an asset the viewer played through (§9.24). */
export class SoundtrackSource implements Source<MuseFeedQuery, MuseCandidate> {
  readonly name = "SoundtrackSource";
  enable(q: MuseFeedQuery): boolean {
    return q.surface === "reels";
  }
  async source(q: MuseFeedQuery, ctx: ExecCtx): Promise<MuseCandidate[]> {
    if (q.viewerId === null) return [];
    const rows = await ctx.db.posts.runSourceQuery("soundtrack", [q.viewerId, MAX_PER_SOURCE]);
    return rows.map((r) => toCandidate(r, this.name));
  }
}

/** Fallback ladder only — MogBook mog-feed keyset query (reverse_chron_posts_source). */
export class ReverseChronSource implements Source<MuseFeedQuery, MuseCandidate> {
  readonly name = "ReverseChronSource";
  async source(q: MuseFeedQuery, ctx: ExecCtx): Promise<MuseCandidate[]> {
    const rows = await ctx.db.posts.runSourceQuery("reverse_chron", [
      q.viewerId,
      q.followedCreatorIds,
      reelsKinds(q),
      q.limit * 5,
    ]);
    return rows.map((r) =>
      toCandidate(r, this.name, { inNetwork: q.followedCreatorIds.includes(r.authorUserId) }),
    );
  }
}
