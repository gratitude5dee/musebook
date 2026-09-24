// packages/artifacts/src/manifest.ts
import { z } from 'zod';

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const relPath = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-z0-9][a-z0-9._/-]*$/i, 'lowercase-ish relative path')
  .refine((p) => !p.startsWith('/') && !p.includes('..'), 'must be relative, no traversal');

/**
 * The two artifact kinds are two of section 4.2's `post_kind` values, used directly:
 * 'app' (2D, iframe-sandboxed bundle) and 'model3d' (glTF). The `artifacts.kind`
 * column (section 4.4) records the bundle FORMAT — 'html_bundle' / 'react_app'
 * for 'app', 'glb' for 'model3d' — and is set by ingest, not by the manifest.
 */
export const artifactKind = z.enum(['app','model3d']);
export type ArtifactKind = z.infer<typeof artifactKind>;

/** Exactly section 4.4's posts_license_spdx_allowed set. One enum, one column. */
export const licenseSpdx = z.enum([
  'CC0-1.0', 'CC-BY-4.0', 'CC-BY-SA-4.0', 'CC-BY-NC-4.0', 'CC-BY-ND-4.0', 'ARR', 'MIT', 'Apache-2.0',
]);

export const artifactManifestSchema = z
  .object({
    manifestVersion: z.literal('2026-09-01'),
    kind: artifactKind,
    title: z.string().min(1).max(120),
    description: z.string().max(600),
    /** app only. */
    entry: relPath.default('index.html'),
    /** model3d only: the desktop-tier scene. */
    scene: relPath.optional(),
    /** model3d only: the reduced-triangle scene served to the feed and to mobile. */
    sceneLod1: relPath.optional(),
    /** REQUIRED for every kind. No poster, no publish. */
    poster: relPath,
    aspectRatio: z.enum(['16:9', '1:1', '4:3', '9:16']),
    interactive: z.boolean(),
    /** Written to posts.license_spdx at publish (section 4.4). */
    license: licenseSpdx,
    remixAllowed: z.boolean(),
    author: z.object({
      kind: z.enum(['human', 'agent']),
      connectorId: z.string().max(40).nullable(),
      delegationId: z.uuid().nullable(),
      humanWallet: z.string().regex(/^0x[0-9a-f]{40}$/),
    }),
    generation: z
      .object({
        model: z.string().max(120),
        promptSha256: sha256Hex,
        toolsUsed: z.array(z.string().max(60)).max(20),
      })
      .nullable(),
    forkOf: z
      .object({ artifactId: z.uuid(), version: z.string().regex(/^[0-9a-f]{16}$/) })
      .nullable(),
    /** Subset of an allowlist; anything else is rejected, not ignored. */
    capabilitiesRequested: z
      .array(z.enum(['pointerlock', 'fullscreen', 'autoplay', 'xr']))
      .max(4)
      .default([]),
    integrity: z.object({
      algorithm: z.literal('sha256'),
      files: z.record(relPath, sha256Hex),
    }),
  })
  .refine((m) => m.kind !== 'model3d' || !!m.scene, { message: 'model3d artifacts must declare scene' })
  .refine((m) => m.kind !== 'app' || !!m.entry, { message: 'app artifacts need entry' });

export type ArtifactManifest = z.infer<typeof artifactManifestSchema>;
