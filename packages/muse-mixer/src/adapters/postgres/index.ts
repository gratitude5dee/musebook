// packages/muse-mixer/src/adapters/postgres/index.ts
// The DbHandles implementation over the codebase-standard `{query}` facade —
// postgres.js (`sql.unsafe`) or pg wrapped into it by the composing app. Every
// grant read goes to `fresh`; everything else to `cached` (§9.7 Hyperdrive
// split). Monetization and telemetry ports are injected — monetization lives in
// apps/worker where the kernel import is allowed, telemetry is AE + jobs plane.
import type { PostKind, Surface } from "@musebook/schema";
import type {
  BloomPort,
  ClusterPort,
  DbHandles,
  GraphPort,
  MonetizationPort,
  PostCoreRow,
  PostKindFilter,
  PostStatsRow,
  PostsPort,
  RecentActionsPort,
  RetrievalPort,
  SeenState,
  SlatePort,
  TelemetryPort,
  ViewerSequence,
} from "../../framework/ports.js";
import type { ActionWeights, CohortKey, WeightsLoader } from "../../muse/weights.js";
import { cohortCandidates } from "../../muse/weights.js";
import { MUSE_ACTIONS, MUSE_CONTINUOUS, MUSE_NEGATIVE_ACTIONS } from "../../muse/actions.js";
import { SOURCE_SQL } from "./sql/index.js";

/** pg-style facade; apps wrap postgres.js `sql.unsafe` into this (apps/mcp client.ts). */
export interface SqlClient {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: T[] }>;
}

const num = (v: unknown): number =>
  typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : Number(v ?? 0);

const vec = (v: unknown): number[] =>
  Array.isArray(v) ? (v as number[]) : (JSON.parse(String(v)) as number[]);

interface SourceRow {
  post_id: string;
  content_hash: string;
  author_user_id: string;
  creator_kind: string;
  kind: PostKind;
  published_at_ms: number;
  remix_root_id: string | null;
  sim?: number | null;
}

function toCoreRow(r: SourceRow): PostCoreRow {
  return {
    postId: r.post_id,
    contentHash: r.content_hash,
    authorUserId: r.author_user_id,
    creatorKind: r.creator_kind === "agent" ? "agent" : "human",
    kind: r.kind,
    title: "",
    summary: null,
    languageCode: null,
    publishedAtMs: num(r.published_at_ms),
    remixRootId: r.remix_root_id,
  };
}

class PgGraph implements GraphPort {
  constructor(
    private readonly cached: SqlClient,
    private readonly fresh: SqlClient,
  ) {}
  async followedCreatorIds(viewerUserId: string): Promise<string[]> {
    const { rows } = await this.cached.query<{ followee_user_id: string }>(
      `select followee_user_id from public.follows
        where follower_user_id = $1 and target_kind = 'user'`,
      [viewerUserId],
    );
    return rows.map((r) => r.followee_user_id);
  }
  async followerCreatorIds(viewerUserId: string): Promise<string[]> {
    const { rows } = await this.cached.query<{ follower_user_id: string }>(
      `select follower_user_id from public.follows
        where followee_user_id = $1 and target_kind = 'user'`,
      [viewerUserId],
    );
    return rows.map((r) => r.follower_user_id);
  }
  async followedTopicIds(viewerUserId: string): Promise<string[]> {
    const { rows } = await this.cached.query<{ topic_id: string }>(
      `select topic_id from public.follows
        where follower_user_id = $1 and target_kind = 'topic'`,
      [viewerUserId],
    );
    return rows.map((r) => r.topic_id);
  }
  async blockedUserIds(viewerUserId: string): Promise<string[]> {
    const { rows } = await this.cached.query<{ blocked_user_id: string }>(
      `select blocked_user_id from public.blocks where blocker_user_id = $1`,
      [viewerUserId],
    );
    return rows.map((r) => r.blocked_user_id);
  }
  async mutedBy(viewerUserId: string): Promise<{ userIds: string[]; keywords: string[] }> {
    const { rows } = await this.cached.query<{
      muted_user_id: string | null;
      muted_keyword: string | null;
    }>(
      `select muted_user_id, muted_keyword from public.mutes
        where muter_user_id = $1 and (expires_at is null or expires_at > now())`,
      [viewerUserId],
    );
    return {
      userIds: rows.flatMap((r) => (r.muted_user_id === null ? [] : [r.muted_user_id])),
      keywords: rows.flatMap((r) => (r.muted_keyword === null ? [] : [r.muted_keyword])),
    };
  }
  /** §9.6: grant reads are the one query hydrator that runs on HYPERDRIVE_FRESH. */
  async paidContentHashes(viewerUserId: string, viewerWallet: string | null): Promise<string[]> {
    const { rows } = await this.fresh.query<{ content_hash: string }>(
      `select distinct content_hash from public.access_grants
        where (subject_user_id = $1 or payer = $2)
          and revoked_at is null
          and (expires_at is null or expires_at > now())`,
      [viewerUserId, viewerWallet],
    );
    return rows.map((r) => r.content_hash);
  }
  async loadCreators(
    creatorIds: readonly string[],
  ): Promise<
    ReadonlyMap<string, { username: string; displayName: string | null; followersCount: number }>
  > {
    if (creatorIds.length === 0) return new Map();
    const { rows } = await this.cached.query<{
      user_id: string;
      handle: string;
      display_name: string | null;
      followers_count: number | bigint;
    }>(
      `select p.user_id, p.handle, p.display_name,
              (select count(*) from public.follows f
                where f.followee_user_id = p.user_id and f.target_kind = 'user')
                as followers_count
         from public.profiles p
        where p.user_id = any($1::uuid[])`,
      [[...creatorIds]],
    );
    return new Map(
      rows.map((r) => [
        r.user_id,
        {
          username: r.handle,
          displayName: r.display_name,
          followersCount: num(r.followers_count),
        },
      ]),
    );
  }
}

interface RawAction {
  action?: string;
  post_id?: string | null;
  surface?: string;
  at?: string;
  dwell_ms?: number;
  creator_id?: string | null;
  topics?: string[];
}

class PgRecentActions implements RecentActionsPort {
  constructor(private readonly cached: SqlClient) {}
  async loadViewerSequence(
    viewerUserId: string | null,
    viewerAgentId: string | null,
  ): Promise<ViewerSequence | null> {
    if (viewerUserId === null) return null; // agent viewers carry no row (§9.7)
    void viewerAgentId;
    const { rows } = await this.cached.query<{
      actions: RawAction[];
      topic_counts: Record<string, number>;
      action_count: number;
      computed_at: string;
    }>(
      `select actions, topic_counts, action_count, computed_at
         from public.viewer_recent_actions where viewer_user_id = $1`,
      [viewerUserId],
    );
    const r = rows[0];
    if (r === undefined) return null;
    return {
      actionCount: num(r.action_count),
      actions: r.actions.map((a) => ({
        action: a.action ?? "",
        postId: a.post_id ?? null,
        creatorId: a.creator_id ?? null,
        topics: a.topics ?? [],
        occurredAtMs: a.at === undefined ? 0 : Date.parse(a.at),
      })),
      topicCounts: new Map(Object.entries(r.topic_counts)),
      computedAt: r.computed_at,
    };
  }
}

class PgRetrieval implements RetrievalPort {
  constructor(private readonly cached: SqlClient) {}
  async viewerEmbedding(viewerUserId: string): Promise<number[] | null> {
    const { rows } = await this.cached.query<{ embedding: unknown }>(
      `select embedding::text as embedding from public.user_embeddings where user_id = $1`,
      [viewerUserId],
    );
    const r = rows[0];
    return r === undefined ? null : vec(r.embedding);
  }
  async similarPosts(
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
  > {
    const probeLiteral = `[${probe.join(",")}]`;
    const { rows } = await this.cached.query<SourceRow & { sim: number }>(
      `select * from app.retrieve_similar_posts($1::extensions.vector, $2, $3, $4::uuid[], $5, $6)`,
      [
        probeLiteral,
        input.hours,
        input.kinds === null ? null : [...input.kinds],
        [...input.excludeAuthorIds],
        input.limit,
        input.efSearch ?? 200,
      ],
    );
    return rows.map((r) => ({
      postId: r.post_id,
      contentHash: r.content_hash,
      authorUserId: r.author_user_id,
      creatorKind: r.creator_kind === "agent" ? "agent" : "human",
      kind: r.kind,
      publishedAtMs: num(r.published_at_ms),
      remixRootId: r.remix_root_id,
      sim: num(r.sim),
    }));
  }
  async postEmbeddings(contentHashes: readonly string[]): Promise<ReadonlyMap<string, number[]>> {
    if (contentHashes.length === 0) return new Map();
    const { rows } = await this.cached.query<{ content_hash: string; embedding: unknown }>(
      `select content_hash, embedding::text as embedding
         from public.post_embeddings where content_hash = any($1::text[])`,
      [[...contentHashes]],
    );
    return new Map(rows.map((r) => [r.content_hash, vec(r.embedding)]));
  }
  /** §9.14: the cohort centroid — mean over every user_embeddings row. */
  async newUserIndexEmbedding(indexId: string): Promise<number[] | null> {
    void indexId;
    const { rows } = await this.cached.query<{ centroid: unknown }>(
      `select avg(embedding)::text as centroid from public.user_embeddings`,
    );
    const r = rows[0];
    return r === undefined || r.centroid === null ? null : vec(r.centroid);
  }
}

class PgPosts implements PostsPort {
  constructor(private readonly cached: SqlClient) {}
  async loadCore(postIds: readonly string[]): Promise<ReadonlyMap<string, PostCoreRow>> {
    if (postIds.length === 0) return new Map();
    const { rows } = await this.cached.query<
      SourceRow & { title: string; summary: string | null; language_code: string | null }
    >(
      `select p.id as post_id, p.content_hash, p.author_user_id,
              case when p.posted_by_agent_id is null then 'human' else 'agent' end as creator_kind,
              p.kind, p.title, p.summary, p.language_code,
              extract(epoch from p.published_at) * 1000 as published_at_ms,
              null::uuid as remix_root_id
         from public.posts p where p.id = any($1::uuid[])`,
      [[...postIds]],
    );
    return new Map(
      rows.map((r) => {
        const c = toCoreRow(r);
        c.title = r.title;
        c.summary = r.summary;
        c.languageCode = r.language_code;
        return [c.postId, c];
      }),
    );
  }
  async loadMedia(postIds: readonly string[]): Promise<
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
  > {
    if (postIds.length === 0) return new Map();
    const { rows } = await this.cached.query<{
      post_id: string;
      duration_ms: number | null;
      width: number | null;
      height: number | null;
      url: string;
      storage: "r2_public" | "r2_paid" | "r2_artifacts";
    }>(
      `select distinct on (pa.post_id)
              pa.post_id, a.duration_ms, a.width, a.height, a.url, a.storage
         from public.post_assets pa
         join public.assets a on a.id = pa.asset_id
        where pa.post_id = any($1::uuid[])
        order by pa.post_id, pa.position`,
      [[...postIds]],
    );
    return new Map(
      rows.map((r) => [
        r.post_id,
        {
          durationMs: r.duration_ms,
          width: r.width,
          height: r.height,
          mediaUrl: r.url,
          thumbnailUrl: r.url,
          storage: r.storage,
        },
      ]),
    );
  }
  async loadPostStats(postIds: readonly string[]): Promise<ReadonlyMap<string, PostStatsRow>> {
    if (postIds.length === 0) return new Map();
    const { rows } = await this.cached.query<Record<string, unknown>>(
      `select pc.post_id,
              pc.impressions, pc.opens, pc.likes, pc.comments, pc.reposts,
              pc.bookmarks, pc.paid_fetches, pc.dwell_ms_total,
              r.human_impressions_24h, r.human_opens_24h,
              r.dwell_ms_p50_24h, r.dwell_ms_p90_24h, r.completion_rate_24h,
              r.replays_24h, r.engagements_24h, r.agent_fetches_24h,
              r.distinct_agents_24h, r.signed_agent_fetches_24h,
              r.citations_7d, r.purchases_24h, r.velocity_24h
         from public.post_counters pc
         left join public.post_stats_rolling r on r.post_id = pc.post_id
        where pc.post_id = any($1::uuid[])`,
      [[...postIds]],
    );
    return new Map(
      rows.map((r) => [
        String(r.post_id),
        {
          postId: String(r.post_id),
          counters: {
            impressions: num(r.impressions),
            opens: num(r.opens),
            likes: num(r.likes),
            comments: num(r.comments),
            reposts: num(r.reposts),
            bookmarks: num(r.bookmarks),
            paidFetches: num(r.paid_fetches),
            dwellMsTotal: num(r.dwell_ms_total),
          },
          rolling: {
            humanImpressions24h: num(r.human_impressions_24h),
            humanOpens24h: num(r.human_opens_24h),
            dwellMsP50_24h: num(r.dwell_ms_p50_24h),
            dwellMsP90_24h: num(r.dwell_ms_p90_24h),
            completionRate24h: num(r.completion_rate_24h),
            replays24h: num(r.replays_24h),
            engagements24h: num(r.engagements_24h),
            agentFetches24h: num(r.agent_fetches_24h),
            distinctAgents24h: num(r.distinct_agents_24h),
            signedAgentFetches24h: num(r.signed_agent_fetches_24h),
            citations7d: num(r.citations_7d),
            purchases24h: num(r.purchases_24h),
            velocity24h: num(r.velocity_24h),
          },
        },
      ]),
    );
  }
  async trending(input: {
    hours: number;
    kinds: PostKindFilter;
    limit: number;
  }): Promise<PostCoreRow[]> {
    return this.runSourceQuery("trending", [
      input.hours,
      input.kinds === null ? null : [...input.kinds],
      input.limit,
    ]);
  }
  async loadClassifications(contentHashes: readonly string[]): Promise<
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
  > {
    if (contentHashes.length === 0) return new Map();
    // taxonomy_leaf / taxonomy_path / p_unsafe / q_agent_value / topic_probabilities
    // arrive with M14's classification battery columns (§8.7); until then they
    // project as null/empty.
    const { rows } = await this.cached.query<{
      content_hash: string;
      topics: string[];
      primary_topic: string | null;
      quality: number | null;
      toxicity: number | null;
      is_nsfw: boolean;
    }>(
      `select content_hash, topics, primary_topic, quality, toxicity, is_nsfw
         from public.post_classifications where content_hash = any($1::text[])`,
      [[...contentHashes]],
    );
    return new Map(
      rows.map((r) => [
        r.content_hash,
        {
          topics: r.topics,
          primaryTopic: r.primary_topic,
          taxonomyLeaf: null,
          taxonomyPath: [],
          quality: r.quality,
          qAgentValue: null,
          pUnsafe: null,
          toxicity: r.toxicity,
          isNsfw: r.is_nsfw,
          topicProbabilities: {},
        },
      ]),
    );
  }
  async loadAgentIdentities(
    agentIds: readonly string[],
  ): Promise<ReadonlyMap<string, { agentId: string; verification: string; isBlocked: boolean }>> {
    if (agentIds.length === 0) return new Map();
    const { rows } = await this.cached.query<{
      id: string;
      verification: string;
      is_blocked: boolean;
    }>(
      `select id, verification::text as verification, is_blocked
         from public.agent_identities where id = any($1::uuid[])`,
      [[...agentIds]],
    );
    return new Map(
      rows.map((r) => [
        r.id,
        { agentId: r.id, verification: r.verification, isBlocked: r.is_blocked },
      ]),
    );
  }
  /** Pre-M16: artifacts exists but the fork/version tables do not (§11.13). */
  async loadArtifactState(postIds: readonly string[]): Promise<
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
  > {
    if (postIds.length === 0) return new Map();
    const { rows } = await this.cached.query<{ id: string; post_id: string; kind: string }>(
      `select id, post_id, kind from public.artifacts where post_id = any($1::uuid[])`,
      [[...postIds]],
    );
    return new Map(
      rows.map((r) => [
        r.post_id,
        {
          appId: r.id,
          runtime: r.kind === "glb" ? "3d" : "2d",
          installs: 0,
          forks: 0,
          remixRootId: null,
        },
      ]),
    );
  }
  async runSourceQuery(sql: string, params: readonly unknown[]): Promise<PostCoreRow[]> {
    const text = SOURCE_SQL[sql];
    if (text === undefined) throw new Error(`muse.unknown_source_query:${sql}`);
    const { rows } = await this.cached.query<SourceRow>(text, params);
    return rows.map(toCoreRow);
  }
}

class PgSlates implements SlatePort {
  constructor(private readonly cached: SqlClient) {}
  async writeSlate(row: {
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
  }): Promise<void> {
    await this.cached.query(
      `with s as (
         insert into public.slates
           (id, viewer_user_id, viewer_agent_id, surface, weights_version,
            model_version, candidate_count, params, expires_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
         returning id
       )
       insert into public.slate_items
         (slate_id, position, post_id, source, action_scores, weighted_score, score)
       select s.id, v.position, v.post_id::uuid, v.source,
              v.action_scores::jsonb, v.weighted_score, v.score
         from s
         cross join lateral jsonb_to_recordset($10::jsonb) as v(
           position integer, post_id text, source text,
           action_scores jsonb, weighted_score float8, score float8)`,
      [
        row.id,
        row.viewerUserId,
        row.viewerAgentId,
        row.surface,
        row.weightsVersion,
        row.modelVersion,
        row.items.length,
        JSON.stringify(row.params),
        row.expiresAt.toISOString(),
        // jsonb_to_recordset maps by column name — snake keys for the wire.
        JSON.stringify(
          row.items.map((it) => ({
            position: it.position,
            post_id: it.postId,
            source: it.source,
            action_scores: it.actionScores,
            weighted_score: it.weightedScore,
            score: it.score,
          })),
        ),
      ],
    );
  }
  async previousScores(
    viewerUserId: string | null,
    viewerAgentId: string | null,
    surface: Surface,
  ): Promise<{
    modelVersion: string;
    viewerContextVersion: string;
    createdAtMs: number;
    scores: ReadonlyMap<string, { actionScores: Record<string, number> }>;
  } | null> {
    const { rows } = await this.cached.query<{
      model_version: string;
      created_at: string;
      params: Record<string, unknown>;
      post_id: string;
      action_scores: Record<string, number>;
    }>(
      `select s.model_version, s.created_at, s.params,
              i.post_id, i.action_scores
         from public.slates s
         join public.slate_items i on i.slate_id = s.id
        where s.viewer_user_id is not distinct from $1
          and s.viewer_agent_id is not distinct from $2
          and s.surface = $3
          and s.expires_at > now()
          and s.created_at = (
            select max(created_at) from public.slates s2
             where s2.viewer_user_id is not distinct from $1
               and s2.viewer_agent_id is not distinct from $2
               and s2.surface = $3
               and s2.expires_at > now())
        order by i.position`,
      [viewerUserId, viewerAgentId, surface],
    );
    const first = rows[0];
    if (first === undefined) return null;
    const vcv = first.params["viewerContextVersion"];
    return {
      modelVersion: first.model_version,
      viewerContextVersion: typeof vcv === "string" ? vcv : "",
      createdAtMs: Date.parse(first.created_at),
      scores: new Map(rows.map((r) => [r.post_id, { actionScores: r.action_scores }])),
    };
  }
  async needsBuild(
    viewerUserId: string | null,
    viewerAgentId: string | null,
    surface: Surface,
    minRemainingSeconds: number,
  ): Promise<boolean> {
    const { rows } = await this.cached.query(
      `select 1 from public.slates
        where viewer_user_id is not distinct from $1
          and viewer_agent_id is not distinct from $2
          and surface = $3
          and expires_at > now() + make_interval(secs => $4::int)
        limit 1`,
      [viewerUserId, viewerAgentId, surface, minRemainingSeconds],
    );
    return rows.length === 0;
  }
}

class PgBloom implements BloomPort {
  constructor(private readonly cached: SqlClient) {}
  async loadSeen(viewerUserId: string): Promise<SeenState | null> {
    const { rows } = await this.cached.query<{
      viewer_user_id: string;
      iso_week: string;
      filter_json: unknown;
      prev_filter_json: unknown;
      recent_ids: string[];
      updated_at: string;
    }>(
      `select viewer_user_id, iso_week, filter_json, prev_filter_json,
              recent_ids, updated_at
         from public.viewer_seen_bloom where viewer_user_id = $1`,
      [viewerUserId],
    );
    return rows[0] === undefined
      ? null
      : {
          viewerUserId: rows[0].viewer_user_id,
          isoWeek: rows[0].iso_week,
          filterJson: rows[0].filter_json,
          prevFilterJson: rows[0].prev_filter_json,
          recentIds: rows[0].recent_ids,
          updatedAt: rows[0].updated_at,
        };
  }
  /** Rotation is a column compare, not a clock read (§9.16). */
  async updateSeen(input: {
    viewerUserId: string;
    isoWeek: string;
    filterJson: unknown;
    servedIds: readonly string[];
    maxRecentIds: number;
  }): Promise<void> {
    await this.cached.query(
      `insert into public.viewer_seen_bloom
         (viewer_user_id, iso_week, filter_json, recent_ids)
       values ($1, $2, $3::jsonb, $4::uuid[])
       on conflict (viewer_user_id) do update set
         prev_filter_json = case
           when viewer_seen_bloom.iso_week <> excluded.iso_week
           then viewer_seen_bloom.filter_json
           else viewer_seen_bloom.prev_filter_json end,
         iso_week = excluded.iso_week,
         filter_json = excluded.filter_json,
         recent_ids = (excluded.recent_ids || viewer_seen_bloom.recent_ids)[1:$5::int],
         updated_at = now()`,
      [
        input.viewerUserId,
        input.isoWeek,
        JSON.stringify(input.filterJson),
        [...input.servedIds],
        input.maxRecentIds,
      ],
    );
  }
}

class PgClusters implements ClusterPort {
  constructor(private readonly cached: SqlClient) {}
  async clustersForCreators(
    creatorIds: readonly string[],
  ): Promise<ReadonlyMap<string, Array<{ clusterId: number; weight: number }>>> {
    if (creatorIds.length === 0) return new Map();
    const { rows } = await this.cached.query<{
      creator_user_id: string;
      cluster_id: number;
      weight: number;
    }>(
      `select creator_user_id, cluster_id, weight
         from public.creator_clusters where creator_user_id = any($1::uuid[])`,
      [[...creatorIds]],
    );
    const out = new Map<string, Array<{ clusterId: number; weight: number }>>();
    for (const r of rows) {
      const list = out.get(r.creator_user_id) ?? [];
      list.push({ clusterId: r.cluster_id, weight: num(r.weight) });
      out.set(r.creator_user_id, list);
    }
    return out;
  }
  async creatorsForClusters(
    clusterIds: readonly number[],
    limit: number,
  ): Promise<Array<{ creatorId: string; clusterId: number; weight: number }>> {
    if (clusterIds.length === 0) return [];
    const { rows } = await this.cached.query<{
      creator_user_id: string;
      cluster_id: number;
      weight: number;
    }>(
      `select creator_user_id, cluster_id, weight
         from public.creator_clusters
        where cluster_id = any($1::int[])
        order by weight desc
        limit $2`,
      [[...clusterIds], limit],
    );
    return rows.map((r) => ({
      creatorId: r.creator_user_id,
      clusterId: r.cluster_id,
      weight: num(r.weight),
    }));
  }
  /** §9.7: viewer's engaged creators → their clusters, summed weight, top-N. */
  async viewerClusters(
    viewerUserId: string,
    limit: number,
  ): Promise<Array<{ clusterId: number; weight: number }>> {
    const { rows } = await this.cached.query<{ cluster_id: number; weight: number }>(
      `select cc.cluster_id, sum(cc.weight) as weight
         from public.creator_clusters cc
        where cc.creator_user_id in (
          select distinct p.author_user_id
            from public.viewer_recent_actions v
                 cross join lateral jsonb_array_elements(v.actions) as a(elem)
                 join public.posts p on p.id = (a.elem ->> 'post_id')::uuid
           where v.viewer_user_id = $1
             and a.elem ? 'post_id')
        group by cc.cluster_id
        order by weight desc
        limit $2`,
      [viewerUserId, limit],
    );
    return rows.map((r) => ({ clusterId: r.cluster_id, weight: num(r.weight) }));
  }
}

/**
 * Compose the port set. `fresh` defaults to `cached` — only grant reads and
 * slate writes that must not be cached-stale need the fresh binding.
 */
export function postgresDbHandles(input: {
  cached: SqlClient;
  fresh?: SqlClient;
  monetization: MonetizationPort;
  telemetry: TelemetryPort;
}): DbHandles {
  const cached = input.cached;
  const fresh = input.fresh ?? input.cached;
  return {
    graph: new PgGraph(cached, fresh),
    recent: new PgRecentActions(cached),
    retrieval: new PgRetrieval(cached),
    posts: new PgPosts(cached),
    monetization: input.monetization,
    slates: new PgSlates(fresh),
    bloom: new PgBloom(cached),
    clusters: new PgClusters(cached),
    telemetry: input.telemetry,
  };
}

interface WeightsRow {
  weights_version: string;
  cohort: string;
  weights: {
    discrete?: Record<string, number>;
    continuous?: Record<string, number>;
    gates?: Record<string, number | boolean>;
  };
  is_active: boolean;
}

/**
 * §9.12: most-specific-wins over `cohortCandidates(k)`, restricted to the family
 * (`weights_version = family` or `family.*`), is_active only. Falls through to
 * the `default` cohort; absent that, the seeded `none` sentinel.
 */
export class PostgresWeightsLoader implements WeightsLoader {
  constructor(private readonly client: SqlClient) {}
  async load(k: CohortKey): Promise<ActionWeights> {
    const candidates = cohortCandidates(k);
    const { rows } = await this.client.query<WeightsRow>(
      `select weights_version, cohort, weights, is_active
         from public.ranking_weights
        where (weights_version = $1 or weights_version like $1 || '.%' or weights_version = 'none')
          and cohort = any($2::text[])
          and (is_active or weights_version = 'none')
        order by created_at desc`,
      [k.family, candidates],
    );
    const byCohort = new Map(rows.map((r) => [r.cohort, r]));
    const hit = candidates.map((c) => byCohort.get(c)).find((r) => r !== undefined);
    const row = hit ?? byCohort.get("default");
    if (row === undefined) throw new Error(`muse.weights_missing:${k.family}`);
    const w = row.weights;
    const discrete = Object.fromEntries(
      MUSE_ACTIONS.map((a) => [a, w.discrete?.[a] ?? 0]),
    ) as ActionWeights["discrete"];
    const continuous = Object.fromEntries(
      MUSE_CONTINUOUS.map((cn) => [cn, w.continuous?.[cn] ?? 0]),
    ) as ActionWeights["continuous"];
    const negativeSum = MUSE_NEGATIVE_ACTIONS.reduce((s, a) => s + Math.abs(discrete[a]), 0);
    const totalSum = MUSE_ACTIONS.reduce((s, a) => s + Math.abs(discrete[a]), 0);
    return {
      version: row.weights_version,
      cohort: row.cohort,
      discrete,
      continuous,
      negativeSum,
      totalSum,
      gates: w.gates ?? {},
    };
  }
}
