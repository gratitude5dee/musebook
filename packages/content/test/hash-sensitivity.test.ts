// hash-sensitivity.test.ts — GATE M4 check 2: a one-character body change
// must produce a different hash.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { canonicalMarkdown } from "../src/canonicalize.js";
import { contentHash } from "../src/hash.js";

const docArb = fc.array(fc.string({ minLength: 1, maxLength: 80 }), {
  minLength: 1,
  maxLength: 12,
});

describe("content hash sensitivity (GATE M4.2)", () => {
  it("changing one body character changes the hash", () => {
    fc.assert(
      fc.property(docArb, fc.integer({ min: 0, max: 2 ** 30 }), (lines, pick) => {
        const doc = lines.map((l) => `${l}\n`).join("\n");
        const chars = [...doc];
        // Land on a non-whitespace body character so the mutation is
        // editorial, not cosmetic.
        const positions = chars.map((c, i) => (/\S/.test(c) ? i : -1)).filter((i) => i !== -1);
        if (positions.length === 0) return true;
        const target = positions[pick % positions.length]!;
        chars[target] = chars[target] === "z" ? "y" : "z";
        const mutated = chars.join("");
        return (
          mutated !== doc &&
          canonicalMarkdown(mutated) !== canonicalMarkdown(doc) &&
          contentHash(mutated) !== contentHash(doc)
        );
      }),
      { numRuns: 300, seed: 20260922 },
    );
  });
});
