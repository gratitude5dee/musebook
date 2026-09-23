// packages/muse-mixer/src/adapters/memory/index.ts
// In-process fixtures for tests + the §9.18 replay harness. No platform imports —
// this adapter is what makes the whole pipeline runnable without a database.
import type {
  BloomPort,
  ClusterPort,
  DbHandles,
  GraphPort,
  MonetizationPort,
  PostsPort,
  RecentActionsPort,
  RetrievalPort,
  SlatePort,
  TelemetryPort,
  ViewerSequence,
  PostCoreRow,
  PostStatsRow,
} from "../../framework/ports.js";
import type { ExecCtx, KvCache, ParamStore, StatsSink } from "../../framework/types.js";
import { memoryStatsSink } from "../../framework/summary.js";
import type { MuseAction, MuseContinuous } from "../../muse/actions.js";
import { MUSE_ACTIONS, MUSE_CONTINUOUS, MUSE_NEGATIVE_ACTIONS } from "../../muse/actions.js";
import type { ActionWeights, WeightsLoader } from "../../muse/weights.js";

export function memoryParams(
  overrides: Record<string, number | string | boolean> = {},
): ParamStore {
  return {
    num(name: string, fallback: number): number {
      const v = overrides[name];
      return typeof v === "number" ? v : fallback;
    },
    bool(name: string, fallback: boolean): boolean {
      const v = overrides[name];
      return typeof v === "boolean" ? v : fallback;
    },
    str(name: string, fallback: string): string {
      const v = overrides[name];
      return typeof v === "string" ? v : fallback;
    },
  };
}

export function memoryCache(): KvCache & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    getMany(keys: readonly string[]): Promise<ReadonlyArray<string | undefined>> {
      return Promise.resolve(keys.map((k) => store.get(k)));
    },
    set(key: string, value: string): Promise<void> {
      store.set(key, value);
      return Promise.resolve();
    },
  };
}

/** The v1/default priors as an ActionWeights value — mirrors the ranking_weights row. */
export function memoryActionWeights(overrides: Partial<ActionWeights> = {}): ActionWeights {
  const discrete = Object.fromEntries(MUSE_ACTIONS.map((a) => [a, 0])) as Record<
    MuseAction,
    number
  >;
  Object.assign(discrete, {
    impression: 0,
    view: 0.02,
    dwell: 0.2,
    play: 0.08,
    play_through: 0.6,
    like: 1,
    comment: 2.2,
    repost: 3,
    bookmark: 2.5,
    share: 3,
    follow: 4,
    remix: 6,
    fork_app: 7,
    install_app: 9,
    tip: 8,
    x402_pay: 5,
    agent_crawl: 1.2,
    agent_cite: 2,
    not_interested: -12,
    mute_creator: -25,
    block_creator: -60,
    report: -80,
    not_dwelled: -1.5,
  });
  const continuous = Object.fromEntries(MUSE_CONTINUOUS.map((c) => [c, 0])) as Record<
    MuseContinuous,
    number
  >;
  Object.assign(continuous, {
    dwell_time_s: 0.06,
    watch_time_ms: 0.000004,
    scroll_depth: 0.3,
    active_seconds_5m: 0.01,
    tip_amount_usdc: 0.5,
  });
  let negativeSum = 0;
  let totalSum = 0;
  for (const a of MUSE_ACTIONS) {
    totalSum += Math.abs(discrete[a]);
    if ((MUSE_NEGATIVE_ACTIONS as readonly string[]).includes(a))
      negativeSum += Math.abs(discrete[a]);
  }
  return {
    version: "v1",
    cohort: "default",
    discrete,
    continuous,
    negativeSum,
    totalSum,
    gates: {
      minMediaDurationMs: 5000,
      enablePlayThroughDurationCheck: true,
      negativeScoresOffset: 100,
      postUnexploredWeight: 0.35,
      enableMultiplicativePostUnexplored: false,
      multiplicativePostUnexploredAlpha: 0.15,
      bidirectionalFollowCommentBoost: 1.35,
      bidirectionalFollowDwellBoost: 1.2,
      agentAuthoredMultiplier: 1.0,
    },
    ...overrides,
  };
}

export function memoryWeightsLoader(weights: ActionWeights = memoryActionWeights()): WeightsLoader {
  return {
    load(): Promise<ActionWeights> {
      return Promise.resolve(weights);
    },
  };
}

const emptyGraph: GraphPort = {
  followedCreatorIds() {
    return Promise.resolve([]);
  },
  followerCreatorIds() {
    return Promise.resolve([]);
  },
  followedTopicIds() {
    return Promise.resolve([]);
  },
  blockedUserIds() {
    return Promise.resolve([]);
  },
  mutedBy() {
    return Promise.resolve({ userIds: [], keywords: [] });
  },
  paidContentHashes() {
    return Promise.resolve([]);
  },
  loadCreators() {
    return Promise.resolve(new Map());
  },
};

const emptyRecent: RecentActionsPort = {
  loadViewerSequence(): Promise<ViewerSequence | null> {
    return Promise.resolve({
      actionCount: 0,
      actions: [],
      topicCounts: new Map(),
      computedAt: null,
    });
  },
};

const emptyRetrieval: RetrievalPort = {
  viewerEmbedding() {
    return Promise.resolve(null);
  },
  similarPosts() {
    return Promise.resolve([]);
  },
  postEmbeddings() {
    return Promise.resolve(new Map());
  },
  newUserIndexEmbedding() {
    return Promise.resolve(null);
  },
};

const emptyPosts: PostsPort = {
  loadCore() {
    return Promise.resolve(new Map<string, PostCoreRow>());
  },
  loadMedia() {
    return Promise.resolve(new Map());
  },
  loadPostStats() {
    return Promise.resolve(new Map<string, PostStatsRow>());
  },
  trending() {
    return Promise.resolve([]);
  },
  loadClassifications() {
    return Promise.resolve(new Map());
  },
  loadAgentIdentities() {
    return Promise.resolve(new Map());
  },
  loadArtifactState() {
    return Promise.resolve(new Map());
  },
  runSourceQuery() {
    return Promise.resolve([]);
  },
};

const emptyMonetization: MonetizationPort = {
  forCandidates() {
    return Promise.resolve(new Map());
  },
};

const memorySlates: SlatePort = {
  writeSlate() {
    return Promise.resolve();
  },
  previousScores() {
    return Promise.resolve(null);
  },
  needsBuild() {
    return Promise.resolve(true);
  },
};

const memoryBloomStore = new Map<
  string,
  {
    viewerUserId: string;
    isoWeek: string;
    filterJson: unknown;
    prevFilterJson: unknown;
    recentIds: string[];
    updatedAt: string;
  }
>();
const emptyBloom: BloomPort = {
  loadSeen(viewerUserId: string) {
    return Promise.resolve(memoryBloomStore.get(viewerUserId) ?? null);
  },
  updateSeen(input) {
    const prev = memoryBloomStore.get(input.viewerUserId);
    memoryBloomStore.set(input.viewerUserId, {
      viewerUserId: input.viewerUserId,
      isoWeek: input.isoWeek,
      filterJson: input.filterJson,
      prevFilterJson:
        prev?.isoWeek === input.isoWeek
          ? (prev.prevFilterJson ?? null)
          : (prev?.filterJson ?? null),
      recentIds: [...input.servedIds, ...(prev?.recentIds ?? [])].slice(0, input.maxRecentIds),
      updatedAt: new Date().toISOString(),
    });
    return Promise.resolve();
  },
};

const emptyClusters: ClusterPort = {
  clustersForCreators() {
    return Promise.resolve(new Map());
  },
  creatorsForClusters() {
    return Promise.resolve([]);
  },
  viewerClusters() {
    return Promise.resolve([]);
  },
};

const memoryTelemetry: TelemetryPort = {
  writeDataPoint() {},
  insertAgentActions() {
    return Promise.resolve();
  },
};

export interface MemoryHandlesOptions {
  posts?: PostsPort;
  graph?: GraphPort;
  recent?: RecentActionsPort;
  retrieval?: RetrievalPort;
  monetization?: MonetizationPort;
  slates?: SlatePort;
  bloom?: BloomPort;
  clusters?: ClusterPort;
  telemetry?: TelemetryPort;
}

export function memoryDbHandles(opts: MemoryHandlesOptions = {}): DbHandles {
  return {
    graph: opts.graph ?? emptyGraph,
    recent: opts.recent ?? emptyRecent,
    retrieval: opts.retrieval ?? emptyRetrieval,
    posts: opts.posts ?? emptyPosts,
    monetization: opts.monetization ?? emptyMonetization,
    slates: opts.slates ?? memorySlates,
    bloom: opts.bloom ?? emptyBloom,
    clusters: opts.clusters ?? emptyClusters,
    telemetry: opts.telemetry ?? memoryTelemetry,
  };
}

export function memoryCtx(
  opts: {
    now?: number;
    budgetMs?: number;
    params?: Record<string, number | string | boolean>;
    db?: DbHandles;
    stats?: StatsSink;
  } = {},
): ExecCtx {
  const now = opts.now ?? Date.now();
  const params = memoryParams(opts.params);
  const deadline = now + params.num("MixerPassBudgetMs", opts.budgetMs ?? 20000);
  return {
    now,
    deadline,
    params,
    stats: opts.stats ?? memoryStatsSink(),
    cache: memoryCache(),
    db: opts.db ?? memoryDbHandles(),
    budgetMs(): number {
      return Math.max(0, deadline - Date.now());
    },
  };
}
