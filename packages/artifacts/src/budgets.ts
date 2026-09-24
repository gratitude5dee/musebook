// packages/artifacts/src/budgets.ts — the numbers of 11.13 and 11.15 as data.
// Pure module: BudgetError + enforceBudget live here (not inside node/ingest-3d)
// so the gate can exercise rejection without pulling @gltf-transform/*, whose
// CLI deps are native and belong behind the src/node/ boundary (11.1).

/** §11.13's 2D caps — every row of the rejection table that is a number. */
export const BUNDLE_CAPS = {
  maxEntryBytes: 256 * 1024,
  maxPosterBytes: 400 * 1024,
  posterMinWidthPx: 600,
  maxBundleBytes: 5 * 1024 * 1024,
  maxBundleGzipBytes: 2 * 1024 * 1024,
  maxFileCount: 64,
  maxFileBytes: 2 * 1024 * 1024,
  maxWasmBytes: 1536 * 1024,
  maxKeyBytes: 1024,
} as const;

/** §11.13's extension allowlist, verbatim. */
export const ALLOWED_EXTENSIONS = new Set([
  '.html', '.css', '.js', '.mjs', '.json', '.wasm', '.png', '.jpg', '.jpeg',
  '.webp', '.avif', '.svg', '.gif', '.woff2', '.glb', '.ktx2', '.bin', '.txt', '.md',
]);

export type BudgetTier = 'feed' | 'fullscreen' | 'mobile';

export interface TierBudget {
  readonly maxFileBytes: number;
  readonly maxTriangles: number;
  readonly maxTextureBytes: number;   // GPU bytes
  readonly maxDrawCalls: number;
}

/** §11.15's budget table, byte for byte. */
export const BUDGETS: Record<BudgetTier, TierBudget> = {
  feed:       { maxFileBytes: 2_500_000,  maxTriangles: 150_000, maxTextureBytes: 8_388_608,  maxDrawCalls: 60 },
  fullscreen: { maxFileBytes: 12_582_912, maxTriangles: 600_000, maxTextureBytes: 33_554_432, maxDrawCalls: 200 },
  mobile:     { maxFileBytes: 1_572_864,  maxTriangles: 60_000,  maxTextureBytes: 4_194_304,  maxDrawCalls: 40 },
} as const;

export type BudgetRejectionCode =
  | 'glb_too_large'
  | 'too_many_triangles'
  | 'textures_too_large'
  | 'too_many_draw_calls';

export class BudgetError extends Error {
  readonly code: BudgetRejectionCode;
  readonly measured: number;
  readonly limit: number;
  constructor(code: BudgetRejectionCode, measured: number, limit: number) {
    super(`${code}: ${measured} > ${limit}`);
    this.name = 'BudgetError';
    this.code = code;
    this.measured = measured;
    this.limit = limit;
  }
}

export interface SceneMetrics {
  readonly triangles: number;
  readonly textureBytes: number;
  readonly drawCallEstimate: number;
  readonly fileBytes: number;
}

/** §11.15 verbatim — throws on the FIRST breach, with the number and the limit. */
export function enforceBudget(tier: BudgetTier, m: SceneMetrics): void {
  const b = BUDGETS[tier];
  if (m.fileBytes > b.maxFileBytes) throw new BudgetError('glb_too_large', m.fileBytes, b.maxFileBytes);
  if (m.triangles > b.maxTriangles) throw new BudgetError('too_many_triangles', m.triangles, b.maxTriangles);
  if (m.textureBytes > b.maxTextureBytes) throw new BudgetError('textures_too_large', m.textureBytes, b.maxTextureBytes);
  if (m.drawCallEstimate > b.maxDrawCalls) throw new BudgetError('too_many_draw_calls', m.drawCallEstimate, b.maxDrawCalls);
}
