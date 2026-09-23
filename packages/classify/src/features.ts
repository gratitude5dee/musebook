// packages/classify/src/features.ts
/** Normalized rubric positions in [0,1]. Magnitudes. Combinable with one another. */
export const RUBRIC_FEATURES = ["quality", "audience_level", "agent_value"] as const;

/** Calibrated probabilities in [0,1]. Gates, and features in their own right.
 *  NEVER averaged with RUBRIC_FEATURES — see §8.12. */
export const PROBABILITY_FEATURES = [
  "toxicity",
  "spam",
  "commercial_intent",
  "p_unsafe",
  "p_nsfw",
  "p_brand_unsafe",
  "p_ai_generated",
  "p_discloses_ai",
  "p_contains_pii",
] as const;
