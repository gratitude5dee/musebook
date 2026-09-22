// hash-stability.test.ts — GATE M4 check 1: a property test generating
// ≥1,000 whitespace-equivalent inputs — trailing spaces, CRLF vs LF, a
// trailing newline, nested-list indentation — must ALL produce the
// identical content_hash.
//
// Each case takes a canonical source line-set and rewrites ONLY
// whitespace-level bytes: per-line trailing space runs, per-line LF vs
// CRLF, trailing blank lines, and re-indents of list markers to any width
// that keeps the same ordinal depth (canonical form maps indent widths to
// ordinals, so 2, 4, or 6 spaces for the same nesting level are equivalent).
// Body characters are never touched — sensitivity is a separate property.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { canonicalMarkdown } from "../src/canonicalize.js";
import { contentHash } from "../src/hash.js";
import { MARKDOWN } from "./fixture.js";

const ITEM = /^( *)([-*+]|\d{1,9}[.)])([ \t]+)(.*)$/;

/** A markdown-ish body generator that always produces structure the
 * whitespace chaos can play with: headings, paragraphs, lists (nested two
 * levels), a fenced block, blockquotes and ordered lists. */
const docArb = fc
  .array(
    fc.oneof(
      fc.constantFrom("# H\n", "## Sub\n"),
      fc
        .tuple(
          fc.array(fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9 ,.]{2,60}$/), {
            minLength: 1,
            maxLength: 4,
          }),
        )
        .map(([ls]) => `${ls.join("\n")}\n`),
      fc
        .array(fc.stringMatching(/^[a-z][a-z0-9 -]{2,30}$/), { minLength: 2, maxLength: 4 })
        .map((items) => items.map((t) => `- ${t}\n`).join("")),
      fc
        .tuple(
          fc.array(fc.stringMatching(/^[a-z][a-z0-9 -]{2,30}$/), {
            minLength: 1,
            maxLength: 3,
          }),
          fc.array(fc.stringMatching(/^[a-z][a-z0-9 -]{2,30}$/), {
            minLength: 1,
            maxLength: 3,
          }),
        )
        .map(
          ([top, nested]) =>
            top.map((t) => `- ${t}\n`).join("") + nested.map((t) => `  - ${t}\n`).join(""),
        ),
      fc.constantFrom("```\ncode line\n- not a list\n```\n"),
      fc
        .array(fc.stringMatching(/^[a-z][a-z0-9 ,]{2,40}$/), { minLength: 1, maxLength: 3 })
        .map((ls) => ls.map((t) => `> ${t}\n`).join("")),
      fc
        .array(fc.stringMatching(/^[a-z][a-z0-9 -]{2,30}$/), { minLength: 2, maxLength: 4 })
        .map((items) => items.map((t, i) => `${i + 1}. ${t}\n`).join("")),
    ),
    { minLength: 2, maxLength: 8 },
  )
  .map((blocks) => blocks.join("\n"));

/** Whitespace chaos: trailing spaces per line, LF↔CRLF per line, trailing
 * blank lines, and a uniform re-indent of every non-zero-indent marker by
 * the SAME per-run delta — the canonical form maps indent widths to depth
 * ordinals, so shifting every nested marker by one constant preserves the
 * ordinal stack; per-line shifts would change nesting, not whitespace.
 * Never alters a non-whitespace byte. */
function chaos(doc: string, rng: () => number): string {
  const pick = (n: number) => Math.floor(rng() * n);
  const indentDelta = 1 + pick(8);
  const lines = doc.split("\n");
  const out = lines.map((line) => {
    let l = line;
    const m = ITEM.exec(l);
    if (m !== null && m[1]!.length > 0) {
      l = `${" ".repeat(m[1]!.length + indentDelta)}${m[2]!} ${m[4]!}`;
    }
    if (pick(4) > 0) l += " ".repeat(pick(9));
    return l;
  });
  const sep = pick(3) === 0 ? "\n" : pick(2) === 0 ? "\r\n" : "";
  let joined = sep === "" ? out.map((l) => l + (pick(2) ? "\n" : "\r\n")).join("") : out.join(sep);
  joined += "\n".repeat(pick(7));
  return joined;
}

describe("content hash stability (GATE M4.1)", () => {
  it("≥1,000 whitespace-equivalent inputs hash identically", () => {
    let cases = 0;
    fc.assert(
      fc.property(
        docArb,
        fc.integer({ min: 0, max: 2 ** 30 }),
        fc.integer({ min: 20, max: 44 }),
        (doc, seed, variants) => {
          const expected = contentHash(doc);
          for (let v = 0; v < variants; v += 1) {
            let x = seed + v;
            const rng = () => {
              x = (x * 9301 + 49297) % 233280;
              return x / 233280;
            };
            const mutated = chaos(doc, rng);
            cases += 1;
            if (
              contentHash(mutated) !== expected ||
              canonicalMarkdown(mutated) !== canonicalMarkdown(doc)
            ) {
              return false;
            }
          }
          return true;
        },
      ),
      { numRuns: 60, seed: 20260922 },
    );
    expect(cases).toBeGreaterThanOrEqual(1000);
  });

  it("the gate's own fixture body hashes stably across the whitespace family", () => {
    const expected = contentHash(MARKDOWN);
    const variants = [
      MARKDOWN.replace(/\n/g, "\r\n"),
      MARKDOWN.split("\n")
        .map((l) => `${l}   `)
        .join("\n"),
      `${MARKDOWN}\n\n\n\n\n`,
      MARKDOWN.replace("  - nested a", "      - nested a").replace(
        "  - nested b",
        "      - nested b",
      ),
      MARKDOWN.replace("  - nested a", "    - nested a").replace("  - nested b", "    - nested b"),
    ];
    for (const v of variants) expect(contentHash(v)).toBe(expected);
  });
});
