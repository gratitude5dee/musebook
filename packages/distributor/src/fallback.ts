// packages/distributor/src/fallback.ts — §12.3.6/§12.5 step 4.
// The deterministic variant: a thread where threads exist, a truncation plus
// canonical URL where they do not. No model in the loop — build-order step 4
// requires every platform to yield a VALID full-port variant from this alone.
import { countEffective } from "./count";
import type { PlatformConstraint } from "./constraints";
import { splitIntoThread, truncateTo } from "./split";
import type { CandidateMedia, VariantCandidate } from "./validate";

const NUMBERING_RESERVE = 8; // " (12/25)" worst case at maxParts 25 (12.3.6)
const SAFETY_MARGIN = 2; // absorbs a trailing space the platform adds

export interface FallbackInput {
  /** Plain-text rendering of the canonical markdown (markup stripped). */
  readonly plainBody: string;
  readonly canonicalUrl: string;
  readonly media: readonly CandidateMedia[];
}

/** Plain text -> the platform's editor dialect. For `html` the wrap is ONE
 *  <p> block with whitespace collapsed — a fixed 7-char overhead the caller
 *  reserves in the length budget, so dialect conversion can never push a part
 *  over the platform limit. */
function toDialect(text: string, c: PlatformConstraint): string {
  if (c.editor === "html") {
    return `<p>${text.replace(/\s+/g, " ").trim()}</p>`;
  }
  return text;
}

/** Chars the <p>…</p> wrap adds on an html platform; 0 elsewhere. */
function dialectReserve(c: PlatformConstraint): number {
  return c.editor === "html" ? 7 : 0;
}

/**
 * Produce the deterministic variant. Returns a candidate the validator should
 * accept on ordinary inputs: thread-capable platforms get a thread sized by
 * their own ceiling; the rest get a truncation that ends at the canonical URL.
 */
export function deterministicVariant(
  input: FallbackInput,
  c: PlatformConstraint,
): VariantCandidate {
  const urlReserve = c.urlCountsAsChars ?? countEffective(c.countMethod, input.canonicalUrl, null);
  const htmlReserve = dialectReserve(c);
  const budget = c.maxChars - SAFETY_MARGIN - htmlReserve;
  const opts = {
    method: c.countMethod,
    maxChars: budget,
    urlCountsAsChars: c.urlCountsAsChars,
  } as const;

  if (c.supportsThreads) {
    const maxParts = c.maxThreadParts ?? 25;
    const parts = splitIntoThread(input.plainBody, {
      ...opts,
      numberingReserve: NUMBERING_RESERVE,
      urlReserve,
      maxParts,
    });
    if (parts.length === 0) {
      return {
        body: input.canonicalUrl,
        threadParts: [],
        media: input.media,
        title: null,
        canonicalUrl: input.canonicalUrl,
      };
    }
    // Canonical URL rides the LAST part; when the whole text is one part the
    // URL is the body itself (12.3.8: no teaser, always the URL).
    const last = parts[parts.length - 1]!;
    const withUrl = last.includes(input.canonicalUrl)
      ? last
      : truncateTo(last, opts, ` ${input.canonicalUrl}`);
    const emitted = parts.length === 1 ? [withUrl] : [parts[0]!, ...parts.slice(1, -1), withUrl];
    return {
      body: toDialect(emitted[0]!, c),
      threadParts: emitted.slice(1).map((p) => toDialect(p, c)),
      media: input.media,
      title: null,
      canonicalUrl: input.canonicalUrl,
    };
  }

  // No threads: a genuine cut that always ends in the canonical URL.
  const truncated = toDialect(truncateTo(input.plainBody, opts, ` ${input.canonicalUrl}`), c);
  const title =
    c.maxTitleChars !== null
      ? truncateTo(
          input.plainBody.split(/\s+/).slice(0, 8).join(" "),
          { method: c.countMethod, maxChars: c.maxTitleChars, urlCountsAsChars: null },
          "",
        )
      : null;
  return {
    body: truncated,
    threadParts: [],
    media: input.media,
    title,
    canonicalUrl: input.canonicalUrl,
  };
}
