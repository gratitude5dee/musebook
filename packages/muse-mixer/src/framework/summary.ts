import type { StatsSink } from "./types.js";

/** Per-stage telemetry collected across one pass; lands on the slate's params. */
export interface PipelineSummary {
  pipeline: string;
  startedAt: number;
  finishedAt: number;
  stageCounts: Record<string, { enabled: number; disabled: number }>;
  sourceSizes: Record<string, number>;
  sourceErrors: Record<string, string>;
  filterRates: Record<string, number>;
  hydrated: number;
  selected: number;
  rung: string | null;
}

export function emptySummary(pipeline: string, startedAt: number): PipelineSummary {
  return {
    pipeline,
    startedAt,
    finishedAt: startedAt,
    stageCounts: {},
    sourceSizes: {},
    sourceErrors: {},
    filterRates: {},
    hydrated: 0,
    selected: 0,
    rung: null,
  };
}

/** A StatsSink that records into memory (tests, replay) — no platform import. */
export function memoryStatsSink(
  store?: Map<string, number>,
): StatsSink & { store: Map<string, number> } {
  const m = store ?? new Map<string, number>();
  return {
    store: m,
    counter(name: string, value: number, tags?: Record<string, string>): void {
      const key =
        tags && Object.keys(tags).length > 0
          ? `${name}{${Object.entries(tags)
              .map(([k, v]) => `${k}=${v}`)
              .join(",")}}`
          : name;
      m.set(key, (m.get(key) ?? 0) + value);
    },
    timing(name: string, ms: number, tags?: Record<string, string>): void {
      const key =
        tags && Object.keys(tags).length > 0
          ? `${name}{${Object.entries(tags)
              .map(([k, v]) => `${k}=${v}`)
              .join(",")}}`
          : name;
      m.set(key, (m.get(key) ?? 0) + ms);
    },
  };
}
