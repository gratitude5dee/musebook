// packages/content/src/hash.ts — content_hash, spine invariant 1.
//
// `content_hash = sha256(canonical markdown)`. `contentHash` canonicalises
// internally so callers may pass raw editor text or an already-canonical
// body — canonicalise is idempotent, so the hash is identical either way.
import { canonicalMarkdown } from "./canonicalize";
import { sha256Hex } from "./sha256";

export function contentHash(input: string): string {
  return sha256Hex(canonicalMarkdown(input));
}
