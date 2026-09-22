// M7 gates 1, 2, 3, 5, 6 — the compose → publish wire path end to end:
//   draft via PostgREST save_draft (user JWT) → publish via SELF POST
//   /api/posts/{id}/publish → post + outbox + twin asserts → presigned upload
//   against the REAL musebook-uploads bucket (R2 creds from the gate env).
import { AwsClient } from "aws4fetch";
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { db } from "./helpers.js";

const SUPA = "http://127.0.0.1:54321";
const PUB_KEY = "sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH";
const JWT_SECRET = "super-secret-jwt-token-with-at-least-32-characters-long";
const SEED_USER = "11111111-1111-4111-8111-000000000001";
const SESSION = "mb_session=musebook-seed-session-token-0001";
const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

const b64u = (buf: ArrayBuffer | Uint8Array): string => {
  const u8 = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
  let s = "";
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

/** A minimal HS256 user JWT — same claims /api/auth/supabase-token mints. */
async function userJwt(sub: string): Promise<string> {
  const enc = new TextEncoder();
  const header = b64u(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = b64u(
    enc.encode(
      JSON.stringify({
        iss: `${SUPA}/auth/v1`,
        sub,
        aud: "authenticated",
        role: "authenticated",
        exp: Math.floor(Date.now() / 1000) + 600,
        iat: Math.floor(Date.now() / 1000),
      }),
    ),
  );
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(JWT_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64u(sig)}`;
}

async function rpc<T>(fn: string, token: string, params: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${SUPA}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      apikey: PUB_KEY,
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(params),
  });
  const body = (await res.json().catch(() => null)) as { code?: string } | T;
  if (!res.ok) throw new Error(`rpc ${fn}: ${res.status} ${JSON.stringify(body)}`);
  return body as T;
}

interface DraftRow {
  post_id: string;
  slug: string;
  version: number;
  content_hash: string;
}

async function draft(
  jwt: string,
  access: "free" | "human_free_agent_paid" | "x402_always",
  priceAtomic: string,
  kind = "note",
): Promise<DraftRow> {
  const rows = await rpc<DraftRow[]>("save_draft", jwt, {
    p_post_id: null,
    p_markdown: `# Gate ${uniq} ${access} ${crypto.randomUUID().slice(0, 8)}\n\nBody for ${access}.\n`,
    p_title: `Gate ${uniq} ${access}`,
    p_kind: kind,
    p_access_mode: access,
    p_price_atomic: priceAtomic,
    p_license_spdx: "CC-BY-4.0",
    p_tags: ["gate", "m7"],
  });
  const row = rows[0];
  if (row === undefined) throw new Error("save_draft returned no row");
  return row;
}

describe("M7.1 — compose → publish through all three modes", () => {
  it("publishes three posts with three distinct modes that all render", async () => {
    const jwt = await userJwt(SEED_USER);
    const posts: { access: string; id: string; slug: string }[] = [];
    for (const [access, price] of [
      ["free", "0"],
      ["human_free_agent_paid", "1000000"],
      ["x402_always", "1500000"],
    ] as const) {
      const d = await draft(jwt, access, price);
      const res = await SELF.fetch(`https://musebook.dev/api/posts/${d.post_id}/publish`, {
        method: "POST",
        headers: { cookie: SESSION, "content-type": "application/json" },
        body: JSON.stringify({ platforms: [] }),
      });
      expect(res.status, `publish ${access}`).toBe(200);
      posts.push({ access, id: d.post_id, slug: d.slug });
    }

    // Three rows, three distinct column values, on the wire.
    const rows = await db<{ publish_mode: string; status: string }>(
      "select publish_mode, status from public.posts where id = any($1::uuid[])",
      [posts.map((p) => p.id)],
    );
    expect(new Set(rows.map((r) => r.publish_mode)).size).toBe(3);
    expect(rows.every((r) => r.status === "published")).toBe(true);

    // All three render through the Worker's JSON twin.
    for (const p of posts) {
      const twin = await SELF.fetch(`https://musebook.dev/p/${p.slug}.json`);
      // x402_always answers 402 (payment required) for an unpaid fetcher;
      // open/toll render 200. Both carry accessBadge in the doc.
      expect([200, 402], `twin ${p.slug}`).toContain(twin.status);
      if (twin.status === 200) {
        const doc = (await twin.json()) as { accessBadge?: { kind?: string } };
        expect(["open", "toll", "gated"]).toContain(doc.accessBadge?.kind);
      }
    }
  }, 60_000);
});

describe("M7.5 — publish is one statement", () => {
  it("leaves exactly two queued classify+embed outbox rows", async () => {
    const jwt = await userJwt(SEED_USER);
    const d = await draft(jwt, "free", "0");
    const res = await SELF.fetch(`https://musebook.dev/api/posts/${d.post_id}/publish`, {
      method: "POST",
      headers: { cookie: SESSION, "content-type": "application/json" },
      body: JSON.stringify({ platforms: [] }),
    });
    expect(res.status).toBe(200);
    const rows = await db<{ n: number }>(
      `select count(*)::int as n from public.job_outbox
        where kind in ('classify','embed') and state = 'queued'
          and payload->>'post_id' = $1`,
      [d.post_id],
    );
    expect(rows[0]?.n).toBe(2);
  }, 30_000);
});

describe("M7.6 — slugs are globally unique on the wire", () => {
  it("two posts with the same title get two distinct slugs", async () => {
    const jwt = await userJwt(SEED_USER);
    const a = await draft(jwt, "free", "0");
    const b = await draft(jwt, "free", "0"); // same title via draft()
    expect(a.slug).not.toBe(b.slug);
  }, 30_000);
});

describe("M7.2/3 — presign lands in musebook-uploads only, TTL 900", () => {
  it("refuses a foreign bucket, mints the scoped URL, PUTs real bytes", async () => {
    const d = await draft(await userJwt(SEED_USER), "free", "0", "video");

    // Any bucket name that isn't musebook-uploads is refused before signing.
    const refused = await SELF.fetch("https://musebook.dev/api/uploads/init", {
      method: "POST",
      headers: { cookie: SESSION, "content-type": "application/json" },
      body: JSON.stringify({
        filename: "clip.mp4",
        contentType: "video/mp4",
        byteLen: 8,
        postId: d.post_id,
        bucket: "musebook-paid",
      }),
    });
    expect(refused.status).toBe(400);

    const init = await SELF.fetch("https://musebook.dev/api/uploads/init", {
      method: "POST",
      headers: { cookie: SESSION, "content-type": "application/json" },
      body: JSON.stringify({
        filename: "clip.mp4",
        contentType: "video/mp4",
        byteLen: 8,
        postId: d.post_id,
        bucket: "musebook-uploads",
      }),
    });
    expect(init.status).toBe(200);
    const { key, uploadId, partSize, parts } = (await init.json()) as {
      key: string;
      uploadId: string;
      partSize: number;
      parts: number;
    };
    expect(key).toMatch(/^staging\/11111111-1111-4111-8111-000000000001\//);

    const sign = await SELF.fetch(`https://musebook.dev/api/uploads/sign-part`, {
      method: "POST",
      headers: { cookie: SESSION, "content-type": "application/json" },
      body: JSON.stringify({ key, uploadId, partNumber: 1 }),
    });
    expect(sign.status).toBe(200);
    const { url } = (await sign.json()) as { url: string };
    const u = new URL(url);
    expect(u.host).toBe(`${env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`);
    expect(u.pathname).toBe(`/musebook-uploads/${key}`);
    expect(u.searchParams.get("X-Amz-Expires")).toBe("900");

    // A real PUT to the real bucket — presigned S3 end to end.
    const put = await fetch(url, { method: "PUT", body: new Uint8Array(8) });
    expect(put.status).toBe(200);
    const etag = put.headers.get("etag") ?? "";
    expect(etag.length).toBeGreaterThan(0);

    // M7.3's replay-after-expiry: sign the same PUT with a datetime two days
    // in the past — X-Amz-Expires=900 already lapsed → 403 ExpiredRequest,
    // and the error carries no CORS headers (the client refreshes rather
    // than parse the failure body).
    const past = new Date(Date.now() - 2 * 86_400_000).toISOString().replace(/[:-]|\.\d{3}/g, "");
    const expiredUrl = (
      await new AwsClient({
        accessKeyId: (env as { R2_ACCESS_KEY_ID: string }).R2_ACCESS_KEY_ID,
        secretAccessKey: (env as { R2_SECRET_ACCESS_KEY: string }).R2_SECRET_ACCESS_KEY,
        service: "s3",
        region: "auto",
      }).sign(new Request(u, { method: "PUT" }), {
        aws: { signQuery: true, datetime: past },
      })
    ).url;
    const replay = await fetch(expiredUrl, { method: "PUT", body: new Uint8Array(8) });
    expect(replay.status).toBe(403);
    expect(await replay.text()).toContain("ExpiredRequest");
    expect(replay.headers.get("access-control-allow-origin")).toBeNull();

    const complete = await SELF.fetch("https://musebook.dev/api/uploads/complete", {
      method: "POST",
      headers: { cookie: SESSION, "content-type": "application/json" },
      body: JSON.stringify({
        key,
        uploadId,
        postId: d.post_id,
        parts: [{ PartNumber: 1, ETag: etag }],
      }),
    });
    expect(complete.status).toBe(200);

    const staged = await db<{ post_id: string | null }>(
      "select post_id from public.staged_uploads where object_key = $1",
      [key],
    );
    expect(staged[0]?.post_id).toBe(d.post_id);
    void partSize;
  }, 60_000);
});
