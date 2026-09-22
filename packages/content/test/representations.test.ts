// representations.test.ts — GATE M4 check 3: all six §6.6 representations are
// produced for a fixture Resource, with the shape each twin's consumer reads.
import { describe, expect, it } from "vitest";
import { resourceSchema, representationSchema } from "@musebook/schema";
import { canonicalMarkdown } from "../src/canonicalize.js";
import { contentHash } from "../src/hash.js";
import { frontMatter } from "../src/frontmatter.js";
import { jsonLdBase } from "../src/jsonld.js";
import { CONTENT_TYPES, produce, type BodyKind } from "../src/representations.js";
import { fixture, MARKDOWN, ORIGIN } from "./fixture.js";

const resource = { ...fixture, contentHash: contentHash(MARKDOWN) };
const KINDS: BodyKind[] = ["full", "preview", "empty"];

describe("six representations (GATE M4.3)", () => {
  it("produces all six for the fixture", () => {
    const produced = representationSchema.options.map(
      (as) => [as, produce(resource, as, "full", ORIGIN)] as const,
    );
    expect(produced.map(([as]) => as)).toEqual([
      "html",
      "markdown",
      "json",
      "jsonld",
      "mcp",
      "feed",
    ]);
    for (const [as, out] of produced) {
      expect(out.body.length, `${as} body`).toBeGreaterThan(0);
      expect(out.contentType).toBe(CONTENT_TYPES[as]);
    }
  });

  it("content types match the §6.6 table", () => {
    expect(CONTENT_TYPES).toEqual({
      html: "text/html; charset=utf-8",
      markdown: "text/markdown; charset=utf-8",
      json: "application/json; charset=utf-8",
      jsonld: "application/ld+json",
      mcp: "application/json",
      feed: "application/feed+json",
    });
  });

  it("the fixture parses as a Resource", () => {
    expect(resourceSchema.safeParse(resource).success).toBe(true);
  });
});

describe("markdown twin", () => {
  it("carries the YAML front matter then the canonical body", () => {
    const { body } = produce(resource, "markdown", "full", ORIGIN);
    expect(body.startsWith("---\n")).toBe(true);
    expect(body).toContain(`content_hash: "${resource.contentHash}"`);
    expect(body).toContain('license: "CC-BY-4.0"');
    const afterFence = body.split("---\n")[2];
    expect(afterFence).toBe(`\n${canonicalMarkdown(MARKDOWN)}`);
  });

  it("preview appends the paywall marker comment", () => {
    const { body } = produce(resource, "markdown", "preview", ORIGIN);
    expect(body).toContain('<!-- musebook:paywall price="$4.20" -->');
  });

  it("empty kind yields an empty body", () => {
    expect(produce(resource, "markdown", "empty", ORIGIN).body).toBe("");
  });
});

describe("html twin", () => {
  it("full wraps the article and inlines JSON-LD", () => {
    const { body } = produce(resource, "html", "full", ORIGIN);
    expect(body).toContain("<article>");
    expect(body).toContain("<h1>Ship the ledger</h1>");
    expect(body).toContain("<strong>bold</strong>");
    expect(body).toContain('<a href="https://example.com/x">link</a>');
    expect(body).toContain('<script type="application/ld+json">');
    expect(body).toContain("#post");
    expect(body).not.toContain("musebook-paywall");
  });

  it("preview appends the paywall div", () => {
    const { body } = produce(resource, "html", "preview", ORIGIN);
    expect(body).toContain('<div class="musebook-paywall">');
    expect(body).toContain("$4.20");
  });

  it("empty is a minimal error document", () => {
    const { body } = produce(resource, "html", "empty", ORIGIN);
    expect(body).toContain("Payment required");
    expect(body).not.toContain("<article>");
  });
});

describe("json twin", () => {
  it("full populates body with canonical markdown", () => {
    const env = JSON.parse(produce(resource, "json", "full", ORIGIN).body);
    expect(env.body).toBe(canonicalMarkdown(MARKDOWN));
    expect(env.schema).toBe("musebook-post-v1");
    expect(env.content_hash).toBe(resource.contentHash);
  });

  it("preview nulls body and carries payment metadata", () => {
    const env = JSON.parse(produce(resource, "json", "preview", ORIGIN).body);
    expect(env.body).toBeNull();
    expect(env.preview).toBe(true);
    expect(env.payment.required).toBe(true);
    expect(env.payment.price_atomic).toBe("420");
    expect(env.payment.price_network).toBe("eip155:8453");
  });

  it("empty is an error object", () => {
    expect(JSON.parse(produce(resource, "json", "empty", ORIGIN).body)).toEqual({
      error: "payment_required",
    });
  });
});

describe("jsonld twin", () => {
  it("emits the §7.12 base document with decision fields left to the kernel", () => {
    const doc = JSON.parse(produce(resource, "jsonld", "full", ORIGIN).body);
    expect(doc["@type"]).toBe("Article");
    expect(doc["@id"]).toBe(`${ORIGIN}/p/ship-the-ledger#post`);
    expect(doc.mainEntityOfPage["@id"]).toBe(`${ORIGIN}/p/ship-the-ledger`);
    expect(doc.license).toBe("https://creativecommons.org/licenses/by/4.0/");
    expect(doc.usageInfo).toBe(`${ORIGIN}/api/posts/${resource.postId}/license`);
    // Decision fields are not the producer's job (M5 / §6.6 render/jsonld).
    expect(doc.isAccessibleForFree).toBeUndefined();
    expect(doc.hasPart).toBeUndefined();
    expect(JSON.stringify(jsonLdBase(resource, ORIGIN))).toBe(
      produce(resource, "jsonld", "empty", ORIGIN).body,
    );
  });
});

describe("mcp twin", () => {
  it("full wraps canonical markdown in content text", () => {
    const env = JSON.parse(produce(resource, "mcp", "full", ORIGIN).body);
    expect(env.content[0].type).toBe("text");
    expect(env.content[0].text).toBe(canonicalMarkdown(MARKDOWN));
    expect(env.structuredContent.content_hash).toBe(resource.contentHash);
    expect(env.structuredContent.attribution_required).toBe(true);
  });

  it("preview is an isError result with payment text", () => {
    const env = JSON.parse(produce(resource, "mcp", "preview", ORIGIN).body);
    expect(env.isError).toBe(true);
    expect(env.content[0].text).toContain("$4.20");
    expect(env.structuredContent.payment_required).toBe(true);
  });
});

describe("feed twin", () => {
  it("carries metadata and the link only — the body is ignored in every mode", () => {
    const doc = JSON.parse(produce(resource, "feed", "full", ORIGIN).body);
    expect(doc.url).toBe("https://musebook.dev/p/ship-the-ledger");
    expect(doc.id).toBe(`${ORIGIN}/p/ship-the-ledger`);
    expect(doc.content_hash).toBe(resource.contentHash);
    expect(doc).not.toHaveProperty("body");
    for (const kind of KINDS) {
      expect(produce(resource, "feed", kind, ORIGIN).body).toBe(JSON.stringify(doc));
    }
  });
});

describe("front matter", () => {
  it("is deterministic for the fixture", () => {
    const expected = [
      "---",
      'title: "Ship the ledger"',
      'slug: "ship-the-ledger"',
      'kind: "article"',
      'author: "@ada"',
      'display_name: "Ada Maker"',
      'canonical_url: "https://musebook.dev/p/ship-the-ledger"',
      'license: "CC-BY-4.0"',
      'license_url: "https://creativecommons.org/licenses/by/4.0/"',
      `content_hash: "${resource.contentHash}"`,
      'published: "2026-09-20T12:00:00.000Z"',
      'updated: "2026-09-21T08:30:00.000Z"',
      'tags: ["edge", "ledger"]',
      "---",
      "",
    ].join("\n");
    expect(frontMatter(resource)).toBe(expected);
  });
});
