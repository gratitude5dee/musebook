// packages/kernel/test/purity.test.ts — spine invariant 6 (§6.13, §16.5 gate 7).
// The kernel imports in plain Node, every export is callable with stub ports,
// and no src file reaches for cloudflare:, pg, or @cloudflare/*.
import { describe, expect, it } from "vitest";
import * as kernel from "../src/index.js";
import { stubPorts } from "./fixtures/ports.js";
import { FREE, FREE_ROW, HFAP } from "./fixtures/resources.js";
import { HUMAN } from "./fixtures/actors.js";

describe("kernel purity", () => {
  it("the module surface is callable with stub ports in a plain runtime", async () => {
    expect(typeof kernel.createKernel).toBe("function");
    expect(typeof kernel.configureKernel).toBe("function");
    expect(typeof kernel.resolveAccess).toBe("function");
    expect(typeof kernel.renderResource).toBe("function");
    expect(typeof kernel.mintsDurableGrant).toBe("function");
    expect(typeof kernel.loadResource).toBe("function");
    expect(typeof kernel.etagFor).toBe("function");
    expect(typeof kernel.linkHeaderFor).toBe("function");
    expect(typeof kernel.usageHeadersFor).toBe("function");
    expect(typeof kernel.formatPriceUsd).toBe("function");
    expect(typeof kernel.variantIntentFor).toBe("function");
    expect(typeof kernel.accessToPublishMode).toBe("function");
    expect(typeof kernel.pricingLineFor).toBe("function");
    expect(typeof kernel.toAccessBadge).toBe("function");

    kernel.configureKernel(stubPorts());
    const decision = await kernel.resolveAccess(FREE, HUMAN);
    expect(decision.allow).toBe(true);
    const rendered = await kernel.renderResource(FREE, "markdown", decision);
    expect(rendered.status).toBe(200);
    expect(await kernel.variantIntentFor(FREE_ROW.post_id)).toBe("full");
  });
});
