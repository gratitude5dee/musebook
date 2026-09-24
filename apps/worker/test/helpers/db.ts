// apps/worker/test/helpers/db.ts — real local Supabase through
// HYPERDRIVE_FRESH (the vitest alias maps `pg` to the postgres.js shim, so
// these run inside workerd). resetSeed() restores the seed invariants for
// the rows gate tests write — it never touches seeded rows.
import { env } from "cloudflare:test";
import pg from "pg";

export const SEED_POST_ID = "44444444-4444-4444-8444-000000000004"; // seed-article-free
export const SEED_POST_VERSION_ID = "55555555-5555-4555-8555-000000000004";
/** The seed article's live content hash — read from posts at call time so a
 *  seed-text change (which rotates every sha256) never strands the fixture. */
export async function seedContentHash(): Promise<string> {
  return await withDb(async (c) => {
    const { rows } = await c.query<{ content_hash: string }>(
      `select content_hash from public.posts where id = $1`,
      [SEED_POST_ID],
    );
    return rows[0].content_hash;
  });
}
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

/** The musebook_worker login — the ONLY session role that may SET ROLE into
 *  the musebook planes (the postgres superuser's membership is admin-only,
 *  not set). RPCs that call app.enter (enqueue_job, finish_job, the media
 *  submit/finalize family) must go through this client, not withDb. */
const WORKER_DB_URL = "postgres://musebook_worker:postgres@127.0.0.1:54322/postgres";
export async function withWorkerDb<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: WORKER_DB_URL });
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
  const hash = await seedContentHash();
  await withDb(async (c) => {
    await c.query(
      `delete from public.ops_events where subject_id in
         (select id::text from public.job_outbox
           where dedupe_key like 'test-%' or dedupe_key like 'sweep-%'
              or dedupe_key like 'classify:%' or dedupe_key like 'embed:%'
              or dedupe_key like 'distribute:%' or dedupe_key like 'distribute-%')`,
    );
    await c.query(
      `delete from public.job_outbox
         where dedupe_key like 'test-%' or dedupe_key like 'sweep-%'
            or dedupe_key like 'classify:%' or dedupe_key like 'embed:%'
            or dedupe_key like 'distribute:%' or dedupe_key like 'distribute-%'`,
    );
    await c.query(`delete from public.post_classifications where content_hash = $1`, [hash]);
    await c.query(`delete from public.post_embeddings where content_hash = $1`, [hash]);
    await c.query(`delete from public.distribution_jobs where idempotency_key like 'test-%'`);
    await c.query(`delete from public.distribution_jobs where idempotency_key like 'dist:%'`);
    await c.query(`delete from public.platform_variants where post_version_id = $1`, [
      SEED_POST_VERSION_ID,
    ]);
    await c.query(`delete from public.channels where postiz_channel_id like 'test-%'`);
    await c.query(`delete from public.platforms where slug = 'testx'`);
    // M19 test fixtures: media jobs + the reservations/holds they open.
    // media_jobs must go FIRST: it FKs to agent_spend_reservations and
    // assets with ON DELETE SET NULL — deleting either parent first leaves
    // 'succeeded' jobs with null reservation/asset and trips
    // media_jobs_succeeded_has_reservation / _has_asset.
    await c.query(
      `delete from public.job_outbox
         where dedupe_key like 'media%' and payload->>'media_job_id' in
               (select id::text from public.media_jobs where idempotency_key like 'test-%')`,
    );
    await c.query(
      `delete from public.media_jobs
         where idempotency_key like 'test-%'
            or asset_id in (select id from public.assets where object_key not like 'seed/%')`,
    );
    await c.query(`delete from public.agent_spend_reservations where idempotency_key like 'test-%'`);
    // Everything except the six seeded r2_public media rows (object_key
    // 'seed/…') is test-fixture output (upload promotion, composer flows)
    // that survives resets and leaks into app.distribution_media's join on
    // the next suite. The seeded rows stay: ReelsPlayableFilter needs them
    // for the reels surface to have servable candidates at all.
    await c.query(
      `delete from public.post_assets
         where asset_id not in (select id from public.assets where object_key like 'seed/%')`,
    );
    await c.query(`delete from public.assets where object_key not like 'seed/%'`);
    // dsar_requests + consent_events are FORCE RLS — even their owner can't
    // see rows through a DELETE's RLS filter, so test rows would leak between
    // suites. TRUNCATE isn't RLS-gated; neither table is seeded.
    await c.query(`truncate public.dsar_requests, public.consent_events`);
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

  const contentHash = await seedContentHash();
  const records: Record<string, Record<string, unknown>> = {
    classify: {
      content_hash: contentHash,
      provider: "test",
      model: "test-model",
      primary_topic: "testing",
      topics: ["testing"],
      language_code: "en",
      quality: 0.5,
      latency_ms: 1,
    },
    embed: {
      content_hash: contentHash,
      post_id: SEED_POST_ID,
      model: "test-embed",
      dim: 1536,
      embedding: `[${"0.001,".repeat(1535)}0.001]`,
    },
  };

  if (kind === "distribute") {
    // §12.3.3's on-wire payload is the publish_post plan message; the plan
    // stage keys its effect row dist:${pvid}:${cid} (§12.3.9), which is what
    // `key` must carry for the effect-count assertion.
    const channelId = await withDb(async (c) => {
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
      return ch.rows[0].id;
    });
    const { rows } = await withDb((c) =>
      c.query<{ id: number }>(
        `insert into public.job_outbox (kind, dedupe_key, payload)
         values ($1, $2, $3::jsonb) returning id`,
        [
          kind,
          key,
          {
            post_id: SEED_POST_ID,
            post_version_id: SEED_POST_VERSION_ID,
            platforms: ["testx"],
            source: "composer",
          },
        ],
      ),
    );
    return {
      id: Number(rows[0].id),
      contentHash,
      key: `dist:${SEED_POST_VERSION_ID}:${channelId}`,
    };
  }

  let record = records[kind];
  const { rows } = await withDb((c) =>
    c.query<{ id: number }>(
      `insert into public.job_outbox (kind, dedupe_key, payload)
       values ($1, $2, $3::jsonb) returning id`,
      [kind, key, { post_id: SEED_POST_ID, content_hash: contentHash, record }],
    ),
  );
  return { id: Number(rows[0].id), contentHash: contentHash, key };
}
