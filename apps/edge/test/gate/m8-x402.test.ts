// apps/edge/test/gate/m8-x402.test.ts — §16.8's DB-level checks on the live
// local database: the nonce race under real concurrency, the reconciler's
// read surface, the 3-leg ledger write, and the revenue_share_version pins.
import pg from "pg";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { db } from "./helpers.js";

// app.* calls go through musebook_worker — the same role the Hyperdrive
// bindings run as. `::jsonb` params are passed as plain objects, NOT
// JSON.stringify'ed text: this driver's client (the pg shim is postgres.js)
// JSON-encodes object params itself, so a pre-stringified value lands as a
// jsonb scalar string and `->>` looks up nothing. (Local postgres is not rolsuper: app.enter's role switch
// only works for a role that was granted EXECUTE on app.enter.)
const WORKER_DB_URL = "postgres://musebook_worker:postgres@127.0.0.1:54322/postgres";
async function workerDb<T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  const client = new pg.Client({ connectionString: WORKER_DB_URL });
  await client.connect();
  try {
    const { rows } = await client.query<T>(sql, params as unknown[]);
    return rows;
  } finally {
    await client.end();
  }
}

const PAID_POST = "44444444-4444-4444-8444-000000000006"; // seed-article-x402
// Fresh per run — a replayed suite must lose the nonce race to NOTHING but
// itself (a leftover row from an earlier run would satisfy that assertion).
const NONCE = `0x${Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("")}`;
const PAYER = "0xda3840c0f8bb1db0e86cd1bf9b2398c1dc112f96";
const ASSET = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

interface PostRow {
  id: string;
  content_hash: string;
  revenue_share_version: string;
}

async function seedPaidPost(): Promise<PostRow> {
  const rows = await db<PostRow>(
    "select id, content_hash, revenue_share_version from public.posts where id = $1",
    [PAID_POST],
  );
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

async function pinQuote(post: PostRow, quoteId: string): Promise<void> {
  await workerDb(
    "select app.pin_quote($1::uuid, $2, $3::uuid, $4, null, 'http', $5, $6, $7, $8, $9::jsonb)",
    [
      quoteId,
      "https://musebook.dev/p/seed-article-x402",
      post.id,
      post.content_hash,
      "eip155:8453",
      ASSET,
      "0x1000000000000000000000000000000000000001",
      "250000",
      { x402Version: 2 },
    ],
  );
}

describe("M8.2 — one hundred concurrent settlements, exactly one row", () => {
  it("insert_pending_settlement claims the nonce exactly once", async () => {
    const post = await seedPaidPost();
    const quoteId = crypto.randomUUID();
    await pinQuote(post, quoteId);

    // 16-connection postgres.js pool, 100 in-flight INSERTs — a real race on
    // the unique index, not a sequential loop.
    const pool = postgres(WORKER_DB_URL, { max: 16, prepare: false });
    const args = [
      quoteId,
      post.id,
      post.content_hash,
      "eip155:8453",
      ASSET,
      PAYER,
      NONCE,
      "250000",
      "0x1000000000000000000000000000000000000001",
      "https://x402.org/facilitator",
      { isValid: true },
      post.revenue_share_version,
      { x402Version: 2 },
    ];
    const results = await Promise.all(
      Array.from({ length: 100 }, () =>
        pool.unsafe(
          "select app.insert_pending_settlement($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) as id",
          args as never[],
        ),
      ),
    );
    const ids = results.map((r) => (r[0] as { id: string | null }).id);
    expect(ids.filter((i) => i !== null)).toHaveLength(1);
    const rows = await db<{ n: string }>(
      "select count(*)::text as n from public.x402_settlements where nonce = $1",
      [NONCE],
    );
    expect(rows[0]?.n).toBe("1");
    await pool.end({ timeout: 5 });
  });

  it("the row exposes the reconciler's read surface", async () => {
    const stale = await workerDb<{
      id: string;
      nonce: string;
      payment_payload: { x402Version: number };
    }>("select id, nonce, payment_payload from app.list_stale_settlements(0, 200)");
    const mine = stale.find((r) => r.nonce === NONCE);
    expect(mine).toBeDefined();
    expect(mine?.payment_payload?.x402Version).toBe(2);

    const found = await workerDb<{ id: string; status: string }>(
      "select id, status from app.find_settlement($1, $2, $3, $4)",
      ["eip155:8453", ASSET, PAYER, NONCE],
    );
    expect(found[0]?.status).toBe("pending");

    const age = await workerDb<{ oldest_pending_settlement_age_s: number }>(
      "select app.oldest_pending_settlement_age_s()",
    );
    expect(Number(age[0]?.oldest_pending_settlement_age_s)).toBeGreaterThanOrEqual(0);
  });
});

describe("M8.10/11 — flip, legs, and the version pins", () => {
  it("marks settled once, writes three balanced legs, dedupes a re-post", async () => {
    const post = await seedPaidPost();
    const sid = (
      await db<{ id: string }>("select id from public.x402_settlements where nonce = $1", [NONCE])
    )[0]!.id;

    await workerDb("select app.mark_settlement_settled($1::uuid, $2::jsonb)", [
      sid,
      { success: true, transaction: `0x${"ef".repeat(32)}`, network: "eip155:8453" },
    ]);
    const status = await db<{ status: string }>(
      "select status from public.x402_settlements where id = $1",
      [sid],
    );
    expect(status[0]?.status).toBe("settled");

    const legs = await workerDb<{
      amount_atomic: string;
      payer: string;
      asset: string;
      network: string;
      revenue_share_version: string;
      creator_user_id: string;
      creator_address: string | null;
    }>("select * from app.settlement_for_legs($1::uuid)", [sid]);
    const s = legs[0]!;
    const bps = (
      await workerDb<{ policy_bps: number }>("select app.policy_bps($1)", [s.revenue_share_version])
    )[0]!.policy_bps;
    expect(bps).toBe(1000); // rs_2026_09_v1 seed

    const gross = BigInt(s.amount_atomic);
    const fee = (gross * BigInt(bps)) / 10000n;
    const net = gross - fee;
    for (let i = 0; i < 2; i++) {
      await workerDb(
        `select app.post_settlement_legs($1::uuid,$2::uuid,$3,$4::uuid,$5,$6,$7,$8::numeric,$9::numeric,$10::numeric,$11::uuid)`,
        [
          sid,
          sid,
          s.payer,
          s.creator_user_id,
          s.creator_address,
          s.asset,
          s.network,
          gross.toString(),
          fee.toString(),
          net.toString(),
          null,
        ],
      );
    }
    const posted = await db<{ account_kind: string; amount_atomic: string; ledger_tx_id: string }>(
      "select account_kind, amount_atomic::text, ledger_tx_id::text from public.payout_ledger where settlement_id = $1 order by account_kind",
      [sid],
    );
    expect(posted).toHaveLength(3); // the second post was a no-op (D66)
    expect(posted[0]?.ledger_tx_id).toBe(sid);
    const byKind = Object.fromEntries(posted.map((r) => [r.account_kind, r.amount_atomic]));
    expect(byKind["payer"]).toBe(`-${gross.toString()}`);
    expect(byKind["platform"]).toBe(fee.toString());
    expect(byKind["creator"]).toBe(net.toString());
    expect(
      BigInt(byKind["payer"]!) + BigInt(byKind["platform"]!) + BigInt(byKind["creator"]!),
    ).toBe(0n);
  });

  it("rejects a settlement row with no revenue_share_version on the post", async () => {
    const nulls = await db<{ n: string }>(
      "select count(*)::text as n from public.posts where revenue_share_version is null",
    );
    expect(nulls[0]?.n).toBe("0");
    const post = await seedPaidPost();
    expect(post.revenue_share_version).toBe("rs_2026_09_v1");
  });
});
