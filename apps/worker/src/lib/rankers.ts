// apps/worker/src/lib/rankers.ts — §9.15's promotion path, read side.
//
// `model_registry` is the source of truth for which ranker serves and which
// scores in shadow: one `linear`-family row at `status='active'` is the
// incumbent (today `v1.model-heuristic`), one at `status='shadow'` is the
// candidate. A promotion or rollback is one UPDATE on `status` — never a
// deploy, never an env var (M15.2/4: `MuseRankerModelId` becomes the resolved
// default, not the mechanism).
//
// Coefficients are data: each linear row's blob lives in `ranking_weights`
// keyed on `weights_version = model_version`, under `weights.heuristic` or
// `weights.learned` — the same {intercept, coefs} shape `evaluateLogistic`
// consumes either way (§9.15: v1.1 ships coefficients, not a runtime).
import {
  HeuristicMuseRanker,
  LearnedMuseRanker,
  type HeuristicCoefficients,
  type MuseRanker,
} from "@musebook/muse-mixer";
import type { DbClient } from "../db.js";

export interface ResolvedRankers {
  /** The ranker the slate serves — the active `linear` row, else launch-day
   *  heuristic constants when the registry names nothing it can build. */
  active: MuseRanker;
  activeVersion: string;
  /** The ranker that scores every built slate and serves nothing, or null
   *  when no `shadow` row exists. */
  shadow: MuseRanker | null;
}

const HEURISTIC_VERSION = "v1.model-heuristic";

function coefficientsOf(row: { weights: unknown } | undefined): HeuristicCoefficients | null {
  const w = row?.weights;
  if (w === null || typeof w !== "object") return null;
  const blob = w as Record<string, unknown>;
  const coefs = (blob["learned"] ?? blob["heuristic"]) as HeuristicCoefficients | undefined;
  return coefs === undefined || coefs === null ? null : coefs;
}

function rankerFor(modelVersion: string, coefs: HeuristicCoefficients): MuseRanker {
  return modelVersion === HEURISTIC_VERSION
    ? new HeuristicMuseRanker(coefs)
    : new LearnedMuseRanker(modelVersion, coefs);
}

/**
 * Read `model_registry` × `ranking_weights` once per build. The jobs plane
 * reads both tables directly (§4.14); a row the loader can't hydrate (no
 * weights row, no coefficient blob) is a reason that ranker isn't promoted,
 * not a thrown build.
 */
export async function resolveMuseRankers(fresh: DbClient): Promise<ResolvedRankers> {
  const { rows } = await fresh.query<{
    model_version: string;
    status: string;
    weights: unknown;
  }>(
    `select r.model_version, r.status, w.weights
       from public.model_registry r
       left join public.ranking_weights w on w.weights_version = r.model_version
      where r.family = 'linear' and r.status in ('active', 'shadow')`,
  );

  const resolved = new Map<string, MuseRanker>();
  for (const r of rows) {
    const coefs = coefficientsOf(r);
    if (coefs !== null) resolved.set(r.status, rankerFor(r.model_version, coefs));
  }

  const activeRow = rows.find((r) => r.status === "active");
  const active = resolved.get("active") ?? new HeuristicMuseRanker();
  return {
    active,
    activeVersion: resolved.has("active")
      ? (activeRow?.model_version ?? HEURISTIC_VERSION)
      : active.modelVersion,
    shadow: resolved.get("shadow") ?? null,
  };
}
