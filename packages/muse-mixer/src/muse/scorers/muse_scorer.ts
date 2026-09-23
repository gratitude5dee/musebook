// packages/muse-mixer/src/muse/scorers/muse_scorer.ts
import type { ExecCtx, PerCandidate, Scorer } from "../../framework/types.js";
import { withTimeout } from "../../framework/merge.js";
import type { MuseAction, MuseContinuous } from "../actions.js";
import type { MuseFeedQuery } from "../query.js";
import type { MuseCandidate } from "../candidate.js";

export interface ViewerContext {
  viewerId: string | null;
  viewerKind: "human" | "agent";
  viewerEmbedding: number[] | null;
  actionCount: number;
  recentPositiveEmbeddings: number[][]; // last 20, for embSimRecentMax
  creatorAffinity: ReadonlyMap<string, number>;
  topicAffinity: ReadonlyMap<string, number>;
  surface: string;
  hourOfDay: number;
  dayOfWeek: number;
}

export interface ActionPrediction {
  discrete: Partial<Record<MuseAction, number>>; // probabilities in [0,1]
  continuous: Partial<Record<MuseContinuous, number>>;
}

/** THE SEAM. Every implementation MUST be pure per (viewerContext, one candidate). */
export interface MuseRanker {
  readonly modelVersion: string;
  predict(ctx: ViewerContext, feats: readonly CandidateFeatures[]): Promise<ActionPrediction[]>;
}

export interface CandidateFeatures {
  embSimViewer: number; // cosine(viewerEmbedding, postEmbedding)
  embSimRecentMax: number; // max cosine vs last 20 positively-engaged posts
  inNetwork: 0 | 1;
  mutualFollow: 0 | 1;
  creatorAffinity: number; // log1p(viewer's prior positive actions on this creator)
  topicAffinity: number; // dot(viewerTopicVector, postTopicVector)
  quality: number; // post_classifications.quality (rubric family), 0 when null
  qAgentValue: number; // post_classifications.agent_value (rubric family)
  pUnsafe: number; // post_classifications.p_unsafe (probability family)
  ageMinutesLog: number;
  recencyDecay: number; // exp(-ageMinutes / HalfLifeMinutes)
  impressionsLog: number;
  likesLog: number;
  repostsLog: number;
  bookmarksLog: number;
  paidFetchesLog: number;
  engagements24hLog: number;
  signedAgentFetches24hLog: number;
  completionRate24h: number; // post_stats_rolling.completion_rate_24h — the reels feature
  replays24hLog: number; // post_stats_rolling.replays_24h
  forksLog: number; // artifacts.fork_count (§11.13); 0 for non-artifacts
  engagementVelocity: number; // post_stats_rolling.velocity_24h
  kindOneHot: number[]; // 8, post_kind order
  creatorIsAgent: 0 | 1;
  durationBucket: number;
  languageMatch: 0 | 1;
  accessOneHot: number[]; // 3, PublishMode order: free, human_free_agent_paid, x402_always
  viewerActionCountBucket: number;
  surfaceOneHot: number[]; // one per Surface value (§4.2) — a reels row and a home row
  // for the same post are different training examples
  sourceOneHot: number[]; // 12: the 11 ranked sources plus the reverse-chron fallback
  sourceScore: number;
  isRemixOfEngaged: 0 | 1;
  creatorFollowersBucket: number;
  hourSin: number;
  hourCos: number;
  dowSin: number;
  dowCos: number;
}

const KIND_ORDER = [
  "note",
  "article",
  "image",
  "video",
  "audio",
  "app",
  "model3d",
  "thread",
] as const;
const MODE_ORDER = ["free", "human_free_agent_paid", "x402_always"] as const;
const SOURCE_ORDER = [
  "FollowGraphSource",
  "EmbeddingRetrievalSource",
  "TopicSource",
  "TrendingSource",
  "CoEngagementSource",
  "AgentAuthoredSource",
  "AppArtifactSource",
  "RemixLineageSource",
  "ColdStartSeedSource",
  "CompletionTrendingSource",
  "SoundtrackSource",
  "ReverseChronSource",
] as const;
const SURFACE_ORDER = ["home", "reels", "explore", "post", "profile"] as const;

function bucket(v: number, edges: readonly number[]): number {
  let i = 0;
  while (i < edges.length && v >= (edges[i] ?? Number.POSITIVE_INFINITY)) i++;
  return i;
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * §9.15's v1 feature vector — every field is a function of (viewer, candidate) and
 * NOTHING else. No slate-derived term may ever appear here (spine invariant 2).
 */
export function candidateFeatures(
  c: MuseCandidate,
  q: MuseFeedQuery,
  vc: ViewerContext,
  ctx: ExecCtx,
): CandidateFeatures {
  const ageMin = Math.max(0, (ctx.now - c.publishedAt) / 60000);
  const halfLife = ctx.params.num("RecencyHalfLifeMinutes", 720);
  const viewersTopics = vc.topicAffinity;
  let topicAffinity = 0;
  for (const t of c.topics ?? []) topicAffinity += viewersTopics.get(t) ?? 0;
  const kindIdx = KIND_ORDER.indexOf(c.kind);
  const modeIdx = MODE_ORDER.indexOf(c.monetization?.mode ?? "free");
  const surfIdx = SURFACE_ORDER.indexOf(q.surface as (typeof SURFACE_ORDER)[number]);
  return {
    embSimViewer:
      vc.viewerEmbedding !== null && c.embedding !== undefined
        ? cosine(vc.viewerEmbedding, c.embedding)
        : 0,
    embSimRecentMax:
      c.embedding !== undefined
        ? Math.max(0, ...vc.recentPositiveEmbeddings.map((e) => cosine(e, c.embedding as number[])))
        : 0,
    inNetwork: c.inNetwork === true ? 1 : 0,
    mutualFollow: c.mutualFollow === true ? 1 : 0,
    creatorAffinity: Math.log1p(vc.creatorAffinity.get(c.creatorId) ?? 0),
    topicAffinity,
    quality: c.classification?.quality ?? 0,
    qAgentValue: c.classification?.qAgentValue ?? 0,
    pUnsafe: c.classification?.pUnsafe ?? 0,
    ageMinutesLog: Math.log1p(ageMin),
    recencyDecay: Math.exp(-ageMin / halfLife),
    impressionsLog: Math.log1p(c.counters?.impressions ?? 0),
    likesLog: Math.log1p(c.counters?.likes ?? 0),
    repostsLog: Math.log1p(c.counters?.reposts ?? 0),
    bookmarksLog: Math.log1p(c.counters?.bookmarks ?? 0),
    paidFetchesLog: Math.log1p(c.counters?.paidFetches ?? 0),
    engagements24hLog: Math.log1p(c.rolling?.engagements24h ?? 0),
    signedAgentFetches24hLog: Math.log1p(c.rolling?.signedAgentFetches24h ?? 0),
    completionRate24h: c.rolling?.completionRate24h ?? 0,
    replays24hLog: Math.log1p(c.rolling?.replays24h ?? 0),
    forksLog: Math.log1p(c.app?.forks ?? 0),
    engagementVelocity: c.rolling?.velocity24h ?? 0,
    kindOneHot: KIND_ORDER.map((_, i) => (i === kindIdx ? 1 : 0)),
    creatorIsAgent: c.creatorKind === "agent" ? 1 : 0,
    durationBucket: bucket(c.durationMs ?? 0, [2000, 5000, 15000, 30000, 90000, 240000]),
    languageMatch:
      c.languageCode !== undefined && q.languageCode !== null && c.languageCode === q.languageCode
        ? 1
        : 0,
    accessOneHot: MODE_ORDER.map((_, i) => (i === modeIdx ? 1 : 0)),
    viewerActionCountBucket: bucket(vc.actionCount, [1, 10, 20, 50, 200, 1000]),
    surfaceOneHot: SURFACE_ORDER.map((_, i) => (i === surfIdx ? 1 : 0)),
    sourceOneHot: SOURCE_ORDER.map((s) => (c.sourceNames.includes(s) ? 1 : 0)),
    sourceScore: c.sourceScore ?? 0,
    isRemixOfEngaged: 0,
    creatorFollowersBucket: bucket(c.creatorFollowers ?? 0, [10, 100, 1000, 10000, 100000]),
    hourSin: Math.sin((vc.hourOfDay / 24) * 2 * Math.PI),
    hourCos: Math.cos((vc.hourOfDay / 24) * 2 * Math.PI),
    dowSin: Math.sin((vc.dayOfWeek / 7) * 2 * Math.PI),
    dowCos: Math.cos((vc.dayOfWeek / 7) * 2 * Math.PI),
  };
}

/** Build the viewer context from the query's hydrated fields (hydrators normally set it). */
export function viewerContextFor(q: MuseFeedQuery, ctx: ExecCtx): ViewerContext {
  const d = new Date(ctx.now);
  return {
    viewerId: q.viewerId,
    viewerKind: q.viewerKind,
    viewerEmbedding: q.viewerEmbedding,
    actionCount: q.actionCount,
    recentPositiveEmbeddings: [],
    creatorAffinity: new Map(),
    topicAffinity:
      q.followedTopicIds.length > 0 || q.inferredTopicIds.length > 0
        ? new Map([...q.followedTopicIds, ...q.inferredTopicIds].map((t) => [t, 1]))
        : new Map(),
    surface: q.surface,
    hourOfDay: d.getUTCHours(),
    dayOfWeek: d.getUTCDay(),
  };
}

const CHUNK = 64;

/**
 * The model stage. Batches features in chunks of 64, applies the §9.11 warm start
 * first, and on ranker failure or MUSE_RANKER_TIMEOUT_MS falls back to the
 * previous implementation rather than failing — a degraded score is a slate, a
 * thrown error is a viewer with no feed.
 */
export class MuseScorer implements Scorer<MuseFeedQuery, MuseCandidate> {
  readonly name = "MuseScorer";
  constructor(
    private readonly ranker: MuseRanker,
    private readonly fallback: MuseRanker | null = null,
  ) {}

  async score(
    q: MuseFeedQuery,
    candidates: readonly MuseCandidate[],
    ctx: ExecCtx,
  ): Promise<Array<PerCandidate<MuseCandidate>>> {
    const vc = q.viewerContext ?? viewerContextFor(q, ctx);
    const timeoutMs = ctx.params.num("MuseRankerTimeoutMs", 250);

    // Warm start (§9.11): reuse a previous slate's actionScores when the triple
    // (modelVersion, viewerContextVersion, contentHash) still matches.
    const reusable = new Map<string, { actionScores: Record<string, number> }>();
    try {
      const prev = await ctx.db.slates.previousScores(q.viewerId, q.agentId, q.surface);
      const ttlMs = ctx.params.num("MuseScoreCacheTtlSeconds", 600) * 1000;
      if (
        prev !== null &&
        prev.modelVersion === q.modelVersion &&
        prev.viewerContextVersion === q.viewerContextVersion &&
        ctx.now - prev.createdAtMs <= ttlMs
      ) {
        for (const [hash, s] of prev.scores) reusable.set(hash, s);
        ctx.stats.counter("muse.warmstart.hit", 1);
      } else {
        ctx.stats.counter("muse.warmstart.miss", 1);
      }
    } catch {
      ctx.stats.counter("muse.warmstart.miss", 1);
    }

    const out: Array<PerCandidate<MuseCandidate>> = new Array<PerCandidate<MuseCandidate>>(
      candidates.length,
    );
    const freshIdx: number[] = [];
    const freshFeats: CandidateFeatures[] = [];
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      if (c === undefined) continue;
      const warm = reusable.get(c.contentHash);
      if (warm !== undefined && warm.actionScores !== undefined) {
        out[i] = { actionScores: warm.actionScores };
      } else {
        freshIdx.push(i);
        freshFeats.push(candidateFeatures(c, q, vc, ctx));
      }
    }

    for (let off = 0; off < freshIdx.length; off += CHUNK) {
      const idxs = freshIdx.slice(off, off + CHUNK);
      const feats = freshFeats.slice(off, off + CHUNK);
      let preds: ActionPrediction[];
      try {
        preds = await withTimeout(this.ranker.predict(vc, feats), timeoutMs, "MuseScorer.predict");
      } catch {
        ctx.stats.counter("muse.ranker.fallback", 1, {
          from: this.ranker.modelVersion,
          to: this.fallback?.modelVersion ?? "none",
        });
        if (this.fallback === null) {
          preds = idxs.map(() => ({ discrete: {}, continuous: {} }));
        } else {
          try {
            preds = await withTimeout(
              this.fallback.predict(vc, feats),
              timeoutMs,
              "MuseScorer.fallback",
            );
          } catch {
            preds = idxs.map(() => ({ discrete: {}, continuous: {} }));
          }
        }
      }
      for (let j = 0; j < idxs.length; j++) {
        const oi = idxs[j];
        const pr = preds[j];
        if (oi === undefined || pr === undefined) continue;
        out[oi] = { actionScores: pr.discrete, continuousPreds: pr.continuous };
      }
    }
    return out;
  }
}
