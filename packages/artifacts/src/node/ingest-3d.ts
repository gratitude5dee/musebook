// packages/artifacts/src/node/ingest-3d.ts — apps/web ONLY (11.1).
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { inspect } from '@gltf-transform/functions';
import { stat } from 'node:fs/promises';
import { BUDGETS, BudgetError, enforceBudget, type BudgetTier, type SceneMetrics } from '../budgets';

export { BUDGETS, BudgetError, enforceBudget, type BudgetTier, type SceneMetrics };

export async function measure(glbPath: string): Promise<SceneMetrics> {
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const doc = await io.read(glbPath);
  const report = inspect(doc);

  const triangles = report.meshes.properties.reduce(
    (sum, m) => sum + m.glPrimitives * Math.max(1, m.instances),
    0,
  );
  const textureBytes = report.textures.properties.reduce(
    (sum, t) => sum + (t.gpuSize ?? t.size),
    0,
  );
  // Draw calls are not directly reported. Primitives x material instances is a
  // deliberate OVER-estimate: rejecting a borderline scene is cheaper than
  // shipping one that stutters on a mid-range phone.
  const drawCallEstimate = report.meshes.properties.reduce(
    (sum, m) => sum + m.meshPrimitives * Math.max(1, m.instances),
    0,
  );
  return { triangles, textureBytes, drawCallEstimate, fileBytes: (await stat(glbPath)).size };
}
