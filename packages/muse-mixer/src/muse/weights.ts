// packages/muse-mixer/src/muse/weights.ts
import type { MuseAction, MuseContinuous } from "./actions.js";
import type { MuseFeedQuery } from "./query.js";
import type { ExecCtx } from "../framework/types.js";

export interface ActionWeights {
  version: string; // the ranking_weights.weights_version row that resolved
  cohort: string;
  discrete: Record<MuseAction, number>; // SIGNED: negative heads hold negative values
  continuous: Record<MuseContinuous, number>;
  negativeSum: number; // Σ |w| over MUSE_NEGATIVE_ACTIONS, precomputed
  totalSum: number; // Σ |w| over every discrete head, precomputed
  gates: Record<string, number | boolean>; // the shaping params of §9.10, read through ParamStore
}

export interface CohortKey {
  family: string; // MUSE_WEIGHTS_VERSION, e.g. 'v1'
  viewerKind: "human" | "agent";
  isNewUserForRanking: boolean; // actionCount < MuseRankerNewUserActionThreshold
  countryCode: string | null;
  surface: string; // 'home' | 'reels' | …
  experimentBucket: string; // `exp:b${hash(viewerId) % 100}`
}

export function cohortCandidates(k: CohortKey): string[] {
  const out: string[] = [k.experimentBucket];
  if (k.viewerKind === "agent") out.push("agent");
  if (k.isNewUserForRanking) out.push("newuser");
  if (k.countryCode !== null) out.push(`country:${k.countryCode}`);
  out.push(`surface:${k.surface}`, "default");
  return out; // first row found in this order wins
}

export interface WeightsLoader {
  load(k: CohortKey): Promise<ActionWeights>;
}

export function cohortKeyFor(q: MuseFeedQuery, ctx: ExecCtx): CohortKey {
  return {
    family: ctx.params.str("MuseWeightsVersion", "v1"),
    viewerKind: q.viewerKind,
    isNewUserForRanking: q.actionCount < ctx.params.num("MuseRankerNewUserActionThreshold", 50),
    countryCode: q.countryCode,
    surface: q.surface,
    experimentBucket: `exp:b${stableBucket(q.viewerId ?? q.sessionId)}`,
  };
}

/** FNV-1a 32-bit, mod 100. Deterministic across isolates — do NOT use a runtime hash seed. */
export function stableBucket(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % 100;
}
