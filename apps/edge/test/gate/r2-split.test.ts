// apps/edge/test/gate/r2-split.test.ts (T2w) — §17.11.6. The architecture's most
// expensive invariant, proven end-to-end: PAID bytes live in musebook-paid and the
// ONLY way out is a live grant. If this file regresses, paid media leaks for free.
// Adaptations from the doc sketch: bytes are 4 ("PAID", miniflare does not validate
// ranges); seed slugs; seededGrantToken() seeds settlement+grant then returns the
// seeded delegation Bearer (mb_dlg_, which DELEGATION_RE requires).
import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  FREE_KEY,
  PAID_BYTES,
  PAID_KEY,
  PAID_POST,
  seedMediaAsset,
  seededGrantToken,
} from "./helpers.js";

const FREE_POST = "44444444-4444-4444-8444-000000000004"; // seed-article-free
// Grants only exist for human_free_agent_paid — x402_always charges every
// fetch and consults access_grants never (§6.5: "no grant minted" reads both
// ways). The 402-anonymous cell keeps x402 so the challenge fires for a human.
const HFAP_POST = "44444444-4444-4444-8444-000000000005"; // seed-article-hfap
const HFAP_KEY = "m/paid/2026/09/seed-hfap-image.avif";
const HFAP_URL = `https://media.musebook.dev/${HFAP_KEY}`;
const ARTIFACT_KEY = "a/artifacts/2026/09/seed-archive.zip";

const PAID_URL = `https://media.musebook.dev/${PAID_KEY}`;
const FREE_URL = `https://media.musebook.dev/${FREE_KEY}`;

beforeEach(async () => {
  await env.PAID_MEDIA.put(PAID_KEY, PAID_BYTES, {
    httpMetadata: { contentType: "image/avif" },
  });
  await env.PUBLIC_MEDIA.put(FREE_KEY, new TextEncoder().encode("PUBLIC-BYTES"));
  await env.ARTIFACTS.put(ARTIFACT_KEY, new TextEncoder().encode("ARTIFACT"));
  await seedMediaAsset(PAID_KEY, PAID_POST);
  await env.PAID_MEDIA.put(HFAP_KEY, PAID_BYTES, {
    httpMetadata: { contentType: "image/avif" },
  });
  await seedMediaAsset(HFAP_KEY, HFAP_POST);
  await seedMediaAsset(FREE_KEY, FREE_POST, "r2_public");
  await seedMediaAsset(ARTIFACT_KEY, FREE_POST, "r2_artifacts");
});

describe("the split media gate: public, paid and artifacts share one Worker", () => {
  it("a public-bucket object is REFUSED on the paid path", async () => {
    // Free media is served by cdn.musebook.dev straight out of R2 — no Worker in
    // the path at all (§6.12.4). What the Worker owns is the invariant that an
    // r2_public key never rides the paid handler: it 404s rather than paying a
    // Class B read to stream a byte the world already gets for free.
    const res = await SELF.fetch(FREE_URL);
    expect(res.status).toBe(404);
  });

  it("paid media streams through PAID_MEDIA for a FREE post with no grant", async () => {
    // The other half of 'no grant and no decision': an r2_paid object on a
    // free post is allow-decided and streams straight through — the Worker is
    // the egress, the kernel is the only gate.
    const key = "m/paid/2026/09/seed-free-image.avif";
    await env.PAID_MEDIA.put(key, new TextEncoder().encode("FREE-PAID-BUCKET"));
    await seedMediaAsset(key, FREE_POST);
    const res = await SELF.fetch(`https://media.musebook.dev/${key}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("FREE-PAID-BUCKET");
  });

  it("paid media returns a 402 challenge for an anonymous request", async () => {
    const res = await SELF.fetch(PAID_URL);
    expect(res.status).toBe(402);
    expect(res.headers.get("payment-required")).toBeTypeOf("string");
    expect(res.headers.get("cache-control")).toContain("no-store");
    // The paid bytes leave PAID_MEDIA. The 402 body is challenge JSON — 0 media bytes.
    expect((await res.arrayBuffer()).byteLength).toBe(0);
  });

  it("paid media streams through PAID_MEDIA once a grant is presented", async () => {
    const token = await seededGrantToken(HFAP_POST);
    const res = await SELF.fetch(HFAP_URL, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    // §6.5 verbatim: grant_held carries `settlement: null` — PAYMENT-RESPONSE is
    // emitted only at settle time (§33701), so a grant-held fetch adds no header.
    expect(res.headers.get("payment-response")).toBeNull();
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PAID_BYTES);
  });

  it("PAID_MEDIA honours Range but never Set-Cookie, and artifacts pass through", async () => {
    // Range: unauthenticated so this is a 402 — but the Worker must not leak bytes
    // for a partial request either. Grant first, then re-request with a Range.
    const token = await seededGrantToken(HFAP_POST);
    const res = await SELF.fetch(HFAP_URL, {
      headers: { authorization: `Bearer ${token}`, range: "bytes=0-1" },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toMatch(/^bytes 0-1\/\d+$/);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PAID_BYTES.slice(0, 2));
    expect(res.headers.get("set-cookie")).toBeNull();

    // A precondition that fails is a 412 with no body (§7.20 check 23).
    const stale = await SELF.fetch(HFAP_URL, {
      headers: {
        authorization: `Bearer ${token}`,
        "if-match": '"bogus-etag-that-never-matches"',
      },
    });
    expect(stale.status).toBe(412);
    expect(await stale.text()).toBe("");

    // artifacts.musebook.dev hits the same Worker but always through ARTIFACTS.
    // The asset is attached to a FREE post — pass-through, no payment dance.
    const art = await SELF.fetch(`https://artifacts.musebook.dev/${ARTIFACT_KEY}`);
    expect(art.status).toBe(200);
    expect(await art.text()).toBe("ARTIFACT");
  });
});
