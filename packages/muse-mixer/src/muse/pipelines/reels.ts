// packages/muse-mixer/src/muse/pipelines/reels.ts
// The reels slate (§9.24): same stages as musePipeline, but the source set leans
// on CompletionTrendingSource + SoundtrackSource and the scorer order puts
// WatchTimeScorer before RankingScorer's cold-start/diversity tail — unchanged
// per §9.13, since WatchTimeScorer only writes `score` via the length penalty
// multiplier and ColdStartScorer reads `weightedScore` (never conflated).
import type { CandidatePipeline } from "../../framework/pipeline.js";
import type { Source } from "../../framework/types.js";
import { musePipeline, type MusePipelineOptions } from "../pipeline.js";
import {
  EmbeddingRetrievalSource,
  FollowGraphSource,
  ColdStartSeedSource,
  CompletionTrendingSource,
  SoundtrackSource,
} from "../sources/index.js";
import type { MuseFeedQuery } from "../query.js";
import type { MuseCandidate } from "../candidate.js";

export function reelsPipeline(
  opts: MusePipelineOptions,
): CandidatePipeline<MuseFeedQuery, MuseCandidate> {
  const base = musePipeline(opts);
  return {
    ...base,
    name: "muse-reels",
    sources(): Array<Source<MuseFeedQuery, MuseCandidate>> {
      // Reels sources (§9.24): embedding retrieval + in-network + cold start seed +
      // the two reels-only ones. CompletionTrending + Soundtrack are enable()'d
      // on surface === 'reels' in musePipeline too, but listing them here makes
      // the reels inventory explicit and independent of the shared list's order.
      return [
        new FollowGraphSource(),
        new EmbeddingRetrievalSource(),
        new ColdStartSeedSource(),
        new CompletionTrendingSource(),
        new SoundtrackSource(),
      ];
    },
  };
}
