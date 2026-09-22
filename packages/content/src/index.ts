// packages/content/src/index.ts — @musebook/content (§3.5, M4).
//
// Public surface, per §10.15.3 / §14.4.3 call sites:
//   canonicalMarkdown · contentHash           — canonicalisation + sha256
//   produce, CONTENT_TYPES, type BodyKind     — the six §6.6 producers
//   frontMatter                               — the `.md` twin's YAML block
//   markdownToHtml                            — composer live preview path
//   jsonLdBase, fragmentFor, spdxUrl          — decision-neutral JSON-LD
//   sha256Hex                                 — the sync hasher
export { canonicalMarkdown } from "./canonicalize";
export { contentHash } from "./hash";
export { sha256Hex } from "./sha256";
export { frontMatter } from "./frontmatter";
export { markdownToHtml } from "./markdown-html";
export { jsonLdBase, fragmentFor, spdxUrl } from "./jsonld";
export { produce, CONTENT_TYPES, type BodyKind } from "./representations";
