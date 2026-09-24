// apps/edge/test/artifacts.test.ts — M16 gates 2/5/6: the §2.8 headers on a
// real response, the ticket arm with no database, and that no session cookie
// can reach the artifact origin's trust boundary.
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  importTicketSigningKey,
  mintTicket,
  type TicketClaims,
} from "@musebook/artifacts";
import { serveArtifact } from "../src/artifacts.js";

const VERSION = "0123456789abcdef";
const ART_ID = "55555555-5555-4555-8555-555555555555";

const EXPECTED_HEADERS: Record<string, string> = {
  "content-security-policy":
    "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; " +
    "style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; " +
    "font-src 'self' data:; media-src 'self' blob:; connect-src 'self'; " +
    "frame-ancestors https://musebook.dev https://www.musebook.dev; " +
    "base-uri 'none'; form-action 'none'",
  "cross-origin-resource-policy": "same-site",
  "cross-origin-opener-policy": "same-origin",
  "x-content-type-options": "nosniff",
  "permissions-policy":
    "camera=(), microphone=(), geolocation=(), payment=(), usb=(), xr-spatial-tracking=()",
};

function assertArtifactHeaders(res: Response): void {
  for (const [name, value] of Object.entries(EXPECTED_HEADERS)) {
    expect(res.headers.get(name), name).toBe(value);
  }
}

async function putArtifact(key: string, body: string, contentType = "text/html"): Promise<void> {
  await env.ARTIFACTS.put(key, body, { httpMetadata: { contentType } });
}

describe("M16.2 — §2.8 headers on real responses", () => {
  it("stamps all five headers on a public artifact response", async () => {
    await putArtifact(`a/public/${VERSION}/index.html`, "<html>hi</html>");
    const res = await SELF.fetch(
      `https://${env.ARTIFACT_HOST}/a/${ART_ID}/${VERSION}/index.html`,
    );
    expect(res.status).toBe(200);
    assertArtifactHeaders(res);
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await res.text()).toBe("<html>hi</html>");
  });

  it("stamps the same headers on a 404 — headers ride every response", async () => {
    const res = await SELF.fetch(
      `https://${env.ARTIFACT_HOST}/a/${ART_ID}/${VERSION}/does-not-exist.html`,
    );
    expect(res.status).toBe(404);
    assertArtifactHeaders(res);
  });
});

describe("M16.5 — ticket arm, no database", () => {
  /** Ephemeral Ed25519 pair minted per run — no secret material in tests. */
  async function ephemeralKeys(): Promise<{ signing: CryptoKey; pubPem: string }> {
    const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
    const spki = await crypto.subtle.exportKey("spki", pair.publicKey);
    const b64 = btoa(String.fromCharCode(...new Uint8Array(spki)));
    return {
      signing: pair.privateKey,
      pubPem: `-----BEGIN PUBLIC KEY-----\n${b64}\n-----END PUBLIC KEY-----`,
    };
  }

  function envWith(pubPem: string): Env {
    return Object.assign(Object.create(env), { ARTIFACT_TICKET_PUBLIC_KEY: pubPem });
  }

  const CLAIMS = (exp: number): TicketClaims => ({
    a: ART_ID,
    v: VERSION,
    ch: "deadbeef".repeat(8),
    s: "user:11111111-1111-4111-8111-000000000001",
    exp,
  });

  it("serves a private artifact to a valid ticket, 404s forged/expired/wrong artifact", async () => {
    const { signing, pubPem } = await ephemeralKeys();
    const e = envWith(pubPem);
    const ctx = { exports: {}, waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
    const key = `a/private/${VERSION}/index.html`;
    await putArtifact(key, "<html>paid</html>", "text/html");

    const good = await mintTicket(signing, CLAIMS(Math.floor(Date.now() / 1000) + 300));
    const res = await serveArtifact(
      new Request(`https://${env.ARTIFACT_HOST}/t/${good}/a/${ART_ID}/${VERSION}/index.html`),
      e,
      ctx,
    );
    expect(res.status).toBe(200);
    assertArtifactHeaders(res);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(await res.text()).toBe("<html>paid</html>");

    // Forged signature → 404 (validity stays an oracle).
    const forged = `${good.slice(0, -2)}AA`;
    const resBad = await serveArtifact(
      new Request(`https://${env.ARTIFACT_HOST}/t/${forged}/a/${ART_ID}/${VERSION}/index.html`),
      e,
      ctx,
    );
    expect(resBad.status).toBe(404);
    assertArtifactHeaders(resBad);

    // Expired ticket → 404.
    const stale = await mintTicket(signing, CLAIMS(Math.floor(Date.now() / 1000) - 60));
    const resStale = await serveArtifact(
      new Request(`https://${env.ARTIFACT_HOST}/t/${stale}/a/${ART_ID}/${VERSION}/index.html`),
      e,
      ctx,
    );
    expect(resStale.status).toBe(404);

    // Valid ticket pinned to a DIFFERENT artifact → 404.
    const other = await mintTicket(signing, {
      ...CLAIMS(Math.floor(Date.now() / 1000) + 300),
      a: "66666666-6666-4666-8666-666666666666",
    });
    const resOther = await serveArtifact(
      new Request(`https://${env.ARTIFACT_HOST}/t/${other}/a/${ART_ID}/${VERSION}/index.html`),
      e,
      ctx,
    );
    expect(resOther.status).toBe(404);
  });

  it("imports the real PEM form a pkcs8 secret round-trips into", async () => {
    // The worker holds the PKCS#8 PEM as a secret; the edge only the SPKI PEM.
    const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
    const pkcs8 = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
    const b64 = btoa(String.fromCharCode(...new Uint8Array(pkcs8)));
    const key = await importTicketSigningKey(
      `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----`,
    );
    const ticket = await mintTicket(key, CLAIMS(Math.floor(Date.now() / 1000) + 300));
    expect(ticket.split(".")).toHaveLength(2);
  });
});

describe("M16.6 — host-only session", () => {
  it("sends no session state to the artifact host (path has no cookie-bearing route)", async () => {
    // The artifact host path is /a/…/t/… ONLY — any other path 404s with the
    // §2.8 headers still on, so no cookie-bearing page exists on this origin.
    const res = await SELF.fetch(`https://${env.ARTIFACT_HOST}/`);
    expect(res.status).toBe(404);
    assertArtifactHeaders(res);
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});
