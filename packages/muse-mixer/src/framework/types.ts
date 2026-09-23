import type { DbHandles } from "./ports.js";
import type { PipelineSummary } from "./summary.js";

export interface PipelineQuery {
  readonly requestId: string;
}
export interface PipelineCandidate {
  readonly candidateId: string;
}

/** Per-candidate "no update from this stage". Never an exception, never a drop. */
export const SKIP: unique symbol = Symbol("muse.skip");
export type PerCandidate<C> = Partial<C> | typeof SKIP;

export interface StatsSink {
  counter(name: string, value: number, tags?: Record<string, string>): void;
  timing(name: string, ms: number, tags?: Record<string, string>): void;
}

/**
 * A best-effort memo. The Workers implementation is a per-ISOLATE Map with TTLs —
 * NOT Workers KV. There is no KV namespace for the mixer in §3.6.1's bindings and
 * this section does not ask for one: the isolate is shared across invocations, so a
 * batch of slate builds does hit it, and a miss costs one query. Nothing in the
 * pipeline may treat a miss as an answer.
 */
export interface KvCache {
  getMany(keys: readonly string[]): Promise<ReadonlyArray<string | undefined>>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
}

export interface ParamStore {
  num(name: string, fallback: number): number;
  bool(name: string, fallback: boolean): boolean;
  str(name: string, fallback: string): string;
}

export interface ExecCtx {
  readonly now: number;
  /**
   * Epoch ms at which this pass must be finished. There is NO wall-clock limit on
   * an HTTP-triggered Worker and no getDeadline() to ask — only CPU is capped — so
   * the deadline is a number the adapter sets, not one the platform hands us:
   * `now + params.num('MixerPassBudgetMs', 20000)`, further clamped by the caller
   * (a Queue consumer has a hard 15-minute wall clock; the hourly Cron has 15
   * minutes of CPU).
   */
  readonly deadline: number;
  readonly params: ParamStore;
  readonly stats: StatsSink;
  readonly cache: KvCache;
  readonly db: DbHandles;
  /** ms budget for a named stage, already clamped by `deadline`. */
  budgetMs(stage: string): number;
}

export interface Source<Q extends PipelineQuery, C extends PipelineCandidate> {
  readonly name: string;
  enable?(query: Q): boolean;
  /** PARALLEL. A rejection or timeout yields zero candidates; the pipeline continues. */
  source(query: Q, ctx: ExecCtx): Promise<C[]>;
}

export interface QueryHydrator<Q extends PipelineQuery> {
  readonly name: string;
  enable?(query: Q): boolean;
  /** Returns ONLY its own fields. `Partial<Q>` makes upstream's convention a type error to break. */
  hydrate(query: Q, ctx: ExecCtx): Promise<Partial<Q>>;
  /** Replaces upstream's fixed two-pass split with a real DAG. */
  readonly dependsOn?: readonly string[];
}

export interface Hydrator<Q extends PipelineQuery, C extends PipelineCandidate> {
  readonly name: string;
  enable?(query: Q): boolean;
  /** PARALLEL. INVARIANT: result.length === candidates.length, same order. */
  hydrate(query: Q, candidates: readonly C[], ctx: ExecCtx): Promise<Array<PerCandidate<C>>>;
}

export interface FilterResult<C> {
  kept: C[];
  removed: Array<{ candidate: C; reason: string }>;
}
export interface Filter<Q extends PipelineQuery, C extends PipelineCandidate> {
  readonly name: string;
  enable?(query: Q): boolean;
  /** SYNCHRONOUS and SEQUENTIAL: each filter sees only the survivors of the previous one. */
  filter(query: Q, candidates: C[]): FilterResult<C>;
}

export interface Scorer<Q extends PipelineQuery, C extends PipelineCandidate> {
  readonly name: string;
  enable?(query: Q): boolean;
  /** SEQUENTIAL. Same length/order contract as Hydrator. MUST NOT drop or reorder. */
  score(query: Q, candidates: readonly C[], ctx: ExecCtx): Promise<Array<PerCandidate<C>>>;
}

export interface SelectResult<C> {
  selected: C[];
  nonSelected: C[];
}
export interface Selector<Q extends PipelineQuery, C extends PipelineCandidate> {
  readonly name: string;
  scoreOf(c: C): number;
  size(query: Q, ctx: ExecCtx): number;
  select(query: Q, candidates: C[], ctx: ExecCtx): SelectResult<C>;
}

export interface SideEffectInput<Q, C> {
  query: Q;
  selected: C[];
  nonSelected: C[];
  removed: Array<{ candidate: C; reason: string }>;
  summary: PipelineSummary;
}
export interface SideEffect<Q extends PipelineQuery, C extends PipelineCandidate> {
  readonly name: string;
  enable?(query: Q): boolean;
  /** Fired after the slate is written. Failures are swallowed by the executor and counted. */
  run(input: SideEffectInput<Q, C>, ctx: ExecCtx): Promise<void>;
}
