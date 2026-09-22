// packages/content/src/canonicalize.ts — the canonical markdown producer.
//
// `content_hash = sha256(canonical markdown)` is spine invariant 1, so this
// function defines which byte differences are editorial and which are
// cosmetic. The canonical form normalises, in order:
//
//   1. Line endings: CRLF and lone CR become LF.
//   2. Trailing whitespace: every line loses trailing spaces/tabs.
//   3. Trailing blank lines at end of document are dropped; a non-empty
//      document ends in exactly one `\n`.
//   4. List-item indentation: outside fenced code, a `[-*+]` or `N.` / `N)`
//      marker's leading whitespace is rewritten to two spaces per nesting
//      level, where the level is the ordinal of its indent width inside the
//      active list (an indent-stack — 2, 4 or 6 spaces all map to level 1).
//      The whitespace after the marker collapses to one space.
//
// Guards that keep the transform semantics-preserving under CommonMark:
// a line with 4+ leading spaces at the top level is indented code, not a
// list item, so it is only treated as a marker line when a list is already
// open; and fenced ```/~~~ regions pass through untouched (a `- x` inside a
// fence is literal text).
//
// Idempotent by construction: canonicalMarkdown(canonicalMarkdown(x))
// === canonicalMarkdown(x). The gate's whitespace-equivalent family —
// trailing spaces, CRLF vs LF, a trailing newline, nested-list indentation —
// collapses to one hash; a one-character body change must not (M4 checks 1–2).

const LIST_MARKER = /^( *)([-*+]|\d{1,9}[.)])([ \t]+)(.*)$/u;
const FENCE = /^ {0,3}(```|~~~)/u;

export function canonicalMarkdown(input: string): string {
  const unified = input.replace(/\r\n?/g, "\n");
  const lines = unified.split("\n").map((l) => l.replace(/[ \t]+$/u, ""));
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const indentStack: number[] = [];
  let fenced = false;
  const out: string[] = [];

  for (const line of lines) {
    if (FENCE.test(line)) {
      fenced = !fenced;
      indentStack.length = 0;
      out.push(line);
      continue;
    }
    if (fenced || line === "") {
      out.push(line);
      continue;
    }
    const m = LIST_MARKER.exec(line);
    if (m !== null && (indentStack.length > 0 || m[1]!.length < 4)) {
      const indent = m[1]!.length;
      while (indentStack.length > 0 && indent < indentStack[indentStack.length - 1]!) {
        indentStack.pop();
      }
      if (indentStack.length === 0 || indent > indentStack[indentStack.length - 1]!) {
        indentStack.push(indent);
      }
      const depth = indentStack.length - 1;
      out.push(`${"  ".repeat(depth)}${m[2]!}${m[4] === "" ? "" : ` ${m[4]}`}`);
      continue;
    }
    if (!line.startsWith(" ") && !line.startsWith("\t")) indentStack.length = 0;
    out.push(line);
  }

  return out.length === 0 ? "" : `${out.join("\n")}\n`;
}
