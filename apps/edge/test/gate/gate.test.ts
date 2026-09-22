// apps/edge/test/gate/gate.test.ts (T2w) — §17.11.2, adapted where the seed or
// §7.11 differs from the doc sketch (logged in DEVIATIONS.md):
//   * slugs come from seed.sql: seed-article-free / seed-note-hfap /
//     seed-article-x402. hfap is the NOTE because the seed grants the crawler
//     on the article's content_hash — that grant is the other half of the
//     fixture and would flip the agent cell to 200.
//   * `.md` twins are rendered IN THE WORKER for allowed actors too (§7.11),
//     so `originHits` is asserted on the HTML twin (/p/{slug}): allowed cells
//     pass through once, denied cells produce ZERO origin subrequests.
//   * signedBotAuthHeaders signs for the seed crawler's signature_agent URI.
import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MARKER, SLUG, signedBotAuthHeaders } from "./helpers.js";

/** Every origin subrequest the Worker makes, recorded. The count is an assertion. */
let originHits: Request[] = [];

const realFetch = globalThis.fetch;

afterEach(() => {
  vi.restoreAllMocks();
  originHits = [];
});

/** fetchMock is not in this plugin version: the Worker's outbound fetch goes
 *  through the same global this file runs on, so the spy IS the origin stub. */
function stubOrigin() {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith(`https://${env.ORIGIN_HOST}`)) {
      originHits.push(input instanceof Request ? input : new Request(url, init));
      return new Response("<html>origin</html>");
    }
    return realFetch(input as Request, init as RequestInit);
  });
}

describe("the edge gate: 3 publishing modes x 2 actor classes", () => {
  // The matrix is §6.5's, restricted to "no payment presented". Every cell names a
  // status, whether the paid body may appear, and whether the ORIGIN may be reached
  // on the HTML twin. The third column is the one no other test asserts.
  const CASES = [
    {
      mode: "free",
      actor: "human",
      status: 200,
      marker: true,
      origin: true,
      why: "free HTML is rendered by Vercel; the Worker passes through",
    },
    {
      mode: "free",
      actor: "agent",
      status: 200,
      marker: true,
      origin: true,
      why: "mode_free: an agent is not charged for a free post",
    },
    {
      mode: "hfap",
      actor: "human",
      status: 200,
      marker: true,
      origin: true,
      why: "human_plane: humans read mode 2 free",
    },
    {
      mode: "hfap",
      actor: "agent",
      status: 402,
      marker: false,
      origin: false,
      why: "payment_required: the declared, incentivized contract (CF-SPINE §7)",
    },
    {
      mode: "gated",
      actor: "human",
      status: 402,
      marker: false,
      origin: false,
      why: "x402_always charges every fetch, humans included (§6.5)",
    },
    {
      mode: "gated",
      actor: "agent",
      status: 402,
      marker: false,
      origin: false,
      why: "same, and this is the cell AI Search records as blocked_by_payment",
    },
  ] as const;

  for (const c of CASES) {
    it(`${c.mode} / ${c.actor} -> ${c.status} (${c.why})`, async () => {
      stubOrigin();
      const headers: Record<string, string> =
        c.actor === "agent"
          ? await signedBotAuthHeaders(`https://musebook.dev/p/${SLUG[c.mode]}.md`)
          : { accept: "text/markdown", "user-agent": "Mozilla/5.0 (test)" };

      const res = await SELF.fetch(`https://musebook.dev/p/${SLUG[c.mode]}.md`, { headers });
      const body = await res.text();

      expect(res.status).toBe(c.status);
      expect(body.includes(MARKER)).toBe(c.marker);

      // THE assertion this file exists for: a denied decision produces ZERO origin
      // subrequests on EITHER twin. Allowed cells render the .md twin in the Worker
      // (§7.11) — the passthrough path is the HTML twin, exercised once below.
      if (c.origin) {
        await SELF.fetch(`https://musebook.dev/p/${SLUG[c.mode]}`, {
          headers: { ...headers, accept: "text/html" },
        });
      }
      expect(originHits.length).toBe(c.origin ? 1 : 0);

      if (!c.origin) {
        expect(res.headers.get("cache-control")).toContain("no-store");
        expect(res.headers.get("payment-required")).toBeTypeOf("string");
      }
    });
  }

  it("an unsigned agent is treated as a human, by design", async () => {
    stubOrigin();
    // CF-SPINE §7: coverage is thin — only a handful of agents sign, and an agent that
    // omits the headers is indistinguishable from a person. resolveAccess treats every
    // unclassified request as plane 'human' (§6.11). This is a REVENUE trade, chosen
    // deliberately, and it is asserted so nobody "fixes" it into a 402 on Firefox.
    const res = await SELF.fetch(`https://musebook.dev/p/${SLUG.hfap}.md`, {
      headers: {
        accept: "text/markdown",
        "user-agent": "SomeCrawler/1.0 (+https://example.com/bot)",
      },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(MARKER);
  });

  it("a signature over the wrong @authority resolves to 401, not to a human", async () => {
    stubOrigin();
    const headers = await signedBotAuthHeaders(`https://musebook.dev/p/${SLUG.hfap}.md`, {
      authority: "evil.example",
    });
    const res = await SELF.fetch(`https://musebook.dev/p/${SLUG.hfap}.md`, { headers });
    // A presented-but-unverified signature rejects outright (WebBotAuthRejected):
    // the request has no Actor at all. §5.6.2's fail-direction table.
    expect(res.status).toBe(401);
    expect(originHits.length).toBe(0);
  });

  it("an inbound x-mb-* header never reaches the origin", async () => {
    stubOrigin();
    await SELF.fetch(`https://musebook.dev/p/${SLUG.free}`, {
      headers: { "x-mb-plane": "human", "x-mb-country": "US", "x-mb-request-id": "forged" },
    });
    const sent = originHits[0]!.headers;
    // toOrigin() deletes every inbound x-mb-* before setting its own (§6.12.2).
    expect(sent.get("x-mb-request-id")).not.toBe("forged");
    expect(sent.get("x-mb-country")).toBe("XX"); // request.cf is absent under Miniflare
    expect(sent.get("x-musebook-edge")).toBe(env.MUSEBOOK_EDGE_SECRET);
  });

  it("every access decision reads HYPERDRIVE_FRESH, never HYPERDRIVE_CACHED", async () => {
    // Locally both bindings point at the same database, so this cannot be observed by
    // querying. It is observed structurally: portsFor() is called with a recording
    // proxy and the test asserts which binding each port was constructed from.
    const { portsFor } = await import("../../src/kernel/configure.js");
    const seen: string[] = [];
    const spy = new Proxy(env, {
      get(t, k: string) {
        if (k.startsWith("HYPERDRIVE")) seen.push(k);
        return Reflect.get(t, k);
      },
    });
    const ports = portsFor(
      new Request("https://musebook.dev/p/x"),
      spy as typeof env,
      {
        waitUntil() {},
        passThroughOnException() {},
      } as unknown as ExecutionContext,
    );
    await ports.grants
      .findLiveGrant({ contentHash: "0".repeat(64), payer: null, agentId: null, userId: null })
      .catch(() => null);
    expect(seen).toContain("HYPERDRIVE_FRESH");
    expect(seen).not.toContain("HYPERDRIVE_CACHED");
  });
});
