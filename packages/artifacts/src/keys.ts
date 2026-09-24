// packages/artifacts/src/keys.ts — a/{visibility}/{version}/{path} (§11.12).
import { z } from 'zod';

export const artifactVisibilitySchema = z.enum(['public', 'private']);
export type ArtifactVisibility = z.infer<typeof artifactVisibilitySchema>;

export const VERSION_RE = /^[0-9a-f]{16}$/;

/** The R2 key inside musebook-artifacts. A KEY, never a URL: the route picks
 *  which prefix by route shape — /a/ → 'public', /t/{ticket}/ → 'private'. */
export function artifactKey(visibility: ArtifactVisibility, version: string, path: string): string {
  if (!VERSION_RE.test(version)) throw new Error(`bad artifact version: ${version}`);
  if (path.startsWith('/') || path.includes('..') || path.includes('\\')) {
    throw new Error(`bad artifact path: ${path}`);
  }
  const key = `a/${visibility}/${version}/${path}`;
  if (key.length > 1024) throw new Error('path_too_long'); // R2's hard limit (11.13)
  return key;
}

/** Parse a served path suffix after {version}/: 'index.html', 'app.js', ... */
export function parseArtifactPath(suffix: string): string {
  if (suffix.length === 0 || suffix.startsWith('/') || suffix.includes('..') || suffix.includes('\\')) {
    throw new Error('path_traversal');
  }
  return suffix;
}
