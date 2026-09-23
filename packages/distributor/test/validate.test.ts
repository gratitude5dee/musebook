import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { countEffective } from "../src/count";
import { validateVariant, type VariantCandidate } from "../src/validate";
import { FIXTURES, PLATFORM_SLUGS } from "./fixtures";

const URL_ = "https://musebook.dev/p/canonical-post";

describe("golden candidates — 26 files, one ok + one bad per platform", () => {
  for (const slug of PLATFORM_SLUGS) {
    it(`${slug}: the accepted candidate validates`, () => {
      const { constraint, ok } = FIXTURES[slug]!;
      const report = validateVariant(ok, constraint);
      expect(report.failures).toEqual([]);
      expect(report.ok).toBe(true);
    });

    it(`${slug}: the rejected candidate fails its checks`, () => {
      const { constraint, bad, badChecks } = FIXTURES[slug]!;
      const report = validateVariant(bad, constraint);
      expect(report.ok).toBe(false);
      const failedIds = report.checks
        .filter((c) => !c.ok && c.severity === "error")
        .map((c) => c.id);
      for (const id of badChecks) {
        expect(failedIds).toContain(id);
      }
    });
  }
});

describe("counter parity — gate check 4", () => {
  it("the same strings feed countEffective AND the validator for all 13 platforms", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 1200 }),
        fc.constantFrom(...PLATFORM_SLUGS),
        (s, slug) => {
          const { constraint } = FIXTURES[slug]!;
          const body = `${s} ${URL_}`;
          const candidate: VariantCandidate = {
            body,
            threadParts: [],
            media: [],
            title: constraint.maxTitleChars === null ? null : "ok",
            canonicalUrl: URL_,
          };
          const report = validateVariant(candidate, constraint);
          const counted = countEffective(constraint.countMethod, body, constraint.urlCountsAsChars);
          const lenCheck = report.checks.find((c) => c.id === "length.part.0")!;
          // parity: the check's pass/fail is exactly the counter's verdict
          expect(lenCheck.ok).toBe(counted <= constraint.maxChars);
          return true;
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe("media.public_origin — gate check 5", () => {
  const base: VariantCandidate = {
    body: `Body ${URL_}`,
    threadParts: [],
    media: [],
    title: null,
    canonicalUrl: URL_,
  };

  it("a musebook-paid-shaped URL is a HARD ERROR", () => {
    const { constraint } = FIXTURES.x!;
    const c: VariantCandidate = {
      ...base,
      media: [
        {
          url: "https://musebook-paid.r2.dev/secret.mp4",
          contentType: "video/mp4",
          alt: null,
          widthPx: 1080,
          heightPx: 1080,
          durationSeconds: 30,
          thumbnailUrl: "https://cdn.musebook.dev/t.jpg",
        },
      ],
    };
    const report = validateVariant(c, constraint);
    const chk = report.checks.find((k) => k.id === "media.public_origin")!;
    expect(chk.ok).toBe(false);
    expect(chk.severity).toBe("error");
    expect(report.ok).toBe(false);
  });

  it("a cdn.musebook.dev URL passes", () => {
    const { constraint } = FIXTURES.x!;
    const c: VariantCandidate = {
      ...base,
      media: [
        {
          url: "https://cdn.musebook.dev/abc.mp4",
          contentType: "video/mp4",
          alt: null,
          widthPx: 1080,
          heightPx: 1080,
          durationSeconds: 30,
          thumbnailUrl: "https://cdn.musebook.dev/t.jpg",
        },
      ],
    };
    const report = validateVariant(c, constraint);
    expect(report.checks.find((k) => k.id === "media.public_origin")!.ok).toBe(true);
  });
});

describe("advisory checks never block", () => {
  it("an over-long unverified video duration is a warning, not a failure", () => {
    const { constraint } = FIXTURES.x!;
    const c: VariantCandidate = {
      body: `Body ${URL_}`,
      threadParts: [],
      media: [
        {
          url: "https://cdn.musebook.dev/abc.mp4",
          contentType: "video/mp4",
          alt: null,
          widthPx: 1080,
          heightPx: 1080,
          durationSeconds: 300, // over x's UNVERIFIED 140s
          thumbnailUrl: "https://cdn.musebook.dev/t.jpg",
        },
      ],
      title: null,
      canonicalUrl: URL_,
    };
    const report = validateVariant(c, constraint);
    const chk = report.checks.find((k) => k.id === "media.duration")!;
    expect(chk.severity).toBe("warning");
    expect(report.ok).toBe(true);
  });
});
