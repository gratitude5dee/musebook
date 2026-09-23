// packages/muse-mixer/src/muse/rng.ts
// Seeded PRNG for the slate pass — splitmix32 over hash(slateId). The replay
// harness and any rebuild must reproduce the same slate exactly; Math.random()
// and crypto.getRandomValues are deliberately not used (§9.14).

/** FNV-1a 32-bit of an arbitrary string — the slate seed's hash input. */
export function fnv1a32(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** splitmix32: small, counter-based, fully deterministic. */
export function splitmix32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    z = (z ^ (z >>> 16)) >>> 0;
    return z / 0x100000000;
  };
}

/** The PRNG a pass uses: seeded from slateId, same for every scorer in the pass. */
export function slateRng(slateId: string): () => number {
  return splitmix32(fnv1a32(slateId));
}
