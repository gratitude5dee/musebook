// packages/muse-mixer/src/muse/pipeline.ts
// The home/explore slate pipeline (§9.21): the ordered inventory of query
// hydrators, sources, candidate hydrators, filters, scorers and side effects.
// The reels variant lives in pipelines/reels.ts — same stages, surface-swapped.
import type { CandidatePipeline } from "../framework/pipeline.js";
import type {
  Filter,
  Hydrator,
  QueryHydrator,
  Scorer,
  Selector,
  SideEffect,
  Source,
} from "../framework/types.js";
import type { StatsSink } from "../framework/types.js";
import type { WeightsLoader } from "./weights.js";
import type { MuseRanker } from "./scorers/muse_scorer.js";
import { SeenBloom } from "./bloom.js";
import {
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
} from "./queryHydrators/index.js";
import {
  FollowGraphSource,
  EmbeddingRetrievalSource,
  TopicSource,
  TrendingSource,
  CoEngagementSource,
  AgentAuthoredSource,
  AppArtifactSource,
  RemixLineageSource,
  ColdStartSeedSource,
  CompletionTrendingSource,
  SoundtrackSource,
} from "./sources/index.js";
import {
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
} from "./hydrators/index.js";
import {
  DropDuplicatesFilter,
  CoreDataHydrationFilter,
  SelfPostFilter,
  AgeFilter,
  KindFilter,
  TopicIdsFilter,
  PreviouslyServedFilter,
} from "./filters/index.js";
import {
  PreviouslySeenFilter,
  PreviouslySeenBackupFilter,
  BlockMuteFilter,
  MutedKeywordFilter,
  RemixDedupFilter,
  SafetyDropFilter,
  NewUserMinEngagementFilter,
  ReelsPlayableFilter,
} from "./filters/previously_seen_filter.js";
import { MuseScorer } from "./scorers/muse_scorer.js";
import { RankingScorer } from "./scorers/ranking_scorer.js";
import { WatchTimeScorer } from "./scorers/watch_time_scorer.js";
import { ColdStartScorer } from "./scorers/cold_start_scorer.js";
import { DiversityScorer } from "./scorers/diversity_scorer.js";
import { TopKScoreSelector } from "./selectors/top_k_score_selector.js";
import {
  writeSlateEffect,
  updateSeenBloomEffect,
  telemetryEffect,
  slateImpressionsEffect,
} from "./sideEffects/index.js";
import type { MuseFeedQuery } from "./query.js";
import type { MuseCandidate } from "./candidate.js";

function deserializeBloom(serialized: string | null): SeenBloom | null {
  if (serialized === null) return null;
  try {
    return SeenBloom.deserialize(JSON.parse(serialized));
  } catch {
    return null;
  }
}

export interface MusePipelineOptions {
  ranker: MuseRanker;
  weightsLoader: WeightsLoader;
  /** bloom bypass ratio — MUSE_BLOOM_BYPASS_REMOVAL_RATIO (0.70). */
  bloomBypassRatio?: number;
  /** MuseRetrievalNewUserActionThreshold — distinct from the ranker's (50). */
  retrievalNewUserActionThreshold?: number;
  /** engagement floor for NewUserMinEngagementFilter. */
  newUserMinEngagements?: number;
  /**
   * Stats sink for the PreviouslySeenFilter circuit-breaker counter — filters
   * are 2-arg (no ctx), so the adapter passes its per-build sink here.
   */
  stats?: StatsSink;
}

/**
 * §9.21's stage order is load-bearing:
 *   query hydrators (parallel) → sources (parallel, own timeout)
 *   → candidate hydrators (parallel allSettled) → filters (sequential, cheap → expensive)
 *   → MuseScorer → RankingScorer → [WatchTimeScorer: reels] → ColdStartScorer → DiversityScorer
 *   → TopKScoreSelector → side effects.
 */
export function musePipeline(
  opts: MusePipelineOptions,
): CandidatePipeline<MuseFeedQuery, MuseCandidate> {
  const bypass = opts.bloomBypassRatio ?? 0.7;
  const retrievalThreshold = opts.retrievalNewUserActionThreshold ?? 20;
  const minEngagements = opts.newUserMinEngagements ?? 1;
  return {
    name: "muse",
    queryHydrators(): Array<QueryHydrator<MuseFeedQuery>> {
      // §9.6's 13; DAG layers resolve Mutual→FollowGraph, Embedding→RetrievalSeq,
      // Inferred→ScoringSeq.
      return [
        new ViewerProfileQueryHydrator(),
        new FollowGraphQueryHydrator(),
        new MutualFollowQueryHydrator(),
        new BlockMuteQueryHydrator(),
        new ScoringSequenceQueryHydrator(),
        new RetrievalSequenceQueryHydrator(),
        new ViewerEmbeddingQueryHydrator(),
        new FollowedTopicsQueryHydrator(),
        new InferredTopicsQueryHydrator(),
        new ImpressionBloomQueryHydrator(),
        new SeenIdsExactQueryHydrator(),
        new EntitlementsQueryHydrator(),
        new ExperimentBucketQueryHydrator(),
      ];
    },
    sources(): Array<Source<MuseFeedQuery, MuseCandidate>> {
      // §9.7: order is not cosmetic — the first six matter most under the 6-connection cap.
      return [
        new FollowGraphSource(),
        new EmbeddingRetrievalSource(),
        new TopicSource(),
        new TrendingSource(),
        new CoEngagementSource(),
        new AgentAuthoredSource(),
        new AppArtifactSource(),
        new RemixLineageSource(),
        new ColdStartSeedSource(),
        new CompletionTrendingSource(),
        new SoundtrackSource(),
      ];
    },
    hydrators(): Array<Hydrator<MuseFeedQuery, MuseCandidate>> {
      return [
        new CoreDataHydrator(),
        new CreatorHydrator(),
        new InNetworkHydrator(),
        new MediaHydrator(),
        new ClassificationHydrator(),
        new SafetyHydrator(),
        new MonetizationHydrator(),
        new AppStateHydrator(),
        new CounterHydrator(),
        new TopicHydrator(),
        new AgentProvenanceHydrator(),
      ];
    },
    filters(): Array<Filter<MuseFeedQuery, MuseCandidate>> {
      return [
        new DropDuplicatesFilter(),
        new CoreDataHydrationFilter(),
        new SelfPostFilter(),
        new AgeFilter(),
        new KindFilter(),
        new TopicIdsFilter(),
        new PreviouslyServedFilter(),
        // Blooms are deserialized lazily inside the filter call so a corrupt blob costs one build, not the process.
        {
          name: "PreviouslySeenFilter",
          filter: (q, candidates) =>
            new PreviouslySeenFilter(
              deserializeBloom(q.seenBloomSerialized),
              deserializeBloom(q.seenBloomPrevSerialized),
              bypass,
              opts.stats ?? null,
            ).filter(q, candidates),
        },
        new PreviouslySeenBackupFilter(),
        new BlockMuteFilter(),
        new MutedKeywordFilter(),
        new RemixDedupFilter(),
        new SafetyDropFilter(),
        new NewUserMinEngagementFilter(retrievalThreshold, minEngagements),
        new ReelsPlayableFilter(),
      ];
    },
    scorers(): Array<Scorer<MuseFeedQuery, MuseCandidate>> {
      // Load-bearing order (§9.13): ranker heads → linear weighting → [watch time] → cold start → diversity.
      return [
        new MuseScorer(opts.ranker),
        new RankingScorer(opts.weightsLoader),
        new WatchTimeScorer(),
        new ColdStartScorer(),
        new DiversityScorer(),
      ];
    },
    selector(): Selector<MuseFeedQuery, MuseCandidate> {
      return new TopKScoreSelector();
    },
    sideEffects(): Array<SideEffect<MuseFeedQuery, MuseCandidate>> {
      return [
        writeSlateEffect(),
        updateSeenBloomEffect(),
        telemetryEffect(),
        slateImpressionsEffect(),
      ];
    },
  };
}
