// @musebook/distributor — the per-platform reformatting engine (plan §12).
// Variants are FULL PORTS, not teasers (CF-SPINE §13.3).
export type {
  PlatformConstraint,
  PlatformRow,
  ConstraintOverride,
  PlatformEditor,
  HashtagStyle,
} from "./constraints";
export { toConstraint } from "./constraints";
export { countEffective, countGraphemes, countLength } from "./count";
export type { CountMethod } from "./count";
export { splitIntoThread, truncateTo } from "./split";
export type { SplitOptions } from "./split";
export { validateVariant } from "./validate";
export type {
  CandidateMedia,
  Check,
  Severity,
  ValidatorReport,
  VariantCandidate,
} from "./validate";
export { deterministicVariant } from "./fallback";
export type { FallbackInput } from "./fallback";
export { proposeVariant, variantProposal } from "./reformat";
export type { ProposeInput, VariantIntent, VariantProposal } from "./reformat";
export { produceVariant } from "./pipeline";
export type { PipelineInput, VariantResult } from "./pipeline";
export { PostizClient, PostizHttpError, postizClient } from "./postiz/client";
export type {
  DistributorEnv,
  PostizAnalytics,
  PostizClientConfig,
  PostizIntegration,
  PostizMedia,
} from "./postiz/client";
export type {
  PostizCreatePostBody,
  PostizMediaRef,
  PostizPostContent,
  PostizPostEntry,
} from "./postiz/types";
export type {
  DistributionMessage,
  PlanMessage,
  ReconcileMessage,
  SendMessage,
  VariantMessage,
} from "./plan";
export { planSendBuckets } from "./plan";
export type { PlanChannel } from "./plan";
export { extractProviderFromValidationError, sendWithPartialRetry } from "./send";
export type { SendDeps } from "./send";
export { normalize } from "./analytics/normalize";
export type { NormalizedMetrics } from "./analytics/normalize";
export { collectionComplete, dueTicks } from "./analytics/schedule";
