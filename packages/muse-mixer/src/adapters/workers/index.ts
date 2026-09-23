// packages/muse-mixer/src/adapters/workers/index.ts
// Workers-side composition: ExecCtx over Hyperdrive clients (SqlClient facade),
// Analytics Engine (StatsSink + TelemetryPort.writeDataPoint) and the
// per-ISOLATE Map cache the §9.4 comment carves out — never Workers KV.
// Bindings stay structural so the package has no @cloudflare/* dependency
// entry even though the lint rule would allow it here.
import type { ExecCtx, KvCache, ParamStore, StatsSink } from "../../framework/types.js";
import type { DbHandles, TelemetryPort } from "../../framework/ports.js";

/** Analytics Engine dataset, structurally — `env.MUSEBOOK_AE.writeDataPoint`. */
export interface AeDataset {
  writeDataPoint(point: { indexes?: string[]; doubles?: number[]; blobs?: string[] }): void;
}

/** Per-isolate TTL cache. Misses are never answers — just a query. */
export function isolateKvCache(): KvCache {
  const g = globalThis as { __museCache?: Map<string, { v: string; exp: number }> };
  g.__museCache ??= new Map();
  const map = g.__museCache;
  return {
    getMany(keys) {
      const now = Date.now();
      return Promise.resolve(
        keys.map((k) => {
          const e = map.get(k);
          if (e === undefined) return undefined;
          if (e.exp < now) {
            map.delete(k);
            return undefined;
          }
          return e.v;
        }),
      );
    },
    set(key, value, ttlSeconds) {
      map.set(key, { v: value, exp: Date.now() + ttlSeconds * 1000 });
      return Promise.resolve();
    },
  };
}

/** Param-store names are CamelCase (`MuseSeenExactWindow`, `MixerPassBudgetMs`)
 *  while Worker vars are `MUSE_SEEN_EXACT_WINDOW` — the raw lookup would never
 *  find them. Translate first, then honor the few names whose env spelling
 *  isn't the mechanical snake-case. */
const PARAM_ENV_ALIASES: Record<string, string> = {
  MuseAnnEfSearch: "MUSE_HNSW_EF_SEARCH",
  MuseModelVersion: "MUSE_RANKER_MODEL_ID",
  MuseRankerModelId: "MUSE_RANKER_MODEL_ID",
};

function envNameFor(paramName: string): string {
  return (
    PARAM_ENV_ALIASES[paramName] ?? paramName.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase()
  );
}

function envLookup(env: Readonly<Record<string, unknown>>, name: string): unknown {
  return env[name] ?? env[envNameFor(name)];
}

/** ctx.params resolution order: resolved `ranking_weights` gates first, then
 *  the Worker var. `gates` is the resolved ActionWeights.gates for this build's
 *  cohort — §9.10's knobs tune with one UPDATE, never a deploy. */
export function envParamStore(
  env: Readonly<Record<string, unknown>>,
  gates?: Record<string, number | boolean>,
): ParamStore {
  return {
    num(name, fallback) {
      const g = gates?.[name];
      if (typeof g === "number") return g;
      const v = envLookup(env, name);
      const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
      return Number.isFinite(n) ? n : fallback;
    },
    bool(name, fallback) {
      const g = gates?.[name];
      if (typeof g === "boolean") return g;
      const v = envLookup(env, name);
      if (typeof v === "boolean") return v;
      if (typeof v === "string") return v === "true" || v === "1";
      return fallback;
    },
    str(name, fallback) {
      const v = envLookup(env, name);
      return typeof v === "string" && v !== "" ? v : fallback;
    },
  };
}

/** StatsSink + the AE half of TelemetryPort over one dataset. */
export function aeStats(ae: AeDataset | undefined): StatsSink {
  const write = (name: string, value: number, tags?: Record<string, string>) => {
    if (ae === undefined) return;
    try {
      ae.writeDataPoint({
        doubles: [value],
        blobs: [name, tags?.["surface"] ?? "", tags?.["stage"] ?? "", tags?.["outcome"] ?? ""],
      });
    } catch {
      // AE is fire-and-forget; a write failure is never a pipeline failure.
    }
  };
  return {
    counter: write,
    timing: write,
  };
}

export function workersExecCtx(input: {
  env: Readonly<Record<string, unknown>>;
  db: DbHandles;
  ae?: AeDataset;
  cache?: KvCache;
  stats?: StatsSink;
  now?: number;
  /** Resolved ActionWeights.gates for this build's cohort — wins over env. */
  gates?: Record<string, number | boolean>;
}): ExecCtx {
  const params = envParamStore(input.env, input.gates);
  const now = input.now ?? Date.now();
  const deadline = now + params.num("MixerPassBudgetMs", 20000);
  return {
    now,
    deadline,
    params,
    stats: input.stats ?? aeStats(input.ae),
    cache: input.cache ?? isolateKvCache(),
    db: input.db,
    budgetMs: () => Math.max(0, deadline - Date.now()),
  };
}

/** Compose the telemetry port: AE firehose + agent-plane inserts via jobs db. */
export function workersTelemetry(
  ae: AeDataset | undefined,
  insertAgentActions: (rows: ReadonlyArray<Record<string, unknown>>) => Promise<void>,
): TelemetryPort {
  const stats = aeStats(ae);
  return {
    writeDataPoint(metric, value, tags) {
      stats.counter(metric, value, tags);
    },
    insertAgentActions,
  };
}
