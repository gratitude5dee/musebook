// @musebook/muse-mixer — the offline slate builder (section 9).
// Nothing in this package imports a platform library outside src/adapters/.
export type {
  PipelineQuery,
  PipelineCandidate,
  PerCandidate,
  StatsSink,
  KvCache,
  ParamStore,
  ExecCtx,
  Source,
  QueryHydrator,
  Hydrator,
  Filter,
  FilterResult,
  Scorer,
  Selector,
  SelectResult,
  SideEffect,
} from "./framework/types.js";
export { SKIP } from "./framework/types.js";
export type {
  DbHandles,
  MonetizationPort,
  SlatePort,
  PostKindFilter,
  GraphPort,
  ViewerSequence,
  RecentActionsPort,
  RetrievalPort,
  PostCoreRow,
  PostStatsRow,
  PostsPort,
  SeenState,
  BloomPort,
  ClusterPort,
  TelemetryPort,
  ShadowScorePoint,
} from "./framework/ports.js";
export { withTimeout, mergePerCandidate } from "./framework/merge.js";
export {
  execute,
  topoLayers,
  type CandidatePipeline,
  type ExecuteResult,
} from "./framework/pipeline.js";
export { emptySummary, memoryStatsSink, type PipelineSummary } from "./framework/summary.js";

export {
  MUSE_ACTIONS,
  MUSE_CONTINUOUS,
  MUSE_NEGATIVE_ACTIONS,
  type MuseAction,
  type MuseContinuous,
} from "./muse/actions.js";
export type { MuseFeedQuery, MuseCursor, ViewerKind } from "./muse/query.js";
export type { MuseCandidate } from "./muse/candidate.js";
export {
  type ActionWeights,
  type CohortKey,
  type WeightsLoader,
  cohortCandidates,
  cohortKeyFor,
  stableBucket,
} from "./muse/weights.js";
export { fnv1a32, splitmix32, slateRng } from "./muse/rng.js";
export { bloomParams, SeenBloom } from "./muse/bloom.js";

export type {
  ViewerContext,
  ActionPrediction,
  MuseRanker,
  CandidateFeatures,
} from "./muse/scorers/muse_scorer.js";
export {
  MuseScorer,
  viewerContextFor,
  candidateFeatures,
  cosine,
} from "./muse/scorers/muse_scorer.js";
export { RankingScorer, computeWeightedScore, offsetScore } from "./muse/scorers/ranking_scorer.js";
export { WatchTimeScorer } from "./muse/scorers/watch_time_scorer.js";
export { ColdStartScorer } from "./muse/scorers/cold_start_scorer.js";
export { DiversityScorer } from "./muse/scorers/diversity_scorer.js";
export {
  HeuristicMuseRanker,
  HEURISTIC_V1_COEFFICIENTS,
  evaluateLogistic,
  type LogisticHead,
  type HeuristicCoefficients,
} from "./muse/rankers/heuristic.js";
export { LearnedMuseRanker, type LearnedCoefficients } from "./muse/rankers/learned.js";
export { TopKScoreSelector } from "./muse/selectors/top_k_score_selector.js";

export * from "./muse/queryHydrators/index.js";
export * from "./muse/sources/index.js";
export * from "./muse/hydrators/index.js";
export * from "./muse/filters/index.js";
export {
  PreviouslySeenFilter,
  PreviouslySeenBackupFilter,
  BlockMuteFilter,
  MutedKeywordFilter,
  RemixDedupFilter,
  SafetyDropFilter,
  NewUserMinEngagementFilter,
  ReelsPlayableFilter,
} from "./muse/filters/previously_seen_filter.js";
export * from "./muse/sideEffects/index.js";

export { musePipeline, type MusePipelineOptions } from "./muse/pipeline.js";
export { reelsPipeline } from "./muse/pipelines/reels.js";
export {
  buildQuery,
  slateRowFor,
  weightsRowVersion,
  type BuildSlateRequest,
} from "./muse/build.js";

export {
  memoryActionWeights,
  memoryCache,
  memoryCtx,
  memoryDbHandles,
  memoryParams,
  memoryWeightsLoader,
  type MemoryHandlesOptions,
} from "./adapters/memory/index.js";
