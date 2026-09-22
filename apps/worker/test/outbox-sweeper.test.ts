// apps/worker/test/outbox-sweeper.test.ts (T2w) — §17.11.4, adapted:
//   * `job_outbox` has no `sent_at` column — the sent marker is `enqueued_at`,
//     and state stays 'queued' until a consumer claims it (the pending index's
//     whole design: recover a sent-then-lost row too). The mark assertion is
//     `enqueued_at is not null`.
//   * `publish_post` takes (post_id, platforms text[]).
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.js";
import { withDb, resetSeed, SEED_POST_ID } from "./helpers/db.js";

const tick = async (cron = "* * * * *") => {
  const ctx = createExecutionContext();
  await worker.scheduled(
    { cron, scheduledTime: Date.parse("2026-09-22T12:00:00Z"), noRetry() {} },
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
};

beforeEach(async () => {
  vi.restoreAllMocks();
  await resetSeed();
});

describe("the * * * * * outbox sweeper", () => {
  it("recovers a row whose send() was dropped", async () => {
    // Simulate the fast path failing: 'Too Many Requests' (>5,000 msg/s) and
    // 'Storage Limit Exceeded' (>25 GB backlog) are both producer-visible
    // exceptions, and the enqueue path swallows them on purpose (§4.13.1).
    const sent: unknown[] = [];
    vi.spyOn(env.Q_CLASSIFY, "sendBatch").mockImplementation(async (b) => {
      sent.push(...b);
    });

    const jobId = await withDb(async (c) => {
      await c.query("select * from public.publish_post($1, $2)", [SEED_POST_ID, []]);
      const { rows } = await c.query<{ id: number }>(
        `update public.job_outbox set enqueued_at = null
          where kind = 'classify' and dedupe_key like 'classify:%' returning id`,
      );
      return Number(rows[0].id);
    });

    await tick();

    // The sweep re-sends every queued row (the index's design: a sent-then-lost
    // message and a never-sent one are indistinguishable). The assertion is
    // that THIS row is recovered and marked — seed sighting rows ride along.
    expect(sent.some((m) => (m as { body: { job_id: number } }).body.job_id === jobId)).toBe(true);
    const { rows } = await withDb((c) =>
      c.query("select enqueued_at from public.job_outbox where id = $1", [jobId]),
    );
    expect(rows[0].enqueued_at).not.toBeNull();
  });

  it("reads on HYPERDRIVE_FRESH, or it re-enqueues the same rows forever", async () => {
    // The cached binding (max_age 60s) would re-read a stale `queued` set on the
    // next tick and send every message again. Hyperdrive does NOT invalidate on
    // write, and a SQL comment is not a cache-control API — they share a cache
    // key (CF-SPINE §2).
    // @ts-expect-error — vitest ?raw import; the assertion IS the file's text.
    const src = (await import("../src/cron/outbox.ts?raw")).default as string;
    expect(src).toContain("HYPERDRIVE_FRESH");
    expect(src).not.toContain("HYPERDRIVE_CACHED");
  });

  it("batches at the platform ceiling and never above it", async () => {
    const { rows: ins } = await withDb((c) =>
      c.query<{ id: number }>(
        `insert into public.job_outbox (kind, dedupe_key, payload)
         select 'classify', 'sweep-' || g, '{"job_id":1}'::jsonb
           from generate_series(1, 250) g returning id`,
      ),
    );
    // Count only this test's rows — other projects' sightings legitimately
    // share the queued set (the sweep's predicate is state alone).
    const mine = new Set(ins.map((r) => Number(r.id)));
    const batches: { body: unknown }[][] = [];
    vi.spyOn(env.Q_CLASSIFY, "sendBatch").mockImplementation(async (b) => {
      batches.push(b as { body: unknown }[]);
    });

    await tick();

    // sendBatch is capped at 100 messages OR 256 KB, whichever comes first.
    expect(batches.every((b) => b.length <= 100)).toBe(true);
    const sentIds = batches.flat().map((m) => (m.body as { job_id: number }).job_id);
    expect(sentIds.filter((id) => mine.has(id)).length).toBe(250);
  });

  it("never inlines a payload: every message is row ids and R2 keys", async () => {
    const batches: { body: unknown }[] = [];
    vi.spyOn(env.Q_CLASSIFY, "sendBatch").mockImplementation(async (b) => {
      batches.push(...(b as { body: unknown }[]));
    });
    await withDb((c) => c.query("select * from public.publish_post($1, $2)", [SEED_POST_ID, []]));
    await tick();
    for (const m of batches) {
      const bytes = new TextEncoder().encode(JSON.stringify(m.body)).byteLength;
      expect(bytes).toBeLessThan(128 * 1024); // the hard per-message limit
      expect(Object.keys(m.body as object)).toStrictEqual(["job_id"]);
    }
  });

  it("does not run the sweeper on another cron expression", async () => {
    const spy = vi.spyOn(env.Q_CLASSIFY, "sendBatch");
    await tick("0 * * * *"); // the hourly slate build
    expect(spy).not.toHaveBeenCalled();
  });
});
