// packages/kernel/test/etag.test.ts — per-representation ETag shape (§6.13).
import { describe, expect, it } from "vitest";
import { etagFor } from "../src/headers.js";
import { FREE } from "./fixtures/resources.js";

const REPS = ["html", "markdown", "json", "jsonld", "mcp", "feed"] as const;
const SHAPE = /^W\/"sha256-[0-9a-f]{16}-(html|markdown|json|jsonld|mcp|feed)"$/;

describe("etagFor", () => {
  it('matches W/"sha256-<16 hex>-<as>" for all six representations', () => {
    for (const rep of REPS) {
      expect(etagFor(FREE, rep)).toMatch(SHAPE);
    }
  });

  it("the hash part is identical across representations; the value differs", () => {
    const etags = REPS.map((rep) => etagFor(FREE, rep));
    const hashPart = etags.map((e) => e.slice(9, 25));
    expect(new Set(hashPart).size).toBe(1);
    expect(new Set(etags).size).toBe(6);
  });
});
