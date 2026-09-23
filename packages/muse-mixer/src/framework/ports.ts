// packages/muse-mixer/src/framework/ports.ts
import type { PostKind, PublishMode, Surface } from "@musebook/schema";

export interface DbHandles {
  graph: GraphPort; // follows, blocks, mutes (§4.5)
  recent: RecentActionsPort; // loadViewerSequence() -> viewer_recent_actions (§13.7.2)
  retrieval: RetrievalPort; // post_embeddings / user_embeddings ANN (§4.7)
  posts: PostsPort; // posts, post_counters, loadPostStats() -> post_stats_rolling
  monetization: MonetizationPort; // kernel projection surface — never the column (§9.8)
  slates: SlatePort; // slates + slate_items (§4.8)
  bloom: BloomPort; // viewer_seen_bloom (§9.7)
  clusters: ClusterPort; // creator_clusters (§9.7)
  telemetry: TelemetryPort; // agent-plane rows + Analytics Engine points (§13)
}

export interface MonetizationPort {
  /** One call per batch. Implemented outside the mixer with the kernel's projections. */
  forCandidates(input: {
    postIds: readonly string[];
    contentHashes: readonly string[];
    viewerUserId: string | null;
    viewerWallet: string | null;
  }): Promise<
    ReadonlyMap<string, { mode: PublishMode; priceUsd: string | null; viewerEntitled: boolean }>
  >;
}

export interface SlatePort {
  /**
   * The whole slate in ONE statement: header + items, written after the pass, not
   * before it. Nothing reads a half-written slate because nothing can see it until
   * the statement commits.
   */
  writeSlate(row: {
    id: string;
    viewerUserId: string | null;
    viewerAgentId: string | null;
    surface: Surface;
    weightsVersion: string;
    modelVersion: string;
    params: Record<string, unknown>;
    expiresAt: Date;
    items: ReadonlyArray<{
      position: number;
      postId: string;
      source: string;
      actionScores: Record<string, number>;
      weightedScore: number | null;
      score: number | null;
    }>;
  }): Promise<void>;
  /** Warm start (§9.11): the viewer's most recent still-valid slate, for score reuse. */
  previousScores(
    viewerUserId: string | null,
    viewerAgentId: string | null,
    surface: Surface,
  ): Promise<{
    modelVersion: string;
    viewerContextVersion: string;
    createdAtMs: number;
    scores: ReadonlyMap<string, { actionScores: Record<string, number> }>;
  } | null>;
  /** Build-time dedupe guard (§9.17): false when a fresh-enough slate already exists. */
  needsBuild(
    viewerUserId: string | null,
    viewerAgentId: string | null,
    surface: Surface,
    minRemainingSeconds: number,
  ): Promise<boolean>;
}

export type PostKindFilter = readonly PostKind[] | null;

/** The social graph a viewer's feed is built from (§4.5). */
export interface GraphPort {
  /** creators this viewer follows (target_kind='user'). */
  followedCreatorIds(viewerUserId: string): Promise<string[]>;
  /** creators following this viewer — intersected by the caller for mutuals. */
  followerCreatorIds(viewerUserId: string): Promise<string[]>;
  /** topic ids this viewer follows (target_kind='topic'). */
  followedTopicIds(viewerUserId: string): Promise<string[]>;
  /** blocks authored by the viewer. */
  blockedUserIds(viewerUserId: string): Promise<string[]>;
  /** active mutes authored by the viewer: user ids + keyword strings. */
  mutedBy(viewerUserId: string): Promise<{ userIds: string[]; keywords: string[] }>;
  /**
   * EntitlementsQueryHydrator (§9.6): content hashes under an active grant for
   * this viewer. Adapter implements this on HYPERDRIVE_FRESH — it's a grant read.
   */
  paidContentHashes(viewerUserId: string, viewerWallet: string | null): Promise<string[]>;
  /** CreatorHydrator: profiles + follower count keyed by user id. */
  loadCreators(creatorIds: readonly string[]): Promise<
    ReadonlyMap<
      string,
      {
        username: string;
        displayName: string | null;
        followersCount: number;
      }
    >
  >;
}

/**
 * §13.7.5's fixed method name: the only way the mixer sees viewer history — the
 * worker-maintained projection, never `action_events` itself.
 */
export interface ViewerSequence {
  actionCount: number;
  /** last 128 actions newest-first: {action, post_id, creator_id, topics[], occurred_at_ms} */
  actions: ReadonlyArray<{
    action: string;
    postId: string | null;
    creatorId: string | null;
    topics: readonly string[];
    occurredAtMs: number;
  }>;
  /** per-topic engagement tally the inferred-topics hydrator reads. */
  topicCounts: ReadonlyMap<string, number>;
  computedAt: string | null;
}

export interface RecentActionsPort {
  loadViewerSequence(
    viewerUserId: string | null,
    viewerAgentId: string | null,
  ): Promise<ViewerSequence | null>;
}

export interface RetrievalPort {
  /** user_embeddings.embedding for the viewer, or null when no row exists. */
  viewerEmbedding(viewerUserId: string): Promise<number[] | null>;
  /** app.retrieve_similar_posts: ANN over post_embeddings via §9.7's function. */
  similarPosts(
    probe: readonly number[],
    input: {
      hours: number;
      kinds: PostKindFilter;
      excludeAuthorIds: readonly string[];
      limit: number;
      efSearch?: number;
    },
  ): Promise<
    Array<{
      postId: string;
      contentHash: string;
      authorUserId: string;
      creatorKind: "human" | "agent";
      kind: PostKind;
      publishedAtMs: number;
      remixRootId: string | null;
      sim: number;
    }>
  >;
  /** embeddings of an arbitrary post set (only loaded for MUSE_DIVERSITY_IMPL='mmr'). */
  postEmbeddings(contentHashes: readonly string[]): Promise<ReadonlyMap<string, number[]>>;
  /** cohort-centroid stand-in for a 1–19-action viewer (§9.14). */
  newUserIndexEmbedding(indexId: string): Promise<number[] | null>;
}

export interface PostCoreRow {
  postId: string;
  contentHash: string;
  title: string;
  summary: string | null;
  languageCode: string | null;
  kind: PostKind;
  authorUserId: string;
  creatorKind: "human" | "agent";
  publishedAtMs: number;
  remixRootId: string | null;
}

export interface PostStatsRow {
  postId: string;
  counters: {
    impressions: number;
    opens: number;
    likes: number;
    comments: number;
    reposts: number;
    bookmarks: number;
    paidFetches: number;
    dwellMsTotal: number;
  };
  rolling: {
    humanImpressions24h: number;
    humanOpens24h: number;
    dwellMsP50_24h: number;
    dwellMsP90_24h: number;
    completionRate24h: number;
    replays24h: number;
    engagements24h: number;
    agentFetches24h: number;
    distinctAgents24h: number;
    signedAgentFetches24h: number;
    citations7d: number;
    purchases24h: number;
    velocity24h: number;
  };
}

export interface PostsPort {
  /** posts ⋈ post_assets ⋈ assets, one batched read by id = any(). */
  loadCore(postIds: readonly string[]): Promise<ReadonlyMap<string, PostCoreRow>>;
  loadMedia(postIds: readonly string[]): Promise<
    ReadonlyMap<
      string,
      {
        durationMs: number | null;
        width: number | null;
        height: number | null;
        mediaUrl: string | null;
        thumbnailUrl: string | null;
        storage: "r2_public" | "r2_paid" | "r2_artifacts";
      }
    >
  >;
  /** §13.7.5's fixed method name: post_counters + post_stats_rolling, never the post row. */
  loadPostStats(postIds: readonly string[]): Promise<ReadonlyMap<string, PostStatsRow>>;
  /** trending/velocity reads for TrendingSource + CompletionTrendingSource. */
  trending(input: { hours: number; kinds: PostKindFilter; limit: number }): Promise<PostCoreRow[]>;
  /** classification rows by content_hash (topics, primary_topic, taxonomy_leaf, quality, …). */
  loadClassifications(contentHashes: readonly string[]): Promise<
    ReadonlyMap<
      string,
      {
        topics: string[];
        primaryTopic: string | null;
        taxonomyLeaf: string | null;
        taxonomyPath: string[];
        quality: number | null;
        qAgentValue: number | null;
        pUnsafe: number | null;
        toxicity: number | null;
        isNsfw: boolean;
        topicProbabilities: Record<string, number>;
      }
    >
  >;
  /** agent_identities rows for agent-authored provenance. */
  loadAgentIdentities(agentIds: readonly string[]): Promise<
    ReadonlyMap<
      string,
      {
        agentId: string;
        verification: string;
        isBlocked: boolean;
      }
    >
  >;
  /** fork metadata for artifacts (remixRootId, fork counts, asset ids). */
  loadArtifactState(postIds: readonly string[]): Promise<
    ReadonlyMap<
      string,
      {
        appId: string;
        runtime: "2d" | "3d" | "mcp";
        installs: number;
        forks: number;
        remixRootId: string | null;
      }
    >
  >;
  /** generic source query helper — adapters/postgres/sql/*.sql by name. */
  runSourceQuery(sql: string, params: readonly unknown[]): Promise<PostCoreRow[]>;
}

export interface SeenState {
  viewerUserId: string;
  isoWeek: string;
  filterJson: unknown;
  prevFilterJson: unknown;
  recentIds: string[];
  updatedAt: string;
}

export interface BloomPort {
  loadSeen(viewerUserId: string): Promise<SeenState | null>;
  /** upsert: current filter, rotation into prev_filter_json, recent_ids ring buffer. */
  updateSeen(input: {
    viewerUserId: string;
    isoWeek: string;
    filterJson: unknown;
    servedIds: readonly string[];
    maxRecentIds: number;
  }): Promise<void>;
}

export interface ClusterPort {
  /** cluster memberships for a creator set (creator_clusters). */
  clustersForCreators(
    creatorIds: readonly string[],
  ): Promise<ReadonlyMap<string, Array<{ clusterId: number; weight: number }>>>;
  /** top creators of a cluster set, by weight. */
  creatorsForClusters(
    clusterIds: readonly number[],
    limit: number,
  ): Promise<Array<{ creatorId: string; clusterId: number; weight: number }>>;
  /** clusters of the creators the viewer engaged with (CoEngagementSource). */
  viewerClusters(
    viewerUserId: string,
    limit: number,
  ): Promise<Array<{ clusterId: number; weight: number }>>;
}

export interface TelemetryPort {
  /** Analytics Engine writeDataPoint — fire-and-forget. */
  writeDataPoint(metric: string, value: number, tags?: Record<string, string>): void;
  /** agent-plane action rows written server-side (§13); human plane reports via ingest. */
  insertAgentActions(rows: ReadonlyArray<Record<string, unknown>>): Promise<void>;
}
