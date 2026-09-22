// apps/edge/test/gate/origin-lockdown.test.ts — §17.11.3's end-to-end half,
// and the local form of §16 GATE M6 check 1. Both directions, in one file:
//   1. a request through the Worker reaches the origin BECAUSE toOrigin sets
//      x-musebook-edge — asserted by feeding the Worker's real outbound
//      Request into the real apps/web/proxy.ts;
//   2. a request straight at the origin without the secret is 404, and with a
//      wrong secret is 404 — so the check proves a comparison, not a header.
// The proxy logic is shimmed only at its `next/server` import (the stub in
// test/stubs/next-server.ts); `process.env` is stubGlobal'd for the same
// reason — everything else in the file under test is verbatim Vercel code.
import { env, SELF } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "../../../web/proxy.js";
import { SLUG } from "./helpers.js";

const realFetch = globalThis.fetch;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Run the real proxy.ts against an inbound request, return its Response. */
function runProxy(request: Request): Response {
  // NextRequest is the shim's Request subclass; proxy.ts reads nextUrl +
  // headers off it, so the inbound Request is re-built with its URL + headers.
  return proxy(
    new NextRequest(request.url, {
      method: request.method,
      headers: request.headers,
    }) as never,
  ) as unknown as Response;
}

beforeAll(() => {
  vi.stubGlobal("process", {
    env: {
      VERCEL_ENV: "production",
      MUSEBOOK_EDGE_SECRET: "test-edge-secret-0000",
      MUSEBOOK_EDGE_SECRET_PREVIOUS: "",
    },
  });
});

describe("the origin lockdown, end to end through the real proxy.ts", () => {
  it("a Worker-forwarded request passes proxy.ts; a direct hit without the secret is 404", async () => {
    // Intercept the Worker's toOrigin subrequest and run it through the real
    // proxy.ts — the assertion is the secret TRAVELLING, which a stub origin
    // that always answers 200 cannot show.
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith(`https://${env.ORIGIN_HOST}`)) {
        const req = input instanceof Request ? input : new Request(url, init);
        const verdict = runProxy(req);
        // NextResponse.next() means "let it through": answer as the origin.
        if (verdict.status === 404) return verdict;
        return new Response("<html>origin</html>", { status: 200 });
      }
      return realFetch(input as Request, init as RequestInit);
    });

    // 1. Through the Worker: toOrigin sets the secret → proxy lets it pass.
    const res = await SELF.fetch(`https://musebook.dev/p/${SLUG.free}`, {
      headers: { accept: "text/html", "user-agent": "Mozilla/5.0 (test)" },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("origin");

    // 2. Straight at the origin (no header, wrong header): the real
    //    comparison in proxy.ts 404s both — the paywall is not bypassable at
    //    <project>.vercel.app.
    for (const bad of [undefined, "not-the-secret", "test-edge-secret-00000"]) {
      const direct = new Request(`https://${env.ORIGIN_HOST}/p/${SLUG.free}`, {
        headers: bad ? { "x-musebook-edge": bad } : {},
      });
      const verdict = runProxy(direct);
      expect(verdict.status).toBe(404);
    }
  });
});
