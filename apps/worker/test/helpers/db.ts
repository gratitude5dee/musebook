// apps/worker/test/helpers/db.ts — real local Supabase through
// HYPERDRIVE_FRESH (the vitest alias maps `pg` to the postgres.js shim, so
// these run inside workerd). resetSeed() restores the seed invariants for
// the rows gate tests write — it never touches seeded rows.
import { env } from "cloudflare:test";
import pg from "pg";

export const SEED_POST_ID = "44444444-4444-4444-8444-000000000004"; // seed-article-free
export const SEED_POST_VERSION_ID = "55555555-5555-4555-8555-000000000004";
export const SEED_CONTENT_HASH = "e31155826556dd6b2c73920c6a57a597e85e837fcd1166c9733a270ac5592aca";
export const SEED_AUTHOR_ID = "11111111-1111-4111-8111-000000000001";

/** Fixture writes run as `postgres` (bypassrls — test setup predates the
 *  system under test); the WORKER's own queries go through the env bindings,
 *  which connect as musebook_worker for prod parity. */
const ADMIN_DB_URL = "postgres://postgres:postgres@127.0.0.1:54322/postgres";

export async function withDb<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: ADMIN_DB_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Deletes every row a gate test could have written — by test-only markers
 *  (dedupe_key 'test-%'/'sweep-%', idempotency_key 'test-%') and by the seed
 *  content hash on the effect tables. Seed rows themselves are never deleted. */
export async function resetSeed(): Promise<void> {
  await withDb(async (c) => {
    await c.query(
      `delete from public.ops_events where subject_id in
         (select id::text from public.job_outbox
           where dedupe_key like 'test-%' or dedupe_key like 'sweep-%'
              or dedupe_key like 'classify:%' or dedupe_key like 'embed:%'
              or dedupe_key like 'distribute:%')`,
    );
    await c.query(
      `delete from public.job_outbox
         where dedupe_key like 'test-%' or dedupe_key like 'sweep-%'
            or dedupe_key like 'classify:%' or dedupe_key like 'embed:%'
            or dedupe_key like 'distribute:%'`,
    );
    await c.query(`delete from public.post_classifications where content_hash = $1`, [
      SEED_CONTENT_HASH,
    ]);
    await c.query(`delete from public.post_embeddings where content_hash = $1`, [
      SEED_CONTENT_HASH,
    ]);
    await c.query(`delete from public.distribution_jobs where idempotency_key like 'test-%'`);
    await c.query(`delete from public.channels where postiz_channel_id like 'test-%'`);
    await c.query(`delete from public.platforms where slug = 'testx'`);
  });
}

export interface SeededJob {
  id: number;
  contentHash: string;
  key: string; // idempotency key for distribute, content_hash otherwise
}

/**
 * seedOutboxJob(queue) — one `queued` job_outbox row whose payload carries a
 * `record` for the queue's effect table (§17.11.5's consume-now effect), plus
 * any fixture rows the effect's FKs need. `queue` is the QUEUE name, not the
 * component kind.
 */
export async function seedOutboxJob(queue: string): Promise<SeededJob> {
  const stamp = crypto.randomUUID().slice(0, 12);
  const key = `test-${queue}-${stamp}`;
  const kind = queue
    .replace(/^musebook-/, "")
    .replace(/-/g, "_")
    .replace(/_dlq$/, "");

  const records: Record<string, Record<string, unknown>> = {
    classify: {
      content_hash: SEED_CONTENT_HASH,
      provider: "test",
      model: "test-model",
      primary_topic: "testing",
      topics: ["testing"],
      language_code: "en",
      quality: 0.5,
      latency_ms: 1,
    },
    embed: {
      content_hash: SEED_CONTENT_HASH,
      post_id: SEED_POST_ID,
      model: "test-embed",
      dim: 1536,
      embedding: `[${"0.001,".repeat(1535)}0.001]`,
    },
  };

  let record = records[kind];
  if (kind === "distribute") {
    record = await withDb(async (c) => {
      await c.query(
        `insert into public.platforms (slug, display_name) values ('testx', 'Test X')
           on conflict (slug) do nothing`,
      );
      await c.query(
        `insert into public.channels (owner_user_id, platform, postiz_channel_id, handle, display_name)
         values ($1, 'testx', $2, '@test', 'Test Channel') on conflict do nothing`,
        [SEED_AUTHOR_ID, `test-ch-${stamp}`],
      );
      const ch = await c.query<{ id: string }>(
        `select id from public.channels where postiz_channel_id = $1`,
        [`test-ch-${stamp}`],
      );
      return {
        post_id: SEED_POST_ID,
        post_version_id: SEED_POST_VERSION_ID,
        channel_id: ch.rows[0].id,
        idempotency_key: key,
      };
    });
  }

  const { rows } = await withDb((c) =>
    c.query<{ id: number }>(
      `insert into public.job_outbox (kind, dedupe_key, payload)
       values ($1, $2, $3::jsonb) returning id`,
      [kind, key, { post_id: SEED_POST_ID, content_hash: SEED_CONTENT_HASH, record }],
    ),
  );
  return { id: Number(rows[0].id), contentHash: SEED_CONTENT_HASH, key };
}
