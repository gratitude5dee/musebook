// packages/kernel/test/branches.test.ts — the arms the golden matrix cannot reach:
// every fragmentFor/spdxUrl switch arm, every ?? fallback in the render path, the
// null-challenge mcp arm, allow+empty json/jsonld, and the payerOf/agentIdOf tails.
import { describe, expect, it } from "vitest";
import type { AccessDecision, Actor, PostKind, Resource } from "@musebook/schema";
import { createKernel } from "../src/index.js";
import { fragmentFor, spdxUrl, jsonLdFor } from "../src/render/jsonld.js";
import { renderFeed } from "../src/render/feed.js";
import { renderHtml } from "../src/render/html.js";
import { renderMarkdown } from "../src/render/markdown.js";
import { renderJson } from "../src/render/json.js";
import { renderMcp } from "../src/render/mcp.js";
import { previewOf } from "../src/render/preview.js";
import { pricingLineFor, toAccessBadge } from "../src/index.js";
import { stubPorts, ORIGIN } from "./fixtures/ports.js";
import { FREE, HFAP, GATED } from "./fixtures/resources.js";
import { HUMAN } from "./fixtures/actors.js";

const ALLOW_EMPTY: AccessDecision = {
  allow: true,
  reason: "mode_free",
  bodyKind: "empty",
  grantId: null,
  settlementId: null,
  settlement: null,
  cache: { cacheControl: "private, no-store, must-revalidate", vary: [], shared: false },
};

const DENY_PREVIEW_NO_CHALLENGE: AccessDecision = {
  allow: false,
  reason: "replay_in_flight",
  httpStatus: 409,
  bodyKind: "preview",
  challenge: null,
  cache: { cacheControl: "private, no-store, must-revalidate", vary: [], shared: false },
};

describe("fragmentFor — every post_kind arm", () => {
  const cases: Array<[PostKind, string]> = [
    ["note", "post"],
    ["article", "post"],
    ["thread", "post"],
    ["image", "image"],
    ["video", "video"],
    ["audio", "audio"],
    ["app", "app"],
    ["model3d", "model3d"],
  ];
  for (const [kind, fragment] of cases) {
    it(`${kind} -> #${fragment}`, () => {
      expect(fragmentFor(kind)).toBe(fragment);
    });
  }
});

describe("spdxUrl — every license arm", () => {
  it("maps each SPDX id to its deed and ARR to null", () => {
    expect(spdxUrl("CC0-1.0")).toBe("https://creativecommons.org/publicdomain/zero/1.0/");
    expect(spdxUrl("CC-BY-4.0")).toBe("https://creativecommons.org/licenses/by/4.0/");
    expect(spdxUrl("CC-BY-SA-4.0")).toBe("https://creativecommons.org/licenses/by-sa/4.0/");
    expect(spdxUrl("CC-BY-NC-4.0")).toBe("https://creativecommons.org/licenses/by-nc/4.0/");
    expect(spdxUrl("CC-BY-ND-4.0")).toBe("https://creativecommons.org/licenses/by-nd/4.0/");
    expect(spdxUrl("MIT")).toBe("https://spdx.org/licenses/MIT.html");
    expect(spdxUrl("Apache-2.0")).toBe("https://spdx.org/licenses/Apache-2.0.html");
    expect(spdxUrl("ARR")).toBeNull();
  });
});

describe("feed + html fallback arms", () => {
  it("feed: title falls back to summary then slug; content_text '' when no summary", () => {
    const bare: Resource = { ...FREE, title: null, summary: null };
    const item = renderFeed(bare, ORIGIN) as Record<string, unknown>;
    expect(item.title).toBe(FREE.slug);
    expect(item.content_text).toBe("");
    expect(item.summary).toBeNull();
    const withSummary: Resource = { ...FREE, title: null };
    expect((renderFeed(withSummary, ORIGIN) as Record<string, unknown>).title).toBe(FREE.summary);
  });

  it("html: title/description fallbacks, canonical_url override, missing timestamps", () => {
    const bare: Resource = {
      ...FREE,
      title: null,
      summary: null,
      canonicalUrl: "https://mirror.example/p/x",
      publishedAt: null,
      languageCode: "fr",
    };
    const decision: AccessDecision = { ...ALLOW_EMPTY, bodyKind: "full" };
    const doc = renderHtml(bare, decision, ORIGIN, 400);
    expect(doc).toContain(`<title>${FREE.slug} — Musebook</title>`);
    expect(doc).toContain('content=""');
    expect(doc).toContain('href="https://mirror.example/p/x"');
    expect(doc).toContain('content=""');
    expect(doc).toContain('<html lang="fr">');
  });

  it("html empty bodyKind prints the reason on deny and blank on allow", () => {
    const denyDoc = renderHtml(
      FREE,
      { ...DENY_PREVIEW_NO_CHALLENGE, bodyKind: "empty", httpStatus: 404, reason: "not_published" },
      ORIGIN,
      400,
    );
    expect(denyDoc).toContain("<p>not_published</p>");
    const allowDoc = renderHtml(FREE, ALLOW_EMPTY, ORIGIN, 400);
    expect(allowDoc).toContain("<p></p>");
  });

  it("html preview shows $0.00 when priceUsd is null", () => {
    const noPrice: Resource = { ...GATED, priceUsd: null };
    const doc = renderHtml(noPrice, DENY_PREVIEW_NO_CHALLENGE, ORIGIN, 400);
    expect(doc).toContain("$0.00");
  });
});

describe("markdown + preview arms", () => {
  it("markdown preview uses the network default and gated wording", () => {
    const noNet: Resource = { ...GATED, priceNetwork: null };
    const body = renderMarkdown(noNet, DENY_PREVIEW_NO_CHALLENGE, ORIGIN, 400);
    expect(body).toContain("eip155:8453");
    expect(body).toContain("via x402 for");
  });

  it("markdown preview on hfap reads the agents line", () => {
    const body = renderMarkdown(HFAP, DENY_PREVIEW_NO_CHALLENGE, ORIGIN, 400);
    expect(body).toContain("available to agents for");
  });

  it("stripFrontMatter: unterminated fence returns the input, no fence returns it too", () => {
    expect(previewOf("---\ntitle: never closed\n\nbody", 400)).toContain("body");
    expect(previewOf("plain body", 400)).toBe("plain body\n\n<!-- musebook:paywall -->");
  });
});

describe("json + jsonld + mcp edge arms", () => {
  it("json empty bodyKind: reason on deny, 'unavailable' on allow", () => {
    expect(
      renderJson(
        FREE,
        { ...DENY_PREVIEW_NO_CHALLENGE, bodyKind: "empty", reason: "blocked_agent" },
        ORIGIN,
        400,
      ),
    ).toEqual({ error: "blocked_agent" });
    expect(renderJson(FREE, ALLOW_EMPTY, ORIGIN, 400)).toEqual({ error: "unavailable" });
  });

  it("jsonld empty bodyKind renders the not_available envelope", async () => {
    const kernel = createKernel(stubPorts());
    const rendered = await kernel.renderResource(FREE, "jsonld", ALLOW_EMPTY);
    expect(rendered.structured).toEqual({ error: "not_available" });
    expect(JSON.parse(rendered.body)).toEqual(rendered.structured);
  });

  it("mcp preview without a challenge emits the synthetic error object", () => {
    const { result } = renderMcp(HFAP, DENY_PREVIEW_NO_CHALLENGE, ORIGIN, 400);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ error: "payment_required" });
  });

  it("jsonLdFor: licenseUrl beats spdxUrl; ARR drops license entirely", () => {
    const allow: AccessDecision = { ...ALLOW_EMPTY, bodyKind: "full" };
    const withUrl = jsonLdFor({ ...FREE, licenseUrl: "https://x/deed" }, allow, ORIGIN) as Record<
      string,
      unknown
    >;
    expect(withUrl.license).toBe("https://x/deed");
    const arr = jsonLdFor(
      { ...FREE, licenseSpdx: "ARR", licenseUrl: null },
      allow,
      ORIGIN,
    ) as Record<string, unknown>;
    expect(arr.license).toBeNull();
    expect(arr.usageInfo).toContain("/api/posts/");
  });
});

describe("payerOf/agentIdOf tails via resolveAccess", () => {
  it("a payerAddress-only agent looks up grants under that address", async () => {
    const seen: string[] = [];
    const ports = stubPorts();
    const kernel = createKernel({
      ...ports,
      grants: {
        ...ports.grants,
        findLiveGrant: async (q) => {
          seen.push(String(q.payer));
          return null;
        },
      },
    });
    const withPayer: Actor = {
      ...HUMAN,
      plane: "agent",
      class: "crawler_agent",
      payerAddress: "0xAbCd",
    } as Actor;
    await kernel.resolveAccess(HFAP, withPayer);
    expect(seen).toEqual(["0xabcd"]);
  });

  it("an agent with no payment and no payerAddress looks up grants under null", async () => {
    const seen: Array<string | null> = [];
    const ports = stubPorts();
    const kernel = createKernel({
      ...ports,
      grants: {
        ...ports.grants,
        findLiveGrant: async (q) => {
          seen.push(q.payer);
          return null;
        },
      },
    });
    const noPayer: Actor = {
      ...HUMAN,
      plane: "agent",
      class: "crawler_agent",
      payerAddress: null,
    } as Actor;
    await kernel.resolveAccess(HFAP, noPayer);
    expect(seen).toEqual([null]);
  });
});

describe("pricingLineFor/toAccessBadge null-price arms", () => {
  it("priceUsd null -> '0.00' on both paid modes", () => {
    const noPriceHfap: Resource = { ...HFAP, priceUsd: null };
    const noPriceGated: Resource = { ...GATED, priceUsd: null };
    expect(pricingLineFor(noPriceHfap)).toContain("0.00 USDC once");
    expect(pricingLineFor(noPriceGated)).toContain("0.00 USDC per fetch");
    expect(toAccessBadge(noPriceHfap).priceUsd).toBe("0.00");
    expect(toAccessBadge(noPriceGated).priceUsd).toBe("0.00");
  });
});
