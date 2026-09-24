// test/m17.test.ts — M17.2 + M17.3: the validator gates model output
// identically, and a dead gateway yields the deterministic variant.
import { describe, expect, it, vi } from "vitest";
import { deterministicVariant } from "../src/fallback";
import { produceVariant } from "../src/pipeline";
import { validateVariant, type VariantCandidate } from "../src/validate";
import type { DistributorEnv } from "../src/postiz/client";
import type { VariantProposal } from "../src/reformat";
import { FIXTURES } from "./fixtures";

vi.mock("ai", () => ({
  generateObject: vi.fn(),
}));

import { generateObject } from "ai";

const URL_ = "https://musebook.dev/p/m17-gate";

const ENV: DistributorEnv = {
  POSTIZ_URL: "https://postiz.example",
  POSTIZ_API_KEY: "k",
  POSTIZ_MEDIA_DOMAIN: "media.postiz.musebook.dev",
  CDN_HOST: "cdn.musebook.dev",
  DISTRIBUTION_ENABLED: "true",
  AI_GATEWAY_API_KEY: "test-key",
  REFORMAT_MODEL: "anthropic/claude-sonnet-5",
  REFORMAT_MAX_REPAIRS: "2",
};

const PLAIN =
  "The argument is simple: agents pay for what they read, creators get paid " +
  "when they do. ".repeat(6);

describe("validator gates model output", () => {
  it("rejects a model-emitted over-length body exactly like a deterministic one", () => {
    const { constraint } = FIXTURES.x!;
    const candidate: VariantCandidate = {
      body: "x".repeat(600) + " " + URL_,
      threadParts: [],
      media: [],
      title: null,
      canonicalUrl: URL_,
    };
    const report = validateVariant(candidate, constraint);
    expect(report.ok).toBe(false);
    expect(
      report.checks.some((c) => c.id === "length.part.0" && !c.ok && c.severity === "error"),
    ).toBe(true);
  });

  it("a proposal that never validates falls back to a valid deterministic variant", async () => {
    const { constraint } = FIXTURES.x!;
    const badProposal: VariantProposal = {
      body: "x".repeat(600) + " " + URL_,
      threadParts: [],
      mediaIndexes: [],
      altText: [],
      hashtags: [],
      title: null,
      rationale: "ignored the length limit",
    };
    vi.mocked(generateObject).mockResolvedValue({ object: badProposal } as never);
    const r = await produceVariant(
      {
        canonicalMarkdown: PLAIN,
        plainBody: PLAIN,
        canonicalUrl: URL_,
        intent: "full",
        constraint,
        platformRules: null,
        media: [],
      },
      ENV,
    );
    // every repair attempt produced the same violating proposal; the pipeline
    // stopped repairing and shipped the deterministic variant, validated
    expect(r.generatedBy).toBe("deterministic");
    expect(r.report.ok).toBe(true);
  });
});

describe("gateway down", () => {
  it("a throwing gateway (503) still produces a valid deterministic variant", async () => {
    const { constraint } = FIXTURES.x!;
    vi.mocked(generateObject).mockRejectedValue(new Error("gateway returned 503"));
    const r = await produceVariant(
      {
        canonicalMarkdown: PLAIN,
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
    const det = deterministicVariant(
      { plainBody: PLAIN, canonicalUrl: URL_, media: [] },
      constraint,
    );
    expect(r.candidate).toEqual(det);
  });
});
