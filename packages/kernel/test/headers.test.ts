// packages/kernel/test/headers.test.ts — headersFor arms (§6.6).
import { describe, expect, it } from "vitest";
import { headersFor, linkHeaderFor, usageHeadersFor } from "../src/headers.js";
import { PRIVATE_NO_STORE } from "../src/cache.js";
import { FREE, HFAP, GATED } from "./fixtures/resources.js";
import { ORIGIN } from "./fixtures/ports.js";
import type { AccessDecision } from "@musebook/schema";

const ALLOW: AccessDecision = {
  allow: true,
  reason: "mode_free",
  bodyKind: "full",
  grantId: null,
  settlementId: null,
  settlement: null,
  cache: PRIVATE_NO_STORE,
};

const DENY: AccessDecision = {
  allow: false,
  reason: "payment_required",
  httpStatus: 402,
  bodyKind: "preview",
  challenge: null,
  cache: PRIVATE_NO_STORE,
};

describe("linkHeaderFor", () => {
  it("lists canonical, the three alternates, license, and llms.txt", () => {
    const link = linkHeaderFor(FREE, ORIGIN);
    expect(link).toContain(`<${ORIGIN}/p/the-free-article>; rel="canonical"`);
    expect(link).toContain(`<${ORIGIN}/p/the-free-article.md>; rel="alternate"; type="text/markdown"`);
    expect(link).toContain(`<${ORIGIN}/p/the-free-article.json>; rel="alternate"; type="application/json"`);
    expect(link).toContain(`<${ORIGIN}/p/the-free-article.jsonld>; rel="alternate"; type="application/ld+json"`);
    expect(link).toContain(`<https://creativecommons.org/licenses/by/4.0/>; rel="license"`);
    expect(link).toContain(`<${ORIGIN}/llms.txt>; rel="describedby"; type="text/plain"`);
  });

  it("prefers canonical_url when set and omits rel=license for ARR", () => {
    const r = { ...FREE, canonicalUrl: "https://mirror.example/p/the-free-article", licenseSpdx: "ARR" as const };
    const link = linkHeaderFor(r, ORIGIN);
    expect(link).toContain(`<https://mirror.example/p/the-free-article>; rel="canonical"`);
    expect(link).not.toContain('rel="license"');
  });
});

describe("usageHeadersFor", () => {
  it("reads the license columns, never the mode", () => {
    const h = usageHeadersFor(FREE);
    expect(h["Content-Usage"]).toBe("ai-use=y, train-ai=y, search=y");
    expect(h["X-Musebook-License"]).toBe("CC-BY-4.0");
    const gated = usageHeadersFor(GATED);
    expect(gated["Content-Usage"]).toBe("ai-use=y, train-ai=n, search=y");
  });
});

describe("headersFor", () => {
  it("emits Cache-Control, Link, content hash, usage headers", () => {
    const h = headersFor(FREE, ALLOW, "html", ORIGIN);
    expect(h["Cache-Control"]).toBe(PRIVATE_NO_STORE.cacheControl);
    expect(h.Link).toContain('rel="canonical"');
    expect(h["X-Musebook-Content-Hash"]).toBe(FREE.contentHash);
    expect(h["Content-Usage"]).toContain("train-ai=y");
  });

  it("emits Vary only when the policy lists vary keys", () => {
    const sharedAllow: AccessDecision = {
      ...ALLOW,
      cache: {
        cacheControl: "public, s-maxage=300, stale-while-revalidate=86400",
        vary: ["Accept", "Accept-Encoding", "Signature-Agent"],
        shared: true,
      },
    };
    expect(headersFor(HFAP, sharedAllow, "html", ORIGIN).Vary).toBe(
      "Accept, Accept-Encoding, Signature-Agent",
    );
    expect(headersFor(HFAP, ALLOW, "html", ORIGIN).Vary).toBeUndefined();
  });

  it("emits ETag only on allow, never on deny", () => {
    expect(headersFor(FREE, ALLOW, "markdown", ORIGIN).ETag).toBe(
      `W/"sha256-${FREE.contentHash.slice(0, 16)}-markdown"`,
    );
    expect(headersFor(FREE, DENY, "markdown", ORIGIN).ETag).toBeUndefined();
  });

  it("emits X-Robots-Tag only for html, per search_indexable", () => {
    expect(headersFor(FREE, ALLOW, "html", ORIGIN)["X-Robots-Tag"]).toBe(
      "index, follow, max-snippet:-1, max-image-preview:large",
    );
    const hidden = { ...FREE, searchIndexable: false };
    expect(headersFor(hidden, ALLOW, "html", ORIGIN)["X-Robots-Tag"]).toBe(
      "noindex, nofollow",
    );
    expect(headersFor(FREE, ALLOW, "json", ORIGIN)["X-Robots-Tag"]).toBeUndefined();
  });
});
