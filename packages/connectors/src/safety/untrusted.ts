// packages/connectors/src/safety/untrusted.ts — §10.9.1 rules 2-3
// Zero-width and bidirectional-override characters are the standard carrier for
// instructions invisible to a human reviewer and perfectly visible to a model.
// The invisible set: ZWSP ZWNJ ZWJ WORD JOINER + LRM/RLM/LRE/RLE/PDF/RLO/LRO +
// ANI/RLI/FSI/PDI + BOM/ZWNBSP.
// eslint-disable-next-line no-irregular-whitespace -- the invisible codepoints ARE the rule
const INVISIBLE = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]/gu;

export function sanitizeAgentText(raw: string, maxLen = 20_000): string {
  const normalized = raw.normalize("NFKC").replace(INVISIBLE, "");
  // Control characters except tab and newline.
  // eslint-disable-next-line no-control-regex -- stripping control codepoints is the point
  const stripped = normalized.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  return stripped.slice(0, maxLen);
}

export function wrapUntrusted(
  text: string,
  meta: { source: string; connector?: string; delegation?: string },
): string {
  const attrs = [
    `source="${escapeAttr(meta.source)}"`,
    ...(meta.connector ? [`connector="${escapeAttr(meta.connector)}"`] : []),
    ...(meta.delegation ? [`delegation="${escapeAttr(meta.delegation)}"`] : []),
  ].join(" ");
  return `<untrusted-content ${attrs}>\n${text}\n</untrusted-content>`;
}

function escapeAttr(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
