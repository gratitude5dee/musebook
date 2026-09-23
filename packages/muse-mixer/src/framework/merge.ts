import { SKIP, type PerCandidate, type PipelineCandidate, type StatsSink } from "./types.js";

export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`muse.timeout:${label}:${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

export function mergePerCandidate<C extends PipelineCandidate>(
  target: C[],
  results: ReadonlyArray<PerCandidate<C>>,
  stage: string,
  stats: StatsSink,
): void {
  if (results.length !== target.length) {
    stats.counter("muse.stage.length_mismatch", 1, { stage });
    return; // discard the whole stage: upstream turns a length mismatch into Err for all results
  }
  for (let i = 0; i < target.length; i++) {
    const r = results[i];
    if (r === SKIP) {
      stats.counter("muse.stage.skip", 1, { stage });
      continue;
    }
    Object.assign(target[i] as object, r);
  }
}
