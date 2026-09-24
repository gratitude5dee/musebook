// packages/ui/src/webglBudget.ts — §11.16's context budget.
export const MAX_LIVE_CONTEXTS = 2;
const live = new Set<string>();
const listeners = new Set<() => void>();

export function acquireWebglSlot(id: string): boolean {
  if (live.has(id)) return true;
  if (live.size >= MAX_LIVE_CONTEXTS) return false;
  live.add(id);
  return true;
}

export function releaseWebglSlot(id: string): void {
  if (live.delete(id)) listeners.forEach((fn) => fn());
}

/** Test + pager seam: runs the next time any slot frees. */
export function onWebglSlotFreed(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Defence in depth: if a context is lost anyway, fall back to the poster. */
export function attachContextLossGuard(canvas: HTMLCanvasElement, onLost: () => void): () => void {
  const handler = (event: Event) => {
    event.preventDefault(); // allows a later restore
    onLost();
  };
  canvas.addEventListener("webglcontextlost", handler);
  return () => canvas.removeEventListener("webglcontextlost", handler);
}
