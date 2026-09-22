// packages/kernel/src/render/preview.ts — plan.md §6.6, verbatim.

const PAYWALL_SENTINEL = "<!-- musebook:paywall -->";

/**
 * Deterministic teaser. Takes whole markdown blocks in order until adding the next
 * block would exceed `maxChars`, always returns at least the first block, and never
 * splits a fenced code block. Pure: same input -> same bytes, forever.
 */
export function previewOf(canonicalMarkdown: string, maxChars: number): string {
  const body = stripFrontMatter(canonicalMarkdown);
  const blocks = splitBlocks(body);
  if (blocks.length === 0) return "";

  const taken: string[] = [blocks[0]!];
  let used = blocks[0]!.length;

  for (let i = 1; i < blocks.length; i += 1) {
    const next = blocks[i]!;
    if (used + 2 + next.length > maxChars) break;
    taken.push(next);
    used += 2 + next.length;
  }
  return `${taken.join("\n\n")}\n\n${PAYWALL_SENTINEL}`;
}

function stripFrontMatter(md: string): string {
  if (!md.startsWith("---\n")) return md;
  const end = md.indexOf("\n---\n", 4);
  return end === -1 ? md : md.slice(end + 5);
}

/** Splits on blank lines, but treats a ```-fenced region as one indivisible block. */
function splitBlocks(md: string): string[] {
  const lines = md.split("\n");
  const blocks: string[] = [];
  let current: string[] = [];
  let fenced = false;

  const flush = (): void => {
    const joined = current.join("\n").trim();
    if (joined.length > 0) blocks.push(joined);
    current = [];
  };

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      current.push(line);
      if (!fenced) flush();
      continue;
    }
    if (!fenced && line.trim() === "") {
      flush();
      continue;
    }
    current.push(line);
  }
  flush();
  return blocks;
}
