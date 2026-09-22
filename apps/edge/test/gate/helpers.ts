// apps/edge/test/gate/helpers.ts — fixtures for the T2w gate tier.
// Everything here writes REAL rows to the local Supabase through the
// HYPERDRIVE_FRESH connection string (the alias in vitest.gate.config.ts maps
// `pg` to the postgres.js shim — real queries, inside workerd).
import { env } from "cloudflare:test";
import pg from "pg";
import { sign } from "web-bot-auth";
import { signerFromJWK } from "web-bot-auth/crypto";

export const MARKER = "MUSEBOOK_PAID_BODY_MARKER_7f3a";

/** The seed's three articles, one per publish_mode (§17.3.2 slugs, not the
 *  §17.11.2 doc names — seed wins). hfap uses the NOTE, not the article: the
 *  seed ships a live grant for the crawler on seed-article-hfap's content_hash
 *  (so the grant-holder path is testable), which would make the agent cell
 *  200 where the matrix expects 402. */
export const SLUG = {
  free: "seed-article-free",
  hfap: "seed-note-hfap",
  gated: "seed-article-x402",
} as const;

export const SEED_CRAWLER_DIR =
  "https://agent.example/.well-known/http-message-signatures-directory";
export const SEED_CRAWLER_ORIGIN = "https://agent.example";
export const DELEGATED_AGENT_ID = "33333333-3333-4333-8333-000000000001";
export const DELEGATED_WALLET = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
export const DLG_TOKEN = "mb_dlg_seed_delegation_token_0001";

export const PAID_POST = "44444444-4444-4444-8444-000000000006"; // seed-article-x402
export const PAID_KEY = "m/paid/2026/09/seed-paid-image.avif";
export const FREE_KEY = "m/public/2026/09/seed-poster.avif";
export const PAID_BYTES = new Uint8Array([0x50, 0x41, 0x49, 0x44]); // "PAID"

/** Fixture writes go through the admin URL, NOT the binding: the env bindings
 *  connect as musebook_worker (prod parity — the app path exercises real RLS),
 *  while a fixture INSERT is test setup that predates the system under test. */
export const ADMIN_DB_URL = "postgres://postgres:postgres@127.0.0.1:54322/postgres";

export async function db<T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  const client = new pg.Client({ connectionString: ADMIN_DB_URL });
  await client.connect();
  try {
    const { rows } = await client.query<T>(sql, params as unknown[]);
    return rows;
  } finally {
    await client.end();
  }
}

/**
 * signedBotAuthHeaders() — §17.11.2. Sign `url` with a fresh Ed25519 key and
 * seed the Worker's KV allowlist + directory cache for the seed crawler's
 * origin so verification never leaves the network. The Signature-Agent URI
 * is the seed row's signature_agent (the directory URL per RFC 9424), which
 * is how app.read_agent_identity resolves seed-crawler's identity + wallet.
 */
export async function signedBotAuthHeaders(
  url: string,
  opts: { created?: Date; authority?: string } = {},
): Promise<Record<string, string>> {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const privJwk = (await crypto.subtle.exportKey("jwk", kp.privateKey)) as JsonWebKey;
  const pubJwk = (await crypto.subtle.exportKey("jwk", kp.publicKey)) as JsonWebKey;
  // WebCrypto exports alg "Ed25519"; web-bot-auth's jwkAlgorithm() requires
  // "EdDSA" or none — verifierFromJWK throws on it and the resolver skips the
  // key as malformed, so every signature verifies as "unknown keyid".
  privJwk.alg = "EdDSA";
  pubJwk.alg = "EdDSA";

  const now = Math.floor(Date.now() / 1000);
  await env.WBA_DIR.put("wba:allow", JSON.stringify([SEED_CRAWLER_ORIGIN]));
  await env.WBA_DIR.put(
    `wba:dir:${SEED_CRAWLER_ORIGIN}`,
    JSON.stringify({
      keys: [{ kty: "OKP", crv: "Ed25519", alg: "EdDSA", x: pubJwk.x }],
      fresh: now + 300,
      stale: now + 604_800,
    }),
  );

  const signer = await signerFromJWK(privJwk);
  const signUrl = opts.authority !== undefined ? url.replace("musebook.dev", opts.authority) : url;
  const req = new Request(signUrl, {
    headers: { "Signature-Agent": `key1="${SEED_CRAWLER_DIR}"` },
  });
  const fields = await sign(req, {
    signer,
    expires: new Date(Date.now() + 60_000),
    created: opts.created,
    signatureAgentKey: "key1",
  });
  const headers: Record<string, string> = {};
  for (const [k, v] of req.headers) headers[k] = v;
  headers["signature"] = fields.signature;
  headers["signature-input"] = fields.signatureInput;
  return headers;
}

/**
 * seededGrantToken() — §17.11.6. A grant exists only because a settlement
 * exists (settlement_id is NOT NULL), so this seeds both rows: a settled
 * purchase on `postId`'s content_hash whose subject is the DELEGATED agent,
 * then returns the seeded delegation's Bearer preimage. Bearer mb_dlg_… ->
 * resolve-actor row 1 -> owner_agent(agentIdentityId=delegated) ->
 * find_live_grant matches subject_agent_id -> allow.
 */
export async function seededGrantToken(postId: string): Promise<string> {
  const id = crypto.randomUUID();
  // payer is random per call: access_grants_payer_hash_uniq covers
  // (payer, content_hash), and the grant binds the SUBJECT agent anyway.
  const payer = `0x${[...crypto.getRandomValues(new Uint8Array(20))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  await db(
    `insert into public.x402_settlements
       (id, post_id, content_hash, network, asset, payer, nonce,
        amount_atomic, pay_to, transaction, status, facilitator_url, settled_at)
     select $1::uuid, p.id, p.content_hash, 'eip155:84532',
            '0x036cbd53842c5426634e7929541ec2318f3dcf7e', $2,
            '0x' || lpad(encode(gen_random_bytes(28), 'hex'), 56, '0') || 'feed0002',
            p.price_atomic, '0x0000000000000000000000000000000000000001',
            '0x' || lpad(encode(gen_random_bytes(28), 'hex'), 56, '0') || 'feed0003',
            'settled'::settlement_status, 'https://x402.org/facilitator', now()
       from public.posts p where p.id = $3::uuid`,
    [id, payer, postId],
  );
  await db(
    `insert into public.access_grants
       (id, settlement_id, content_hash, post_id, payer, subject_agent_id, granted_at)
     select gen_random_uuid(), $1::uuid, p.content_hash, p.id, $2, $3::uuid, now()
       from public.posts p where p.id = $4::uuid`,
    [id, payer, DELEGATED_AGENT_ID, postId],
  );
  return DLG_TOKEN;
}

/** Attach the test media asset to `postId` so lookup_asset_by_key resolves it. */
export async function seedMediaAsset(
  objectKey: string,
  postId: string,
  storage: "r2_paid" | "r2_public" | "r2_artifacts" = "r2_paid",
): Promise<void> {
  const assetId = crypto.randomUUID();
  const host =
    storage === "r2_public"
      ? "cdn.musebook.dev"
      : storage === "r2_artifacts"
        ? "artifacts.musebook.dev"
        : "media.musebook.dev";
  // Deterministic sha + wipe first: a rerun after a failed attempt must not
  // collide on assets_sha_owner_uniq, and the OLD post_assets link must die
  // with its asset so lookupAsset resolves the new row, not the stale one.
  await db(
    `delete from public.post_assets pa
      using public.assets a, public.posts p
     where pa.asset_id = a.id and a.owner_user_id = p.author_user_id
       and p.id = $1::uuid
       and a.sha256 = encode(sha256(('fixture:' || $2::text)::bytea), 'hex')`,
    [postId, objectKey],
  );
  await db(
    `delete from public.assets a
      using public.posts p
     where p.id = $1::uuid and a.owner_user_id = p.author_user_id
       and a.sha256 = encode(sha256(('fixture:' || $2::text)::bytea), 'hex')`,
    [postId, objectKey],
  );
  await db(
    `insert into public.assets
       (id, owner_user_id, storage, object_key, url, content_type, byte_len, sha256, created_at)
     select $1::uuid, p.author_user_id, $2, $3,
            'https://' || $4 || '/' || $3, 'image/avif', 4,
            encode(sha256(('fixture:' || $3::text)::bytea), 'hex'), now()
       from public.posts p where p.id = $5::uuid`,
    [assetId, storage, objectKey, host, postId],
  );
  await db(
    `insert into public.post_assets (post_id, asset_id, position) values ($1::uuid, $2::uuid, 0)`,
    [postId, assetId],
  );
}
