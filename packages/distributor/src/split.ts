// packages/distributor/src/split.ts — §12.3.6 verbatim.
// Two deterministic operations, used by the fallback stage and the UI.
import { countEffective, type CountMethod } from "./count";

const sentenceSegmenter = new Intl.Segmenter("en", { granularity: "sentence" });
const wordSegmenter = new Intl.Segmenter("en", { granularity: "word" });
const graphemeSegmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

export interface SplitOptions {
  readonly method: CountMethod;
  readonly maxChars: number;
  readonly urlCountsAsChars: number | null;
  /** Budget reserved on EVERY part for the " (i/n)" suffix. */
  readonly numberingReserve: number;
  /** Budget reserved on the LAST part for the canonical URL. */
  readonly urlReserve: number;
  readonly maxParts: number;
}

/**
 * Split on sentence boundaries, falling back to word boundaries for a sentence
 * that is itself over budget. Never splits inside a grapheme cluster, because
 * every boundary comes from Intl.Segmenter.
 */
export function splitIntoThread(text: string, o: SplitOptions): string[] {
  const budget = o.maxChars - o.numberingReserve;
  const parts: string[] = [];
  let current = "";

  const flush = (): void => {
    if (current.trim().length > 0) parts.push(current.trim());
    current = "";
  };

  for (const { segment } of sentenceSegmenter.segment(text)) {
    const candidate = current + segment;
    if (countEffective(o.method, candidate, o.urlCountsAsChars) <= budget) {
      current = candidate;
      continue;
    }
    flush();
    if (countEffective(o.method, segment, o.urlCountsAsChars) <= budget) {
      current = segment;
      continue;
    }
    // One sentence is over budget on its own: fall back to words.
    let chunk = "";
    for (const w of wordSegmenter.segment(segment)) {
      const next = chunk + w.segment;
      if (countEffective(o.method, next, o.urlCountsAsChars) <= budget) {
        chunk = next;
        continue;
      }
      if (chunk.trim().length > 0) parts.push(chunk.trim());
      if (countEffective(o.method, w.segment, o.urlCountsAsChars) > budget) {
        // A single word over budget: hard-cut at grapheme boundaries —
        // the last resort that keeps every emitted part within the limit.
        let piece = "";
        for (const g of graphemeSegmenter.segment(w.segment)) {
          const pn = piece + g.segment;
          if (countEffective(o.method, pn, o.urlCountsAsChars) <= budget) {
            piece = pn;
          } else {
            if (piece.trim().length > 0) parts.push(piece.trim());
            piece = g.segment;
          }
        }
        chunk = piece;
      } else {
        chunk = w.segment;
      }
    }
    current = chunk;
  }
  flush();

  const capped = parts.slice(0, o.maxParts);
  const n = capped.length;
  return capped.map((part, i) => (n === 1 ? part : `${part} (${i + 1}/${n})`));
}

/** Truncate at a word boundary, leaving room for a suffix. */
export function truncateTo(
  text: string,
  o: Pick<SplitOptions, "method" | "maxChars" | "urlCountsAsChars">,
  suffix: string,
): string {
  const budget = o.maxChars - countEffective(o.method, suffix, o.urlCountsAsChars);
  if (countEffective(o.method, text, o.urlCountsAsChars) <= budget) {
    return text + suffix;
  }
  let acc = "";
  for (const w of wordSegmenter.segment(text)) {
    const next = acc + w.segment;
    if (countEffective(o.method, next, o.urlCountsAsChars) > budget - 1) break;
    acc = next;
  }
  return `${acc.trimEnd()}…${suffix}`;
}
