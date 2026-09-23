import { describe, expect, it } from "vitest";
import { deterministicVariant } from "../src/fallback";
import { produceVariant } from "../src/pipeline";
import { validateVariant } from "../src/validate";
import type { DistributorEnv } from "../src/postiz/client";
import { FIXTURES, PLATFORM_SLUGS } from "./fixtures";

const URL_ = "https://musebook.dev/p/canonical-post";

// A human_free_agent_paid post: long enough to need real splitting on the
// thread platforms, marked up the way canonicalMarkdown is. The plain body is
// what the deterministic path sees.
const PLAIN =
  "The thesis of this piece is simple: agents should pay for what they read, " +
  "and creators should be paid when they do. " +
  "Over the next several paragraphs we work through the pricing model, the " +
  "ledger shape, and the grant lifecycle in detail, sentence by sentence, " +
  "until the argument is complete. ".repeat(8);

const ENV: DistributorEnv = {
  POSTIZ_URL: "https://postiz.example",
  POSTIZ_API_KEY: "k",
  POSTIZ_MEDIA_DOMAIN: "media.postiz.musebook.dev",
  CDN_HOST: "cdn.musebook.dev",
  DISTRIBUTION_ENABLED: "true",
  AI_GATEWAY_API_KEY: "",
};

describe("deterministicVariant — gate check 6: FULL PORTS", () => {
  for (const slug of PLATFORM_SLUGS) {
    it(`${slug}: deterministic fallback yields a valid full-port variant`, () => {
      const { constraint } = FIXTURES[slug]!;
      const media =
        constraint.minMedia > 0
          ? [
              {
                url: "https://cdn.musebook.dev/cover.jpg",
                contentType: "image/jpeg",
                alt: "cover",
                widthPx: 1080,
                heightPx: constraint.slug === "tiktok" ? 1080 : 1080,
                durationSeconds: null,
                thumbnailUrl: null,
              },
              ...(constraint.maxVideos > 0 && constraint.mediaRules.exactly_one_media === true
                ? []
                : []),
            ]
          : [];
      // platforms that require a video can't be satisfied by an image-only fixture
      const needsVideo = constraint.slug === "youtube" || constraint.slug === "tiktok";
      const cands = deterministicVariant(
        {
          plainBody: PLAIN,
          canonicalUrl: URL_,
          media: needsVideo
            ? [
                {
                  url: "https://cdn.musebook.dev/clip.mp4",
                  contentType: "video/mp4",
                  alt: null,
                  widthPx: 1080,
                  heightPx: 1080,
                  durationSeconds: 30,
                  thumbnailUrl: "https://cdn.musebook.dev/clip-thumb.jpg",
                },
              ]
            : media,
        },
        constraint,
      );
      const report = validateVariant(cands, constraint);
      expect(report.failures).toEqual([]);
      expect(report.ok).toBe(true);
      // a full port is not a stub: the body carries real text, not just the URL
      const total = [cands.body, ...cands.threadParts].join("");
      expect(total.length).toBeGreaterThan(URL_.length + 40);
    });
  }

  it("always ends a truncated non-thread variant at the canonical URL", () => {
    const { constraint } = FIXTURES.discord!;
    const c = deterministicVariant({ plainBody: PLAIN, canonicalUrl: URL_, media: [] }, constraint);
    expect(c.body.trimEnd().endsWith(URL_)).toBe(true);
  });
});

describe("produceVariant", () => {
  it("uses the deterministic path when the gateway is unconfigured", async () => {
    const { constraint } = FIXTURES.threads!;
    const r = await produceVariant(
      {
        canonicalMarkdown: `## Title\n\n${PLAIN}`,
        plainBody: PLAIN,
        canonicalUrl: URL_,
        intent: "full",
        constraint,
        platformRules: null,
        media: [],
      },
      ENV,
    );
    expect(r.generatedBy).toBe("deterministic");
    expect(r.report.ok).toBe(true);
  });
});
