// packages/kernel/test/golden.test.ts — the 24 golden fixtures (§6.13, §17.4).
// 3 publish modes x 2 actor planes x 4 body-carrying representations. The .snap
// files are written by hand ahead of the implementation; the generated barrel
// makes the same bytes available to the workerd tier, which has no node:fs.
import { describe, expect, it } from "vitest";
import { createKernel } from "../src/index.js";
import { stubPorts } from "./fixtures/ports.js";
import { FREE, HFAP, GATED, SECRET_MARKER } from "./fixtures/resources.js";
import { HUMAN, AGENT } from "./fixtures/actors.js";
import { GOLDEN } from "./golden/index.js";
import { jsonLdFor } from "../src/render/jsonld.js";
import { renderFeed } from "../src/render/feed.js";
import { ORIGIN } from "./fixtures/ports.js";

const MODES = [
  ["free", FREE],
  ["hfap", HFAP],
  ["gated", GATED],
] as const;
const ACTORS = [
  ["human", HUMAN],
  ["agent", AGENT],
] as const;
const REPS = ["html", "markdown", "json", "mcp"] as const;

describe("kernel golden fixtures (3 modes x 2 actors x 4 representations)", () => {
  const kernel = createKernel(stubPorts());

  for (const [modeName, resource] of MODES) {
    for (const [actorName, actor] of ACTORS) {
      for (const rep of REPS) {
        it(`${modeName} / ${actorName} / ${rep}`, async () => {
          const decision = await kernel.resolveAccess(resource, actor);
          const rendered = await kernel.renderResource(resource, rep, decision);

          const fixtureName = `${modeName}__${actorName}__${rep}`;
          const actual = [
            String(rendered.status),
            rendered.mediaType,
            `cache: ${decision.cache.shared ? "public" : "private"}, ${rendered.headers["cache-control"] ?? rendered.headers["Cache-Control"]}`,
            "---",
            rendered.body,
          ].join("\n");
          expect(actual).toBe(GOLDEN[fixtureName]);

          // The invariant no snapshot can express: gated bytes never appear in a denied body.
          if (!decision.allow) {
            expect(rendered.body).not.toContain(SECRET_MARKER);
          }

          // §17.4 rule 3: body and structured are projections of one value.
          if (rep === "json") {
            expect(JSON.parse(rendered.body)).toEqual(rendered.structured);
          }
        });
      }
    }
  }

  // Gate check M5.2, as a named slice: every denied body across the whole
  // matrix, not just inside the snapshot comparison.
  it("SECRET_MARKER: no denied body contains MUSEBOOK_PAID_BODY_MARKER_7f3a", async () => {
    const kernel = createKernel(stubPorts());
    for (const [, resource] of MODES) {
      for (const [, actor] of ACTORS) {
        const decision = await kernel.resolveAccess(resource, actor);
        if (decision.allow) continue;
        for (const rep of REPS) {
          const rendered = await kernel.renderResource(resource, rep, decision);
          expect(rendered.body).not.toContain(SECRET_MARKER);
          expect(rendered.body).not.toContain("MUSEBOOK_PAID_BODY_MARKER_7f3a");
        }
      }
    }
  });
});

describe("jsonld assertions (3 modes x 2 actors)", () => {
  const kernel = createKernel(stubPorts());

  for (const [modeName, resource] of MODES) {
    for (const [actorName, actor] of ACTORS) {
      it(`${modeName} / ${actorName}`, async () => {
        const decision = await kernel.resolveAccess(resource, actor);
        const doc = jsonLdFor(resource, decision, ORIGIN) as Record<string, unknown>;
        const gated = modeName === "gated";
        // x402_always emits isAccessibleForFree:false + hasPart when denied;
        // human_free_agent_paid stays `true` even on a 402 — the page is free to humans.
        expect(doc.isAccessibleForFree).toBe(!gated || decision.allow);
        if (!decision.allow && gated) {
          expect(doc.hasPart).toEqual({
            "@type": "WebPageElement",
            isAccessibleForFree: false,
            cssSelector: ".musebook-paywall",
          });
        } else {
          expect(doc.hasPart).toBeUndefined();
        }
      });
    }
  }
});

describe("feed assertions (3 modes): content_text is the summary, never a body", () => {
  for (const [modeName, resource] of MODES) {
    it(modeName, () => {
      const item = renderFeed(resource, ORIGIN) as { content_text: string };
      expect(item.content_text).toBe(resource.summary);
    });
  }
});
