// packages/telemetry/src/sample.ts — §13.4.6, verbatim.
/** FNV-1a 32-bit. Deterministic across isolates, regions and deploys — which a
 *  Math.random() gate would not be, and which is the whole requirement. */
export function sessionHash(viewSessionId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < viewSessionId.length; i++) {
    h ^= viewSessionId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

export function inLabelSample(viewSessionId: string, rate: number): boolean {
  if (rate >= 1) return true;
  if (rate <= 0) return false;
  return sessionHash(viewSessionId) % 10_000 < Math.round(rate * 10_000);
}
