// apps/worker/test/classify.test.ts (M14) — the classify consumer end to end
// against the real local DB: at-least-once idempotence (one API call, two
// acks, identical row), publish surviving a provider outage, and the daily
// token-budget defer that feeds A14's classify.degraded signal.
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.js";
import { withDb, resetSeed, seedOutboxJob, seedContentHash, SEED_POST_ID } from "./helpers/db.js";
import { stubJev, type JevCall } from "./helpers/jev.js";

function message<T>(id: string, body: T, attempts = 1) {
  return {
    id,
    timestamp: new Date("2026-09-22T12:00:00Z"),
    body,
    attempts,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

const deliver = async (msgs: ReturnType<typeof message>[]) => {
  const ctx = createExecutionContext();
  await worker.queue(
    { queue: "musebook-classify", messages: msgs, ackAll: vi.fn(), retryAll: vi.fn() },
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
};

let calls: JevCall[] = [];

beforeEach(async () => {
  await resetSeed();
  calls = [];
  env.TYPESAFE_API_KEY = "test";
  env.CLASSIFY_PROVIDER = "typesafe"; // tests stub the Jev endpoint, not the gateway
  env.CLASSIFY_DAILY_TOKEN_BUDGET = "0"; // 0 disables the budget check.
  vi.stubGlobal("fetch", stubJev(calls));
});
afterAll(() => vi.unstubAllGlobals());

describe("classify consumer", () => {
  it("the same message twice is one API call, two acks, and a byte-identical row", async () => {
    const job = await seedOutboxJob("musebook-classify");

    const m1 = message("m-first", { job_id: job.id });
    await deliver([m1]);
    const apiCalls = calls.length;
    expect(apiCalls).toBeGreaterThan(0);
    expect(m1.ack).toHaveBeenCalledTimes(1);
    expect(m1.retry).not.toHaveBeenCalled();

    const { rows: before } = await withDb((c) =>
      c.query(
        `select row_to_json(t) as row from public.post_classifications t where content_hash = $1`,
        [job.contentHash],
      ),
    );
    expect(before).toHaveLength(1);
    const row = before[0].row as Record<string, unknown>;
    expect(row.provider).toBe("typesafe_jev");
    expect(row.taxonomy_leaf).not.toBeNull();
    expect(row.medium).not.toBeNull();
    expect(row.audience_level).not.toBeNull();
    expect(row.agent_value).not.toBeNull();

    const m2 = message("m-redelivery", { job_id: job.id });
    await deliver([m2]);
    expect(calls.length).toBe(apiCalls); // cache hit — zero new API calls
    expect(m2.ack).toHaveBeenCalledTimes(1);
    expect(m2.retry).not.toHaveBeenCalled();

    const { rows: after } = await withDb((c) =>
      c.query(
        `select row_to_json(t) as row from public.post_classifications t where content_hash = $1`,
        [job.contentHash],
      ),
    );
    expect(after).toHaveLength(1);
    expect(after[0].row).toEqual(before[0].row);
  });

  it("publish enqueues a classify job and a Jev outage defers it, never drops it", async () => {
    // §8.9 gate 2: publish_post is pure SQL — a Typesafe outage cannot reach it.
    await withDb((c) => c.query("select * from public.publish_post($1, $2)", [SEED_POST_ID, []]));
    const hash = await seedContentHash();
    const { rows: jobs } = await withDb((c) =>
      c.query<{ id: number; state: string }>(
        `select id, state from public.job_outbox
           where kind = 'classify' and dedupe_key = $1 order by id desc limit 1`,
        [`classify:${hash}`],
      ),
    );
    expect(jobs[0]?.state).toBe("queued");
    const { rows: post } = await withDb((c) =>
      c.query<{ status: string }>(`select status from public.posts where id = $1`, [SEED_POST_ID]),
    );
    expect(post[0].status).toBe("published");

    // Now Jev 503s: the job stays queued with a retry, and ops_events records why.
    vi.stubGlobal("fetch", stubJev(calls, { status: 503 }));
    const msg = message("m-outage", { job_id: jobs[0].id });
    await deliver([msg]);
    expect(msg.ack).not.toHaveBeenCalled();
    expect(msg.retry).toHaveBeenCalledTimes(1);
    const { rows: after } = await withDb((c) =>
      c.query<{ state: string }>(`select state from public.job_outbox where id = $1`, [jobs[0].id]),
    );
    expect(after[0].state).toBe("queued");
    const { rows: ops } = await withDb((c) =>
      c.query<{ event_name: string; level: string }>(
        `select event_name, level from public.ops_events where subject_id = $1`,
        [String(jobs[0].id)],
      ),
    );
    expect(ops.some((o) => o.event_name === "provider_5xx" && o.level === "warn")).toBe(true);
  });

  it("over the daily token budget the batch defers with a degraded counter", async () => {
    env.CLASSIFY_DAILY_TOKEN_BUDGET = "10";
    const hash = await seedContentHash();
    // A recent typesafe_jev row puts the rolling-24h spend over the tiny budget.
    await withDb((c) =>
      c.query(
        `insert into public.post_classifications
           (content_hash, provider, model, quality, medium, medium_confidence,
            audience_level, audience_level_label, agent_value, agent_value_confidence,
            topics, primary_topic, topic_probabilities, language_code,
            is_nsfw, is_ai_generated, taxonomy_path, taxonomy_leaf, taxonomy_score,
            question_set_version, taxonomy_version, input_tokens, latency_ms, request_id)
         values ($1, 'typesafe_jev', 'jev-test', 0.5, 'video', 0.9, 0.5, 'mixed', 0.5, 0.9,
                 '{}'::text[], null, '{}'::jsonb, 'en', false, false,
                 '{media}'::text[], null, 0.9, 'qs', 'tx', 50, 10, 'req_seed')`,
        [hash],
      ),
    );
    const job = await seedOutboxJob("musebook-classify");
    const msg = message("m-budget", { job_id: job.id });
    await deliver([msg]);

    expect(calls).toHaveLength(0); // never called the API
    expect(msg.ack).not.toHaveBeenCalled();
    const [{ delaySeconds }] = msg.retry.mock.calls[0] as [{ delaySeconds: number }];
    expect(delaySeconds).toBe(300);

    const { rows: ops } = await withDb((c) =>
      c.query<{ event_name: string; outcome: string }>(
        `select event_name, outcome from public.ops_events
           where component = 'classify' and event_name = 'token_budget'`,
      ),
    );
    expect(ops.some((o) => o.outcome === "deferred")).toBe(true);
    const { rows: counters } = await withDb((c) =>
      c.query<{ metric: string; labels: { result?: string } }>(
        `select metric, labels from public.ops_counters
           where metric = 'musebook.classify.outcome' order by bucket_start desc limit 5`,
      ),
    );
    expect(counters.some((r) => r.labels?.result === "degraded")).toBe(true);
  });

  it("a terminal 400 dead-letters with a heuristic fallback row", async () => {
    const job = await seedOutboxJob("musebook-classify");
    vi.stubGlobal("fetch", stubJev(calls, { status: 400 }));
    const msg = message("m-bad", { job_id: job.id });
    await deliver([msg]);

    expect(msg.ack).toHaveBeenCalledTimes(1); // terminal — consumed, not retried
    const { rows } = await withDb((c) =>
      c.query<{ state: string }>(`select state from public.job_outbox where id = $1`, [job.id]),
    );
    expect(rows[0].state).toBe("dead");
    const { rows: cls } = await withDb((c) =>
      c.query<{ provider: string; topics: string[] }>(
        `select provider, topics from public.post_classifications where content_hash = $1`,
        [job.contentHash],
      ),
    );
    expect(cls[0].provider).toBe("heuristic"); // §8.10: 400 plants the fallback row
  });
});
