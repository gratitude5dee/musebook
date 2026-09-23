// packages/muse-mixer/src/muse/hydrators/index.ts
// §9.8 — the 11 candidate hydrators, run in ONE allSettled and mergePerCandidate'd.
// Network-backed ones extend CachedHydrator (upstream's hydrator.rs:84-189 pattern);
// the memo is ExecCtx.cache — per isolate, never an answer (the isolate can be
// recycled between calls).
import type { ExecCtx, Hydrator, PerCandidate } from "../../framework/types.js";
import type { MuseFeedQuery } from "../query.js";
import type { MuseCandidate } from "../candidate.js";

type CacheWrite = Record<string, string>;

/** hydrator.rs:84-189 — keyFor + hydrateUncached + automatic hit/miss counters. */
export abstract class CachedHydrator implements Hydrator<MuseFeedQuery, MuseCandidate> {
  abstract readonly name: string;
  /** Cache key for this candidate — usually one of its ids. */
  abstract keyFor(c: MuseCandidate): string | null;
  /** Fetch the rows whose cache keys missed. Keys are the keyFor() outputs. */
  abstract hydrateUncached(
    keys: readonly string[],
    ctx: ExecCtx,
  ): Promise<ReadonlyMap<string, Partial<MuseCandidate>>>;

  async hydrate(
    _q: MuseFeedQuery,
    candidates: readonly MuseCandidate[],
    ctx: ExecCtx,
  ): Promise<Array<PerCandidate<MuseCandidate>>> {
    const keys = candidates.map((c) => this.keyFor(c));
    const cacheKeys = keys.map((k) => (k === null ? null : `${this.name}:${k}`));
    const cached = await ctx.cache.getMany(cacheKeys.map((k) => k ?? ""));
    const missIdx: number[] = [];
    const missKeys: string[] = [];
    for (let i = 0; i < candidates.length; i++) {
      if (cacheKeys[i] !== null && cached[i] === undefined) {
        missIdx.push(i);
        missKeys.push(keys[i] as string);
      }
    }
    ctx.stats.counter("muse.hydrator.cache_hit", candidates.length - missIdx.length, {
      hydrator: this.name,
    });
    ctx.stats.counter("muse.hydrator.cache_miss", missIdx.length, { hydrator: this.name });
    const fresh =
      missKeys.length === 0
        ? new Map<string, Partial<MuseCandidate>>()
        : await this.hydrateUncached([...new Set(missKeys)], ctx);
    const writes: CacheWrite = {};
    const out: Array<PerCandidate<MuseCandidate>> = candidates.map((_c, i) => {
      const key = keys[i];
      if (key === null || key === undefined) return {};
      const ck = cacheKeys[i] as string;
      const hit = cached[i];
      if (hit !== undefined) return JSON.parse(hit) as Partial<MuseCandidate>;
      const v = fresh.get(key) ?? {};
      writes[ck] = JSON.stringify(v);
      return v;
    });
    // Fire-and-forget cache writes; per-isolate Map is cheap.
    for (const [k, v] of Object.entries(writes)) void ctx.cache.set(k, v, 300);
    return out;
  }
}

/** 1 — posts ⋈ post_assets ⋈ assets core columns, one batched read. */
export class CoreDataHydrator implements Hydrator<MuseFeedQuery, MuseCandidate> {
  readonly name = "CoreDataHydrator";
  async hydrate(_q: MuseFeedQuery, candidates: readonly MuseCandidate[], ctx: ExecCtx) {
    const rows = await ctx.db.posts.loadCore(candidates.map((c) => c.postId));
    return candidates.map((c): PerCandidate<MuseCandidate> => {
      const r = rows.get(c.postId);
      if (r === undefined) return {};
      const out: Partial<MuseCandidate> = {
        title: r.title,
        kind: r.kind,
        contentHash: r.contentHash,
        creatorId: r.authorUserId,
        creatorKind: r.creatorKind,
        publishedAt: r.publishedAtMs,
      };
      if (r.summary !== null) out.summary = r.summary;
      if (r.languageCode !== null) out.languageCode = r.languageCode;
      const root = r.remixRootId ?? c.remixRootId;
      if (root !== undefined) out.remixRootId = root;
      return out;
    });
  }
}

/** 2 — profiles + follower count, memoized by creatorId. */
export class CreatorHydrator extends CachedHydrator {
  readonly name = "CreatorHydrator";
  keyFor(c: MuseCandidate): string | null {
    return c.creatorId === "" ? null : c.creatorId;
  }
  async hydrateUncached(keys: readonly string[], ctx: ExecCtx) {
    const rows = await ctx.db.graph.loadCreators(keys);
    const out = new Map<string, Partial<MuseCandidate>>();
    for (const k of keys) {
      const r = rows.get(k);
      out.set(k, r === undefined ? {} : { creatorFollowers: r.followersCount });
    }
    return out;
  }
}

/** 3 — pure: set-membership against the query's follow lists. */
export class InNetworkHydrator implements Hydrator<MuseFeedQuery, MuseCandidate> {
  readonly name = "InNetworkHydrator";
  hydrate(q: MuseFeedQuery, candidates: readonly MuseCandidate[]) {
    const followed = new Set(q.followedCreatorIds);
    const mutual = new Set(q.mutualFollowCreatorIds);
    return Promise.resolve(
      candidates.map((c): PerCandidate<MuseCandidate> => ({
        inNetwork: followed.has(c.creatorId),
        mutualFollow: mutual.has(c.creatorId),
      })),
    );
  }
}

/** 4 — duration/width/height/urls/storage — feeds ReelsPlayableFilter. */
export class MediaHydrator implements Hydrator<MuseFeedQuery, MuseCandidate> {
  readonly name = "MediaHydrator";
  async hydrate(_q: MuseFeedQuery, candidates: readonly MuseCandidate[], ctx: ExecCtx) {
    const rows = await ctx.db.posts.loadMedia(candidates.map((c) => c.postId));
    return candidates.map((c): PerCandidate<MuseCandidate> => {
      const r = rows.get(c.postId);
      if (r === undefined) return {};
      const out: Partial<MuseCandidate> = { mediaStorage: r.storage };
      if (r.durationMs !== null) out.durationMs = r.durationMs;
      if (r.width !== null) out.width = r.width;
      if (r.height !== null) out.height = r.height;
      if (r.mediaUrl !== null) out.mediaUrl = r.mediaUrl;
      if (r.thumbnailUrl !== null) out.thumbnailUrl = r.thumbnailUrl;
      return out;
    });
  }
}

/** 5 — post_classifications by content_hash (topics, quality, taxonomy, topic_probabilities). */
export class ClassificationHydrator implements Hydrator<MuseFeedQuery, MuseCandidate> {
  readonly name = "ClassificationHydrator";
  async hydrate(_q: MuseFeedQuery, candidates: readonly MuseCandidate[], ctx: ExecCtx) {
    const rows = await ctx.db.posts.loadClassifications(candidates.map((c) => c.contentHash));
    return candidates.map((c): PerCandidate<MuseCandidate> => {
      const r = rows.get(c.contentHash);
      if (r === undefined) return {};
      return {
        topics: r.topics,
        primaryTopic: r.primaryTopic,
        taxonomyLeaf: r.taxonomyLeaf,
        taxonomyPath: r.taxonomyPath,
        classification: {
          quality: r.quality,
          qAgentValue: r.qAgentValue,
          pUnsafe: r.pUnsafe,
          toxicity: r.toxicity,
          isNsfw: r.isNsfw,
        },
        topicProbabilities: r.topicProbabilities,
      };
    });
  }
}

/** 6 — safety verdict from the same classification row: drop / soften / show. */
export class SafetyHydrator implements Hydrator<MuseFeedQuery, MuseCandidate> {
  readonly name = "SafetyHydrator";
  hydrate(_q: MuseFeedQuery, candidates: readonly MuseCandidate[], ctx: ExecCtx) {
    const dropAt = ctx.params.num("SafetyUnsafeDropThreshold", 0.8);
    const softenAt = ctx.params.num("SafetyToxicitySoftenThreshold", 0.6);
    return Promise.resolve(
      candidates.map((c): PerCandidate<MuseCandidate> => {
        const cl = c.classification;
        const verdict =
          cl?.isNsfw === true || (cl?.pUnsafe ?? 0) >= dropAt
            ? ("drop" as const)
            : (cl?.toxicity ?? 0) >= softenAt
              ? ("soften" as const)
              : ("show" as const);
        const categories: string[] = [];
        if (cl?.isNsfw === true) categories.push("nsfw");
        if ((cl?.pUnsafe ?? 0) >= dropAt) categories.push("unsafe");
        if ((cl?.toxicity ?? 0) >= softenAt) categories.push("toxicity");
        return { safety: { verdict, categories } };
      }),
    );
  }
}

/** 7 — monetization via the kernel projection surface, never the column (§9.8). */
export class MonetizationHydrator implements Hydrator<MuseFeedQuery, MuseCandidate> {
  readonly name = "MonetizationHydrator";
  async hydrate(q: MuseFeedQuery, candidates: readonly MuseCandidate[], ctx: ExecCtx) {
    const rows = await ctx.db.monetization.forCandidates({
      postIds: candidates.map((c) => c.postId),
      contentHashes: candidates.map((c) => c.contentHash),
      viewerUserId: q.viewerId,
      viewerWallet: q.viewerWallet,
    });
    const entitled = new Set(q.entitlements.paidContentHashes);
    return candidates.map((c): PerCandidate<MuseCandidate> => {
      const r = rows.get(c.postId);
      if (r === undefined) return {};
      return {
        monetization: {
          mode: r.mode,
          priceUsd: r.priceUsd,
          viewerEntitled: r.viewerEntitled || entitled.has(c.contentHash),
        },
      };
    });
  }
}

/** 8 — artifacts ⋈ artifact_versions/artifact_forks; viewerInstalled + remixRootId fallback. */
export class AppStateHydrator implements Hydrator<MuseFeedQuery, MuseCandidate> {
  readonly name = "AppStateHydrator";
  async hydrate(q: MuseFeedQuery, candidates: readonly MuseCandidate[], ctx: ExecCtx) {
    const artifactIds = candidates
      .filter((c) => c.kind === "app" || c.kind === "model3d")
      .map((c) => c.postId);
    if (artifactIds.length === 0) return candidates.map(() => ({}));
    const rows = await ctx.db.posts.loadArtifactState(artifactIds);
    const installed = new Set(q.installedAppIds);
    return candidates.map((c): PerCandidate<MuseCandidate> => {
      const r = rows.get(c.postId);
      if (r === undefined) return {};
      const out: Partial<MuseCandidate> = {
        app: {
          appId: r.appId,
          runtime: r.runtime,
          installs: r.installs,
          forks: r.forks,
          viewerInstalled: installed.has(r.appId),
        },
      };
      const root = c.remixRootId ?? r.remixRootId ?? undefined;
      if (root !== undefined) out.remixRootId = root;
      return out;
    });
  }
}

/** 9 — post_counters + post_stats_rolling, NEVER the post row (spine invariant 4). */
export class CounterHydrator implements Hydrator<MuseFeedQuery, MuseCandidate> {
  readonly name = "CounterHydrator";
  async hydrate(_q: MuseFeedQuery, candidates: readonly MuseCandidate[], ctx: ExecCtx) {
    const rows = await ctx.db.posts.loadPostStats(candidates.map((c) => c.postId));
    return candidates.map((c): PerCandidate<MuseCandidate> => {
      const r = rows.get(c.postId);
      if (r === undefined) return {};
      return { counters: r.counters, rolling: r.rolling };
    });
  }
}

/** 10 — memoized viewer-independent topic vector → topicAffinity inputs. */
export class TopicHydrator extends CachedHydrator {
  readonly name = "TopicHydrator";
  keyFor(c: MuseCandidate): string | null {
    return c.contentHash === "" ? null : `topic:${c.contentHash}`;
  }
  async hydrateUncached(keys: readonly string[], ctx: ExecCtx) {
    const hashes = keys.map((k) => k.slice("topic:".length));
    const rows = await ctx.db.posts.loadClassifications(hashes);
    const out = new Map<string, Partial<MuseCandidate>>();
    for (const k of keys) {
      const r = rows.get(k.slice("topic:".length));
      out.set(k, r === undefined ? {} : { topicProbabilities: r.topicProbabilities });
    }
    return out;
  }
}

/** 11 — posted_by_agent_id ⋈ agent_identities.verification. */
export class AgentProvenanceHydrator implements Hydrator<MuseFeedQuery, MuseCandidate> {
  readonly name = "AgentProvenanceHydrator";
  async hydrate(_q: MuseFeedQuery, candidates: readonly MuseCandidate[], ctx: ExecCtx) {
    const agentIds = [
      ...new Set(
        candidates.map((c) => c.postedByAgentId).filter((x): x is string => x !== undefined),
      ),
    ];
    if (agentIds.length === 0) return candidates.map(() => ({}));
    const rows = await ctx.db.posts.loadAgentIdentities(agentIds);
    return candidates.map((c): PerCandidate<MuseCandidate> => {
      if (c.postedByAgentId === undefined) return {};
      const r = rows.get(c.postedByAgentId);
      if (r === undefined) return {};
      return {
        agentProvenance: {
          agentId: r.agentId,
          verification: r.verification,
          isBlocked: r.isBlocked,
        },
      };
    });
  }
}

export const MUSE_HYDRATORS = [
  CoreDataHydrator,
  CreatorHydrator,
  InNetworkHydrator,
  MediaHydrator,
  ClassificationHydrator,
  SafetyHydrator,
  MonetizationHydrator,
  AppStateHydrator,
  CounterHydrator,
  TopicHydrator,
  AgentProvenanceHydrator,
] as const;
