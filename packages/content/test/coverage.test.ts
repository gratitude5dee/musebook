// coverage.test.ts — branch coverage for the arms the M4 gate matrix doesn't
// reach: every fragmentFor/spdxUrl arm, the jsonLdBase headline chain, null
// front-matter fields, the markdown renderer's image/code/hr/front-matter
// edges, and displayPrice's null-safe fallbacks.
import { describe, expect, it } from "vitest";
import { fragmentFor, jsonLdBase, spdxUrl } from "../src/jsonld";
import { frontMatter } from "../src/frontmatter";
import { markdownToHtml } from "../src/markdown-html";
import { produce } from "../src/representations";
import { fixture as RESOURCE } from "./fixture";
import type { Resource } from "@musebook/schema";

const asKind = (kind: Resource["kind"]) => ({ ...RESOURCE, kind });

describe("fragmentFor", () => {
  it("text kinds collapse to post; media/artifact kinds keep their own", () => {
    for (const k of ["note", "article", "thread"] as const) expect(fragmentFor(k)).toBe("post");
    for (const k of ["image", "video", "audio", "app", "model3d"] as const)
      expect(fragmentFor(k)).toBe(k);
  });
});

describe("spdxUrl", () => {
  it("every SPDX id maps to its canonical deed; ARR yields null", () => {
    for (const [spdx, url] of [
      ["CC0-1.0", "https://creativecommons.org/publicdomain/zero/1.0/"],
      ["CC-BY-4.0", "https://creativecommons.org/licenses/by/4.0/"],
      ["CC-BY-SA-4.0", "https://creativecommons.org/licenses/by-sa/4.0/"],
      ["CC-BY-NC-4.0", "https://creativecommons.org/licenses/by-nc/4.0/"],
      ["CC-BY-ND-4.0", "https://creativecommons.org/licenses/by-nd/4.0/"],
      ["MIT", "https://spdx.org/licenses/MIT.html"],
      ["Apache-2.0", "https://spdx.org/licenses/Apache-2.0.html"],
      ["ARR", null],
    ] as const) {
      expect(spdxUrl(spdx)).toBe(url);
    }
  });
});

describe("jsonLdBase arms", () => {
  it("kind article gets @type Article and #post fragment", () => {
    const doc = jsonLdBase(asKind("article"), "https://musebook.dev");
    expect(doc["@type"]).toBe("Article");
    expect(doc["@id"]).toBe("https://musebook.dev/p/ship-the-ledger#post");
  });
  it("non-article kind is SocialMediaPosting with its own fragment", () => {
    const doc = jsonLdBase(asKind("video"), "https://musebook.dev");
    expect(doc["@type"]).toBe("SocialMediaPosting");
    expect(doc["@id"]).toBe("https://musebook.dev/p/ship-the-ledger#video");
  });
  it("headline falls title → summary → slug", () => {
    expect(jsonLdBase({ ...RESOURCE, title: null }, "https://x")["headline"]).toBe(
      RESOURCE.summary,
    );
    expect(jsonLdBase({ ...RESOURCE, title: null, summary: null }, "https://x")["headline"]).toBe(
      RESOURCE.slug,
    );
  });
  it("license falls back to the SPDX deed, then undefined for ARR", () => {
    expect(jsonLdBase(RESOURCE, "https://x")["license"]).toBe(
      "https://creativecommons.org/licenses/by/4.0/",
    );
    expect(jsonLdBase({ ...RESOURCE, licenseUrl: "https://x/deed" }, "https://x")["license"]).toBe(
      "https://x/deed",
    );
    const arr = jsonLdBase({ ...RESOURCE, licenseSpdx: "ARR", licenseUrl: null }, "https://x");
    expect(arr["license"]).toBeNull();
  });
});

describe("frontMatter edges", () => {
  it("null fields serialize as null and empty tags emit no line", () => {
    const r = {
      ...RESOURCE,
      title: null,
      canonicalUrl: null,
      licenseUrl: null,
      publishedAt: null,
      tags: [],
    };
    const fm = frontMatter(r);
    // Absent values are omitted entirely — the block stays YAML-parseable
    // without nulls and stays deterministic.
    expect(fm).not.toContain("title:");
    expect(fm).not.toContain("canonical_url:");
    expect(fm).not.toContain("license_url:");
    expect(fm).not.toContain("published:");
    expect(fm).not.toContain("tags:");
  });
});

describe("markdownToHtml edge blocks", () => {
  it("renders an image with a safe src and leaves an unsafe one literal", () => {
    const html = markdownToHtml("![alt](https://x/img.png) and ![x](javascript:evil)");
    expect(html).toContain('<img src="https://x/img.png" alt="alt">');
    expect(html).toContain("![x](javascript:evil)");
  });
  it("renders code spans and treats an unpaired backtick as literal", () => {
    expect(markdownToHtml("a `code` b")).toContain("<code>code</code>");
    expect(markdownToHtml("a `unterminated")).toContain("`unterminated");
  });
  it("renders a horizontal rule", () => {
    expect(markdownToHtml("above\n\n---\n\nbelow")).toContain("<hr>");
  });
  it("strips a leading front-matter block", () => {
    const html = markdownToHtml("---\ntitle: x\n---\nbody");
    expect(html).not.toContain("title: x");
    expect(html).toContain("body");
  });
  it("renders a nested list continuation as part of the parent item", () => {
    const html = markdownToHtml("- parent\n  - child\n  continuation\n- second");
    expect(html).toContain("child");
    expect(html).toContain("continuation");
    // parent, nested child, second — three <li> nodes.
    expect(html.match(/<li>/g)?.length).toBe(3);
  });
});

describe("displayPrice + bodyKind edges", () => {
  it("priceUsd null falls back to atomic + asset; both null to atomic only", () => {
    const noUsd = produce(
      { ...RESOURCE, priceUsd: null },
      "json",
      "preview",
      "https://musebook.dev",
    );
    const payment = (JSON.parse(noUsd.body) as { payment: { price_usd: string | null } }).payment;
    expect(payment.price_usd).toBeNull();
    const mcp = produce(
      { ...RESOURCE, priceUsd: null, priceAsset: null },
      "mcp",
      "preview",
      "https://musebook.dev",
    );
    const parsed = JSON.parse(mcp.body) as { content: Array<{ text: string }> };
    expect(parsed.content[0]!.text).toContain("420 (null on eip155:8453)");
  });
  it("mcp empty is isError with no content entries", () => {
    const mcp = produce(RESOURCE, "mcp", "empty", "https://musebook.dev");
    const parsed = JSON.parse(mcp.body) as { isError: boolean; content: unknown[] };
    expect(parsed.isError).toBe(true);
    expect(parsed.content).toEqual([]);
  });
});
