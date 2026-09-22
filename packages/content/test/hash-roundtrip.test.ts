// hash-roundtrip.test.ts — the pure-TS sha256 must produce byte-identical
// output to the platform's WebCrypto digest on a generated corpus, plus the
// RFC vectors, on BOTH vitest tiers (Node and workerd run this same file —
// GATE M4 check 5). If they ever diverge the join key forks by runtime.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { sha256Hex } from "../src/sha256.js";
import { canonicalMarkdown } from "../src/canonicalize.js";
import { contentHash } from "../src/hash.js";

const KNOWN: Array<[string, string]> = [
  ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
  ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
  [
    "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
  ],
  ["a".repeat(1_000_000), "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"],
];

async function webCryptoHex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

describe("sha256 pure-TS vs WebCrypto", () => {
  for (const [input, expected] of KNOWN) {
    it(`RFC vector ${input.length <= 60 ? JSON.stringify(input) : `<${input.length} bytes>`}`, () => {
      expect(sha256Hex(input)).toBe(expected);
    });
  }

  it("matches WebCrypto on a generated corpus (both tiers)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.string({ minLength: 0, maxLength: 200 }), { minLength: 0, maxLength: 24 }),
        async (lines) => {
          const input = lines.join("\n");
          expect(sha256Hex(input)).toBe(await webCryptoHex(input));
          expect(contentHash(input)).toBe(await webCryptoHex(canonicalMarkdown(input)));
        },
      ),
      { numRuns: 120, seed: 20260922 },
    );
  });
});
