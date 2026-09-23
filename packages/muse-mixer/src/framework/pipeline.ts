import { mergePerCandidate, withTimeout } from "./merge.js";
import { emptySummary, type PipelineSummary } from "./summary.js";
import type {
  ExecCtx,
  Filter,
  Hydrator,
  PipelineCandidate,
  PipelineQuery,
  QueryHydrator,
  Scorer,
  Selector,
  SideEffect,
  Source,
} from "./types.js";

export interface CandidatePipeline<Q extends PipelineQuery, C extends PipelineCandidate> {
  readonly name: string;
  queryHydrators(): ReadonlyArray<QueryHydrator<Q>>;
  sources(): ReadonlyArray<Source<Q, C>>;
  hydrators(): ReadonlyArray<Hydrator<Q, C>>;
  filters(): ReadonlyArray<Filter<Q, C>>;
  scorers(): ReadonlyArray<Scorer<Q, C>>;
  selector(): Selector<Q, C>;
  postSelectionHydrators?(): ReadonlyArray<Hydrator<Q, C>>;
  postSelectionFilters?(): ReadonlyArray<Filter<Q, C>>;
  sideEffects?(): ReadonlyArray<SideEffect<Q, C>>;
  resultSize?(query: Q, ctx: ExecCtx): number;
}

export interface ExecuteResult<Q, C> {
  query: Q;
  selected: C[];
  nonSelected: C[];
  removed: Array<{ candidate: C; reason: string }>;
  summary: PipelineSummary;
  /** NOT awaited by execute(). The caller passes it to ctx.waitUntil(). */
  sideEffects: () => Promise<void>;
}

/**
 * Topological layers by `dependsOn`: a hydrator lands in the first layer after all
 * of its dependencies. Within a layer they run together (Promise.allSettled); a
 * rejection leaves the default in place. Cycles are a config error — the leftover
 * hydrators run in one final allSettled layer so the build still happens.
 */
export function topoLayers<Q extends PipelineQuery>(
  hydrators: ReadonlyArray<QueryHydrator<Q>>,
): Array<QueryHydrator<Q>[]> {
  const remaining = new Map(hydrators.map((h) => [h.name, h]));
  const done = new Set<string>();
  const layers: Array<QueryHydrator<Q>[]> = [];
  while (remaining.size > 0) {
    const layer: Array<QueryHydrator<Q>> = [];
    for (const h of remaining.values()) {
      const deps = h.dependsOn ?? [];
      if (deps.every((d) => done.has(d))) layer.push(h);
    }
    if (layer.length === 0) {
      // dependency cycle or a name that does not exist: drain everything rather than hang
      layers.push([...remaining.values()]);
      break;
    }
    for (const h of layer) {
      done.add(h.name);
      remaining.delete(h.name);
    }
    layers.push(layer);
  }
  return layers;
}

async function stageMs(stage: string, f: () => Promise<void>, ctx: ExecCtx): Promise<void> {
  const t0 = Date.now();
  try {
    await f();
  } finally {
    ctx.stats.timing("muse.stage.latency_ms", Date.now() - t0, { stage });
  }
}

export async function execute<Q extends PipelineQuery, C extends PipelineCandidate>(
  pipeline: CandidatePipeline<Q, C>,
  initialQuery: Q,
  ctx: ExecCtx,
): Promise<ExecuteResult<Q, C>> {
  const summary = emptySummary(pipeline.name, ctx.now);
  const stats = ctx.stats;
  const removed: Array<{ candidate: C; reason: string }> = [];
  let candidates: C[] = [];

  const countStages = <T extends { name: string; enable?: (q: Q) => boolean }>(
    stage: string,
    stages: ReadonlyArray<T>,
    q: Q,
  ): Map<string, T> => {
    let enabled = 0;
    let disabled = 0;
    const live = new Map<string, T>();
    for (const s of stages) {
      const on = s.enable?.(q) !== false;
      if (on) {
        enabled++;
        live.set(s.name, s);
      } else {
        disabled++;
        stats.counter("muse.stage.disabled", 1, { stage, name: s.name });
      }
    }
    summary.stageCounts[stage] = { enabled, disabled };
    stats.counter("muse.stage.total_count", stages.length, { stage });
    stats.counter("muse.stage.enabled_count", enabled, { stage });
    return live;
  };

  // 1. Query hydrators: DAG layers, allSettled inside a layer.
  const query = initialQuery;
  const liveQueryHydrators = countStages("query_hydrators", pipeline.queryHydrators(), query);
  for (const layer of topoLayers([...liveQueryHydrators.values()])) {
    const settled = await Promise.allSettled(layer.map((h) => h.hydrate(query, ctx)));
    for (let i = 0; i < layer.length; i++) {
      const r = settled[i];
      if (r === undefined) continue;
      if (r.status === "fulfilled") Object.assign(query, r.value);
      // rejection leaves the default in place — §9.4 obligation 1
    }
  }

  // 2. Sources: allSettled with per-source timeout — never Promise.all.
  const liveSources = countStages("sources", pipeline.sources(), query);
  const sourceBudget = ctx.budgetMs("sources");
  const settledSources = await Promise.allSettled(
    [...liveSources.values()].map((s) =>
      withTimeout(s.source(query, ctx), sourceBudget, `source:${s.name}`),
    ),
  );
  const sourceList = [...liveSources.values()];
  for (let i = 0; i < sourceList.length; i++) {
    const r = settledSources[i];
    const s0 = sourceList[i];
    if (r === undefined || s0 === undefined) continue;
    const name = s0.name;
    if (r.status === "fulfilled") {
      summary.sourceSizes[name] = r.value.length;
      stats.counter("muse.source.size", r.value.length, { source: name });
      for (const c of r.value) {
        const museC = c as unknown as { sourceNames?: string[] };
        if (!museC.sourceNames) museC.sourceNames = [name];
      }
      candidates.push(...r.value);
    } else {
      const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
      summary.sourceErrors[name] = msg;
      if (msg.startsWith("muse.timeout:")) {
        stats.counter("muse.source.timeout", 1, { source: name });
      }
    }
  }
  // dedupe by candidateId, keep first occurrence, merge contributing sourceNames
  const firstByCandidate = new Map<string, C>();
  const deduped: C[] = [];
  for (const c of candidates) {
    const existing = firstByCandidate.get(c.candidateId);
    if (existing === undefined) {
      firstByCandidate.set(c.candidateId, c);
      deduped.push(c);
      continue;
    }
    const from = c as unknown as { sourceNames?: string[] };
    const into = existing as unknown as { sourceNames?: string[] };
    if (from.sourceNames && into.sourceNames) {
      for (const s of from.sourceNames) {
        if (!into.sourceNames.includes(s)) into.sourceNames.push(s);
      }
    }
  }
  candidates = deduped;

  // 3. Hydrators: allSettled on the full batch; length mismatch discards the stage.
  const liveHydrators = countStages("hydrators", pipeline.hydrators(), query);
  await stageMs(
    "hydrators",
    async () => {
      const settled = await Promise.allSettled(
        [...liveHydrators.values()].map((h) =>
          withTimeout(
            h.hydrate(query, candidates, ctx),
            ctx.budgetMs("hydrators"),
            `hydrator:${h.name}`,
          ),
        ),
      );
      const hydList = [...liveHydrators.values()];
      for (let i = 0; i < hydList.length; i++) {
        const r = settled[i];
        const h0 = hydList[i];
        if (r === undefined || h0 === undefined) continue;
        if (r.status === "fulfilled") mergePerCandidate(candidates, r.value, h0.name, stats);
      }
      summary.hydrated = candidates.length;
    },
    ctx,
  );

  // 4. Filters: sequential; each sees only the survivors of the previous.
  const liveFilters = countStages("filters", pipeline.filters(), query);
  for (const f of liveFilters.values()) {
    const { kept, removed: rm } = f.filter(query, candidates);
    candidates = kept;
    removed.push(...rm);
    stats.counter("muse.filter.kept", kept.length, { filter: f.name });
    stats.counter("muse.filter.removed", rm.length, { filter: f.name });
    summary.filterRates[f.name] = rm.length;
  }

  // 5. Scorers: sequential for…of, each reads what the previous wrote.
  const liveScorers = countStages("scorers", pipeline.scorers(), query);
  await stageMs(
    "scorers",
    async () => {
      for (const s of liveScorers.values()) {
        const out = await withTimeout(
          s.score(query, candidates, ctx),
          ctx.budgetMs("scorers"),
          `scorer:${s.name}`,
        );
        mergePerCandidate(candidates, out, s.name, stats);
      }
    },
    ctx,
  );

  // 6. Selector: one select() call.
  const selector = pipeline.selector();
  const { selected, nonSelected } = selector.select(query, candidates, ctx);
  let final = selected;
  const rest = nonSelected;

  // 7. Post-selection hydrators (parallel) then filters (sequential).
  const postHyd = pipeline.postSelectionHydrators?.() ?? [];
  if (postHyd.length > 0) {
    const livePostHyd = countStages("post_selection_hydrators", postHyd, query);
    const settled = await Promise.allSettled(
      [...livePostHyd.values()].map((h) =>
        withTimeout(
          h.hydrate(query, final, ctx),
          ctx.budgetMs("post_selection_hydrators"),
          `postHydrator:${h.name}`,
        ),
      ),
    );
    const list = [...livePostHyd.values()];
    for (let i = 0; i < list.length; i++) {
      const r = settled[i];
      const h0 = list[i];
      if (r === undefined || h0 === undefined) continue;
      if (r.status === "fulfilled") mergePerCandidate(final, r.value, h0.name, stats);
    }
  }
  const postFilters = pipeline.postSelectionFilters?.() ?? [];
  for (const f of postFilters) {
    if (f.enable?.(query) === false) continue;
    const { kept, removed: rm } = f.filter(query, final);
    // the slate can shrink here — dropped rows go to removed, not nonSelected
    final = kept;
    removed.push(...rm);
  }

  // 8. Second truncation: excess moves to nonSelected.
  const size = pipeline.resultSize?.(query, ctx) ?? selector.size(query, ctx);
  if (final.length > size) {
    rest.push(...final.slice(size));
    final = final.slice(0, size);
  }

  summary.selected = final.length;
  summary.finishedAt = Date.now();
  stats.counter("muse.result.size", final.length);
  if (final.length === 0) stats.counter("muse.result.empty", 1);

  // 9. Side effects are a closure — the caller decides when to fire them.
  const sideEffects = pipeline.sideEffects?.() ?? [];
  const runSideEffects = async (): Promise<void> => {
    await Promise.allSettled(
      sideEffects.map((se) =>
        (se.enable?.(query) === false
          ? Promise.resolve()
          : se.run({ query, selected: final, nonSelected: rest, removed, summary }, ctx)
        ).catch((e: unknown) => {
          stats.counter("muse.side_effect.error", 1, { name: se.name });
          throw e;
        }),
      ),
    );
  };

  return {
    query,
    selected: final,
    nonSelected: rest,
    removed,
    summary,
    sideEffects: runSideEffects,
  };
}
