// apps/worker/test/queue-idempotency.test.ts (T2w) — §17.11.5. Cloudflare
// Queues is at-least-once with no exactly-once mode, and that is not
// configurable away: every consumer must be idempotent. The test is the
// blunt one — hand the consumer the same message twice and count the effects.
// Adapted: distribute's effect table keys on idempotency_key (it has no
// content_hash column); effect rows come from the job payload's `record`.
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.js";
import { withDb, resetSeed, seedOutboxJob } from "./helpers/db.js";

/** A Message with real ack/retry spies. Queues redelivers on retry AND on ack timeout. */
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

const deliver = async (queue: string, msgs: ReturnType<typeof message>[]) => {
  const ctx = createExecutionContext();
  await worker.queue({ queue, messages: msgs, ackAll: vi.fn(), retryAll: vi.fn() }, env, ctx);
  await waitOnExecutionContext(ctx);
};

beforeEach(resetSeed);

describe("every consumer is idempotent under at-least-once delivery", () => {
  // One row per queue whose M6 consumer writes a real effect row (§17.11.5).
  // A new queue adds a row here or it ships untested.
  const QUEUES = [
    {
      queue: "musebook-classify",
      effect: "select count(*) as count from public.post_classifications where content_hash = $1",
      keyFor: (j: { contentHash: string; key: string }) => j.contentHash,
    },
    {
      queue: "musebook-embed",
      effect: "select count(*) as count from public.post_embeddings where content_hash = $1",
      keyFor: (j: { contentHash: string; key: string }) => j.contentHash,
    },
    {
      queue: "musebook-distribute",
      effect: "select count(*) as count from public.distribution_jobs where idempotency_key = $1",
      keyFor: (j: { contentHash: string; key: string }) => j.key,
    },
  ] as const;

  for (const q of QUEUES) {
    it(`${q.queue}: the same message delivered twice produces exactly one effect`, async () => {
      const job = await seedOutboxJob(q.queue);
      const msg = message(`m-${q.queue}`, { job_id: job.id });

      await deliver(q.queue, [msg]);
      await deliver(q.queue, [message(`m-${q.queue}-redelivery`, { job_id: job.id })]);

      const { rows } = await withDb((c) => c.query(q.effect, [q.keyFor(job)]));
      expect(Number(rows[0].count)).toBe(1);
      expect(msg.ack).toHaveBeenCalledTimes(1);
      expect(msg.retry).not.toHaveBeenCalled();
    });

    it(`${q.queue}: two copies in ONE batch also produce one effect`, async () => {
      // The same-batch case is distinct from the redelivery case and is easy to
      // get wrong: a consumer that dedupes against the database per message
      // still double-writes when both copies are in flight before either
      // commits. claim_job's single-statement queued->running flip is the fence.
      const job = await seedOutboxJob(q.queue);
      await deliver(q.queue, [message("a", { job_id: job.id }), message("b", { job_id: job.id })]);
      const { rows } = await withDb((c) => c.query(q.effect, [q.keyFor(job)]));
      expect(Number(rows[0].count)).toBe(1);
    });
  }

  it("a failure retries with computed backoff, because Queues has none built in", async () => {
    const job = await seedOutboxJob("musebook-classify");
    // Corrupt the record so the effect INSERT fails — the consumer's own
    // failure path is what retries, not a mocked dependency.
    await withDb((c) =>
      c.query(
        'update public.job_outbox set payload = \'{"record":{"content_hash":null}}\' where id = $1',
        [job.id],
      ),
    );
    const msg = message("m-fail", { job_id: job.id }, 3);
    await deliver("musebook-classify", [msg]);
    expect(msg.ack).not.toHaveBeenCalled();
    const [{ delaySeconds }] = msg.retry.mock.calls[0] as [{ delaySeconds: number }];
    expect(delaySeconds).toBeGreaterThan(0);
    expect(delaySeconds).toBeLessThanOrEqual(86_400); // the platform ceiling
  });

  it("the DLQ consumer is wired, because an unconsumed DLQ discards after 4 days", async () => {
    const job = await seedOutboxJob("musebook-classify");
    await deliver("musebook-classify-dlq", [message("m-dead", { job_id: job.id }, 6)]);
    const { rows } = await withDb((c) =>
      c.query("select state from public.job_outbox where id = $1", [job.id]),
    );
    expect(rows[0].state).toBe("dead");
    const ops = await withDb((c) =>
      c.query("select level from public.ops_events where subject_id = $1", [String(job.id)]),
    );
    expect(ops.rows[0].level).toBe("error");
  });

  it("nothing on the x402 settlement path has a queue consumer", async () => {
    // CF-SPINE §3: never put settlement on an at-least-once transport.
    // Reconciliation is a Cron Worker scanning x402_settlements_pending_idx,
    // not a message.
    const { QUEUE_MAP } = await import("../src/consumers/index.js");
    expect(Object.keys(QUEUE_MAP)).not.toContain("musebook-settle");
  });
});
