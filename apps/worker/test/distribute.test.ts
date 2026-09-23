// apps/worker/test/distribute.test.ts — the musebook-distribute consumer
// end-to-end: plan -> variant -> send -> reconcile against the real local
// stack (musebook_worker over local Hyperdrive), with Postiz stubbed at the
// fetch seam. Covers §16.6 checks 1, 7, 8 and 9.
import { env } from "cloudflare:test";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runDistribute } from "../src/consumers/distribute.js";
import { pgFresh, type DbClient } from "../src/db.js";
import {
  withDb,
  resetSeed,
  SEED_POST_ID,
  SEED_POST_VERSION_ID,
  SEED_AUTHOR_ID,
} from "./helpers/db.js";

/** POSTIZ_API_KEY is a Worker SECRET — absent from .dev.vars in tests, so the
 *  client env is hand-completed here (the stub fetch answers regardless). */
const distEnv = () =>
  Object.assign({}, env, {
    POSTIZ_API_KEY: "test-key",
    POSTIZ_URL: "https://postiz.test",
    POSTIZ_MEDIA_DOMAIN: "media.postiz.musebook.dev",
    CDN_HOST: "cdn.musebook.dev",
    DISTRIBUTION_ENABLED: "true",
  }) as unknown as Env;

const X_CHANNEL = "cccccccc-cccc-4ccc-8ccc-000000000001";
const DISCORD_CHANNEL = "cccccccc-cccc-4ccc-8ccc-000000000002";
const THREADS_CHANNEL = "cccccccc-cccc-4ccc-8ccc-0000000000a1";

interface PostizCall {
  method: string;
  url: string;
  body?: Record<string, unknown>;
}

const calls: PostizCall[] = [];
/** Deterministic Postiz id per integration so the reconciler can match. */
const postizIdFor = new Map<string, string>();

/** Stubbed Postiz sidecar: POST /posts -> one row per entry; GET /posts ->
 *  every created post PUBLISHED with a releaseURL. */
function stubFetch(input: unknown, init?: { method?: string; body?: unknown }): Promise<Response> {
  const url = String(input);
  const method = init?.method ?? "GET";
  calls.push({
    method,
    url,
    body:
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : (init?.body as Record<string, unknown> | undefined),
  });
  if (method === "POST" && url.endsWith("/public/v1/posts")) {
    const posts = (JSON.parse(String(init?.body)) as { posts: { integration: { id: string } }[] })
      .posts;
    const result = posts.map((p, i) => {
      const id = `pz-${postizIdFor.size + i + 1}`;
      postizIdFor.set(p.integration.id, id);
      return { postId: id, integration: p.integration.id };
    });
    return Promise.resolve(new Response(JSON.stringify(result), { status: 200 }));
  }
  if (method === "GET" && url.includes("/public/v1/posts")) {
    const rows = [...postizIdFor.entries()].map(([integration, id]) => ({
      id,
      publishDate: new Date(Date.now() + 60_000).toISOString(),
      releaseURL: `https://x.example/status/${id}`,
      state: "PUBLISHED",
      integration: { id: integration },
    }));
    return Promise.resolve(new Response(JSON.stringify(rows), { status: 200 }));
  }
  if (method === "POST" && url.endsWith("/upload-from-url")) {
    return Promise.resolve(
      new Response(JSON.stringify({ id: "m-1", name: "m", path: "/m/1" }), { status: 200 }),
    );
  }
  return Promise.resolve(new Response("{}", { status: 200 }));
}

async function claimAndRun(db: DbClient, outboxId: number): Promise<void> {
  const { rows } = await db.query<{ payload: Record<string, unknown> | string }>(
    "select payload from app.claim_outbox_job($1)",
    [outboxId],
  );
  expect(rows[0]).toBeDefined();
  await runDistribute(db, distEnv(), rows[0]!.payload);
  await db.query(
    "select app.finish_job($1, 'succeeded'::job_state, 'distribute', null, null, '{}')",
    [outboxId],
  );
}

async function enqueue(payload: Record<string, unknown>, key: string): Promise<number> {
  const { rows } = await withDb((c) =>
    c.query<{ id: number }>(
      `insert into public.job_outbox (kind, dedupe_key, payload)
       values ('distribute', $1, $2::jsonb) returning id`,
      [`test-${key}`, payload],
    ),
  );
  return Number(rows[0].id);
}

async function queuedOutbox(
  kindPrefix: string,
): Promise<{ id: number; payload: Record<string, unknown> }[]> {
  return withDb(async (c) => {
    const { rows } = await c.query<{ id: number; payload: Record<string, unknown> | string }>(
      `select id, payload from public.job_outbox
        where kind = 'distribute' and state = 'queued' and dedupe_key like $1
        order by id`,
      [`${kindPrefix}%`],
    );
    return rows.map((r) => ({
      ...r,
      payload:
        typeof r.payload === "string"
          ? (JSON.parse(r.payload) as Record<string, unknown>)
          : r.payload,
    }));
  });
}

beforeAll(() => {
  vi.stubGlobal("fetch", stubFetch);
});
afterAll(() => {
  vi.unstubAllGlobals();
});
beforeEach(async () => {
  await resetSeed();
  calls.length = 0;
  postizIdFor.clear();
  await withDb(async (c) => {
    await c.query(
      `insert into public.channels (id, owner_user_id, platform, postiz_channel_id, handle, display_name)
       values ($1, $2, 'threads', 'postiz-threads-1', '@t', 'Threads')
       on conflict (id) do nothing`,
      [THREADS_CHANNEL, SEED_AUTHOR_ID],
    );
    await c.query(`delete from public.channels where postiz_channel_id like 'test-%'`);
  });
});

describe("musebook-distribute consumer", () => {
  it("plan -> variant -> send -> reconcile: one POST /posts per bucket, every job succeeds", async () => {
    const planId = await enqueue(
      {
        post_id: SEED_POST_ID,
        post_version_id: SEED_POST_VERSION_ID,
        platforms: ["x", "discord", "threads"],
        source: "composer",
      },
      "plan",
    );
    const db = await pgFresh(env as unknown as Env);
    try {
      await claimAndRun(db, planId);

      // plan wrote one distribution_job per channel + one variant outbox each.
      const jobs = await withDb((c) =>
        c.query<{
          channel_id: string;
          state: string;
          idempotency_key: string;
          scheduled_for: string;
        }>(
          `select channel_id::text, state::text, idempotency_key, scheduled_for::text
             from public.distribution_jobs where post_version_id = $1::uuid order by channel_id`,
          [SEED_POST_VERSION_ID],
        ),
      );
      expect(jobs.rows).toHaveLength(3);
      expect(jobs.rows.every((j) => j.state === "queued")).toBe(true);
      const scheduledFor = jobs.rows[0]!.scheduled_for;

      const variants = await queuedOutbox("distribute-variant:%");
      expect(variants).toHaveLength(3);
      // Check 7: every stage payload is ids only, nowhere near 128KB, and no
      // key names a content field — §4.13.2's transport contract.
      const ID_KEYS = new Set([
        "stage",
        "postId",
        "postVersionId",
        "channelId",
        "platformSlug",
        "jobId",
        "scheduledFor",
        "attempt",
        "postizPostId",
        "source",
        "post_id",
        "post_version_id",
        "platforms",
      ]);
      for (const v of variants) {
        expect(JSON.stringify(v.payload).length).toBeLessThan(131_072);
        expect(Object.keys(v.payload)).toContain("channelId");
        expect(Object.keys(v.payload).every((k) => ID_KEYS.has(k))).toBe(true);
      }
      for (const v of variants) await claimAndRun(db, v.id);

      const stored = await withDb((c) =>
        c.query<{ platform: string; is_valid: boolean }>(
          `select platform, is_valid from public.platform_variants
             where post_version_id = $1::uuid order by platform`,
          [SEED_POST_VERSION_ID],
        ),
      );
      expect(stored.rows).toHaveLength(3);
      expect(stored.rows.every((r) => r.is_valid)).toBe(true);

      // Last sibling enqueued exactly one send row for the bucket.
      const sends = await queuedOutbox("distribute-send:%");
      expect(sends).toHaveLength(1);
      await claimAndRun(db, sends[0]!.id);

      // Check 1: ONE POST /public/v1/posts for the whole 3-channel fan-out.
      const postCalls = calls.filter(
        (c) => c.method === "POST" && c.url.endsWith("/public/v1/posts"),
      );
      expect(postCalls).toHaveLength(1);
      expect((postCalls[0]!.body as { posts: unknown[] }).posts).toHaveLength(3);
      expect(postCalls[0]!.body).toMatchObject({ type: "schedule" });
      expect(new Date((postCalls[0]!.body as { date: string }).date).getTime()).toBe(
        new Date(scheduledFor).getTime(),
      );

      // Postiz accepted: jobs stay 'running' with postiz_post_id set.
      const afterSend = await withDb((c) =>
        c.query<{ state: string; postiz_post_id: string | null }>(
          `select state::text, postiz_post_id from public.distribution_jobs
             where post_version_id = $1::uuid`,
          [SEED_POST_VERSION_ID],
        ),
      );
      expect(afterSend.rows.every((j) => j.state === "running")).toBe(true);
      expect(afterSend.rows.every((j) => j.postiz_post_id !== null)).toBe(true);

      const reconcileMsgs = await queuedOutbox("distribute-reconcile:%");
      expect(reconcileMsgs).toHaveLength(3);
      for (const r of reconcileMsgs) await claimAndRun(db, r.id);

      const final = await withDb((c) =>
        c.query<{ state: string; platform_post_url: string | null }>(
          `select state::text, platform_post_url from public.distribution_jobs
             where post_version_id = $1::uuid`,
          [SEED_POST_VERSION_ID],
        ),
      );
      expect(final.rows.every((j) => j.state === "succeeded")).toBe(true);
      expect(final.rows.every((j) => j.platform_post_url !== null)).toBe(true);
    } finally {
      await db.end();
    }
  });

  it("check 8: a redelivered send message publishes nothing twice", async () => {
    const planId = await enqueue(
      {
        post_id: SEED_POST_ID,
        post_version_id: SEED_POST_VERSION_ID,
        platforms: ["x"],
        source: "composer",
      },
      "plan-idem",
    );
    const db = await pgFresh(env as unknown as Env);
    try {
      await claimAndRun(db, planId);
      const variants = await queuedOutbox("distribute-variant:%");
      await claimAndRun(db, variants[0]!.id);
      const sends = await queuedOutbox("distribute-send:%");
      const sendPayload = sends[0]!.payload;
      await claimAndRun(db, sends[0]!.id);
      const postCallsAfterFirst = calls.filter(
        (c) => c.method === "POST" && c.url.endsWith("/public/v1/posts"),
      ).length;
      // A second delivery of the same send stage: zero new claimed rows, no
      // second POST — the bucket hands off to the reconciler instead.
      const secondId = await enqueue(sendPayload, "send-redelivery");
      await claimAndRun(db, secondId);
      expect(
        calls.filter((c) => c.method === "POST" && c.url.endsWith("/public/v1/posts")).length,
      ).toBe(postCallsAfterFirst);
    } finally {
      await db.end();
    }
  });

  it("check 9: an unconnected platform is a loud error, not a silent drop", async () => {
    const planId = await enqueue(
      {
        post_id: SEED_POST_ID,
        post_version_id: SEED_POST_VERSION_ID,
        platforms: ["tiktok"],
        source: "composer",
      },
      "plan-unconnected",
    );
    const db = await pgFresh(env as unknown as Env);
    try {
      const { rows } = await db.query<{ payload: Record<string, unknown> }>(
        "select payload from app.claim_outbox_job($1)",
        [planId],
      );
      await expect(runDistribute(db, distEnv(), rows[0]!.payload)).rejects.toThrow(
        /not connected|channels not connected/i,
      );
      const ops = await withDb((c) =>
        c.query<{ event_name: string }>(
          `select event_name from public.ops_events
             where component = 'distributor' order by id desc limit 1`,
        ),
      );
      expect(ops.rows[0]?.event_name).toBe("channel.unconnected");
    } finally {
      await db.end();
    }
  });
});
