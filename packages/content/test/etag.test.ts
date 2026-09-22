// etag.test.ts — GATE M4 check 4: the ETag format the §6.6 kernel
// (`etagFor`, M5) will stamp is pinned HERE, per representation:
//   W/"sha256-<first 16 lowercase hex of contentHash>-<as>"
import { describe, expect, it } from "vitest";
import { representationSchema } from "@musebook/schema";
import { contentHash } from "../src/hash.js";
import { MARKDOWN } from "./fixture.js";

function etagFor(hash: string, as: string): string {
  return `W/"sha256-${hash.slice(0, 16)}-${as}"`;
}

describe("ETag format (GATE M4.4)", () => {
  const hash = contentHash(MARKDOWN);
  const etags = representationSchema.options.map((as) => etagFor(hash, as));

  it("hashes to 64 lowercase hex", () => {
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each(representationSchema.options.map((as, i) => [as, etags[i]!] as const))(
    '%s ETag is W/"sha256-<16hex>-<as>"',
    (as, etag) => {
      expect(etag).toBe(`W/"sha256-${hash.slice(0, 16)}-${as}"`);
      expect(etag).toMatch(/^W\/"sha256-[0-9a-f]{16}-(html|markdown|json|jsonld|mcp|feed)"$/);
    },
  );

  it("differs across representations", () => {
    expect(new Set(etags).size).toBe(6);
  });
});
