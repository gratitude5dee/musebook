// packages/distributor/src/count.ts — §12.3.2 verbatim.
// Original code written from the published facts, not copied.
import twitterText from "twitter-text"; // twitter-text@3.1.0, Apache-2.0
// The package's ESM build (dist/esm, picked on workerd) exports ONLY a default
// object — destructure instead of a named import, which is undefined there.
const { parseTweet } = twitterText;

export type CountMethod = "utf16" | "utf8_bytes" | "graphemes" | "x_weighted";

const utf8 = new TextEncoder();
const graphemeSegmenter = new Intl.Segmenter("und", { granularity: "grapheme" });

/** Number of extended grapheme clusters. */
export function countGraphemes(text: string): number {
  return Array.from(graphemeSegmenter.segment(text)).length;
}

export function countLength(method: CountMethod, text: string): number {
  switch (method) {
    case "x_weighted":
      // URLs weigh 23 regardless of real length; CJK weighs 2.
      return parseTweet(text).weightedLength;
    case "utf8_bytes":
      return utf8.encode(text).length;
    case "graphemes":
      return countGraphemes(text);
    case "utf16":
      return text.length;
  }
}

/**
 * Effective length once the platform's URL placeholder rule is applied.
 * Mastodon replaces every URL with 23 characters; X does it inside
 * parseTweet already, so urlCountsAsChars must be null for x.
 */
const URL_RE = /https?:\/\/[^\s<>"']+/g;

export function countEffective(
  method: CountMethod,
  text: string,
  urlCountsAsChars: number | null,
): number {
  if (urlCountsAsChars === null || method === "x_weighted") {
    return countLength(method, text);
  }
  const placeholder = "x".repeat(urlCountsAsChars);
  return countLength(method, text.replace(URL_RE, placeholder));
}
