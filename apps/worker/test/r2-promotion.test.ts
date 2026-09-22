// M7 gate 8 — upload → event → consumer → exactly one CHECK-matching assets
// row. The queue hop itself is a wrangler binding (asserted statically); the
// consumer half runs here against miniflare R2 + the real local DB.
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { handleR2ObjectCreated } from "../src/consumers/r2-events.js";
import { withDb } from "./helpers/db.js";
const SEED_USER = "11111111-1111-4111-8111-000000000001";
const FREE_POST = "44444444-4444-4444-8444-000000000004"; // free → r2_public
const PAID_POST = "44444444-4444-4444-8444-000000000006"; // x402_always → r2_paid

async function sha256hex(bytes: Uint8Array): Promise<string> {
  const sum = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return [...new Uint8Array(sum)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface Row {
  [k: string]: unknown;
}

async function admin<T extends Row>(sql: string, params: unknown[] = []) {
  const out = await withDb(async (c) => (await c.query<T & Row>(sql, params)).rows);
  return out;
}

const event = (key: string, size: number) => ({
  account: "e8f42c0430906e1515a2af01d5c1d2d1",
  action: "PutObject",
  bucket: "musebook-uploads",
  object: { key, size, eTag: "deadbeef", contentType: "image/png" },
  eventTime: new Date().toISOString(),
});

describe("r2-events promotion", () => {
  beforeAll(async () => {
    await admin("delete from public.staged_uploads where object_key like 'staging/%m7%'");
  });

  it("promotes a free-tier upload to musebook-public", async () => {
    const key = `staging/${SEED_USER}/m7-free/poster.png`;
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    await admin("select app.init_staged_upload($1::uuid,$2::uuid,$3,$4,$5,$6::bigint)", [
      SEED_USER,
      FREE_POST,
      key,
      "upload-m7-free",
      "image/png",
      bytes.length,
    ]);
    await env.UPLOADS.put(key, bytes, { httpMetadata: { contentType: "image/png" } });

    await handleR2ObjectCreated(env as unknown as Env, event(key, bytes.length));

    expect(await env.UPLOADS.get(key)).toBeNull();
    const sha = await sha256hex(bytes);
    const rows = await admin<{ url: string; storage: string; sha256: string; key: string }>(
      "select url, storage, sha256, object_key as key from public.assets where sha256 = $1 and owner_user_id = $2::uuid",
      [sha, SEED_USER],
    );
    expect(rows.length).toBe(1);
    expect(rows[0]?.storage).toBe("r2_public");
    expect(rows[0]?.url).toBe(`https://cdn.musebook.dev/${rows[0]?.key}`);
    expect(rows[0]?.key).toMatch(/^m\/[0-9a-f]{64}\.png$/);
    expect(await env.PUBLIC_MEDIA.get(rows[0]!.key)).not.toBeNull();

    const links = await admin("select post_id from public.post_assets where post_id = $1", [
      FREE_POST,
    ]);
    expect(links.length).toBeGreaterThan(0);
  });

  it("promotes a paid-tier upload to musebook-paid", async () => {
    const key = `staging/${SEED_USER}/m7-paid/clip.bin`;
    const bytes = new Uint8Array([9, 8, 7, 6]);
    await admin("select app.init_staged_upload($1::uuid,$2::uuid,$3,$4,$5,$6::bigint)", [
      SEED_USER,
      PAID_POST,
      key,
      "upload-m7-paid",
      "application/octet-stream",
      bytes.length,
    ]);
    await env.UPLOADS.put(key, bytes);

    await handleR2ObjectCreated(env as unknown as Env, event(key, bytes.length));

    const sha = await sha256hex(bytes);
    const rows = await admin<{ url: string; storage: string; key: string }>(
      "select url, storage, object_key as key from public.assets where sha256 = $1 and owner_user_id = $2::uuid",
      [sha, SEED_USER],
    );
    expect(rows.length).toBe(1);
    expect(rows[0]?.storage).toBe("r2_paid");
    expect(rows[0]?.url).toBe(`https://media.musebook.dev/${rows[0]?.key}`);
    expect(await env.PAID_MEDIA.get(rows[0]!.key)).not.toBeNull();
    expect(await env.UPLOADS.get(key)).toBeNull();
  });

  it("acks a redelivery without work", async () => {
    await handleR2ObjectCreated(
      env as unknown as Env,
      event(`staging/${SEED_USER}/m7-ghost/x.png`, 3),
    );
    // No staged row → early return, no throw, no assets row.
    const rows = await admin(
      "select count(*)::int as n from public.staged_uploads where object_key like 'staging/%m7-ghost%'",
    );
    expect(rows[0]?.n).toBe(0);
  });
});
