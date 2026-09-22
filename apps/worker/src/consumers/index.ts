// apps/worker/src/consumers/index.ts — the queue() dispatch. One case per
// queue; every consumer claims the outbox row first so a redelivered message
// is a no-op, then finishes it. Dead-letter handling is per queue below.
import { claimJob, finishJob, pgFresh, type DbClient } from "../db.js";
import { runSlateJob, type SlateRequest } from "../slate-builder.js";

interface JobMessage {
  // postgres.js returns int8 as BigInt; producers JSON.stringify it away but a
  // hand-built batch (tests, a future caller) can still carry it — coerce.
  job_id?: number | bigint;
  kind?: string;
  dedupe_key?: string;
}

function jobIdOf(msg: JobMessage): number | null {
  const id = msg.job_id;
  if (typeof id === "bigint") return Number(id);
  return typeof id === "number" ? id : null;
}

/** Queue name -> component name, primary AND dead-letter queues. Exported so
 *  the §17.11.5 gate can assert no settlement work ever rides a queue —
 *  x402's path is a cron scan, never an at-least-once transport (CF-SPINE §3). */
export const QUEUE_MAP: Readonly<Record<string, string>> = {
  "musebook-classify": "classify",
  "musebook-embed": "embed",
  "musebook-distribute": "distribute",
  "musebook-media": "media",
  "musebook-media-finalize": "media_finalize",
  "musebook-agent-cancel": "agent_cancel",
  "musebook-r2-events": "r2_events",
  "musebook-slates": "slates",
  "musebook-classify-dlq": "classify",
  "musebook-embed-dlq": "embed",
  "musebook-distribute-dlq": "distribute",
  "musebook-media-dlq": "media",
  "musebook-media-finalize-dlq": "media_finalize",
  "musebook-agent-cancel-dlq": "agent_cancel",
  "musebook-r2-events-dlq": "r2_events",
};

const BACKOFF_BASE_SECONDS = 5;
const BACKOFF_CEILING_SECONDS = 86_400; // the platform retry ceiling

/** Queues has no built-in backoff: retry() delay is ours. Exponential on the
 *  delivery's attempt count, capped at the platform's 24 h retry bound. */
export function retryDelaySeconds(attempts: number): number {
  return Math.min(BACKOFF_CEILING_SECONDS, BACKOFF_BASE_SECONDS * 2 ** Math.max(0, attempts - 1));
}

/** The shared claim→work→finish skeleton (§4.13.3). `work` gets the claimed
 *  row; a throw marks the job failed and rethrows so the message retries. */
async function consume(
  env: Env,
  msg: JobMessage,
  component: string,
  work: (db: DbClient, payload: Record<string, unknown>) => Promise<void>,
): Promise<void> {
  const jobId = jobIdOf(msg);
  if (jobId === null) return; // not a job_outbox message
  const db = await pgFresh(env);
  try {
    const job = await claimJob(db, jobId);
    if (job === null) return; // redelivery — the first delivery already ran
    try {
      await work(db, job.payload);
      await finishJob(db, jobId, "succeeded", { component });
    } catch (err) {
      await finishJob(db, jobId, "failed", {
        component,
        event: "consumer_error",
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  } finally {
    await db.end();
  }
}

/** A DLQ message means every retry was exhausted: mark the source job dead and
 *  emit the alert row (§4.13.4 — the alarm lives on ops_events, surfaced by
 *  §15's evaluator). */
async function consumeDlq(env: Env, msg: JobMessage, component: string): Promise<void> {
  const jobId = jobIdOf(msg);
  if (jobId === null) return;
  const db = await pgFresh(env);
  try {
    await finishJob(db, jobId, "dead", {
      component,
      event: "dlq_message",
      error: "retries_exhausted",
      detail: { dedupe_key: msg.dedupe_key ?? null },
    });
  } finally {
    await db.end();
  }
}

/**
 * M6's consume-now effects (§17.11.5): when the outbox payload carries a
 * `record` — a fully-shaped row for the effect table — the consumer writes it
 * through the app.* helper, which dedupes on content_hash/idempotency_key.
 * The real producers land at M7-M9; until then a payload without `record`
 * simply claims and finishes, keeping the dedupe contract honest.
 */
async function recordRows(
  db: DbClient,
  fn: string,
  payload: Record<string, unknown>,
): Promise<void> {
  if (payload.record === undefined) return;
  await db.query(`select ${fn}($1::jsonb)`, [[payload.record] as never[]]);
}

/** batch.queue -> handler. `void batch` discipline: every message is acked or
 *  retried explicitly; nothing falls off the end of a batch. */
export async function dispatch(batch: MessageBatch, env: Env): Promise<void> {
  const handlers: Record<string, (m: JobMessage) => Promise<void>> = {
    "musebook-classify": (m) =>
      consume(env, m, "classify", async (db, payload) => {
        // M7: classifier call + posts.title/tags write. Consume-now so the
        // outbox keeps its dedupe contract in the meantime.
        await recordRows(db, "app.record_classifications", payload);
      }),
    "musebook-embed": (m) =>
      consume(env, m, "embed", async (db, payload) => {
        // M9: embedding write — existing_embeddings keeps it idempotent.
        await recordRows(db, "app.record_embeddings", payload);
      }),
    "musebook-distribute": (m) =>
      consume(env, m, "distribute", async (db, payload) => {
        // M9-M10: syndication fan-out — record_distribution_jobs is the ledger.
        await recordRows(db, "app.record_distribution_jobs", payload);
      }),
    "musebook-media": (m) =>
      consume(env, m, "media", async () => {
        // M8: transcode/derivatives for the media pipeline.
      }),
    "musebook-media-finalize": (m) =>
      consume(env, m, "media_finalize", async () => {
        // M8: post-upload finalize — marks the asset readable.
      }),
    "musebook-agent-cancel": (m) =>
      consume(env, m, "agent_cancel", async () => {
        // M10: agent task cancellation.
      }),
    "musebook-r2-events": (m) =>
      consume(env, m, "r2_events", async () => {
        // M8: uploads lifecycle — the event carries bucket+key, not a job row;
        // claim/finish is skipped when job_id is absent by consume() itself.
      }),
    "musebook-slates": (m) =>
      consume(env, m, "slates", async (_db, payload) => {
        await runSlateJob(env, payload as unknown as SlateRequest);
      }),
  };

  const dlqHandlers: Record<string, (m: JobMessage) => Promise<void>> = {
    "musebook-classify-dlq": (m) => consumeDlq(env, m, "classify"),
    "musebook-embed-dlq": (m) => consumeDlq(env, m, "embed"),
    "musebook-distribute-dlq": (m) => consumeDlq(env, m, "distribute"),
    "musebook-media-dlq": (m) => consumeDlq(env, m, "media"),
    "musebook-media-finalize-dlq": (m) => consumeDlq(env, m, "media_finalize"),
    "musebook-agent-cancel-dlq": (m) => consumeDlq(env, m, "agent_cancel"),
    "musebook-r2-events-dlq": (m) => consumeDlq(env, m, "r2_events"),
  };

  const handler = handlers[batch.queue] ?? dlqHandlers[batch.queue];
  await Promise.all(
    batch.messages.map(async (message) => {
      const body = message.body as JobMessage;
      if (handler === undefined) {
        message.ack();
        return;
      }
      try {
        await handler(body);
        message.ack();
      } catch {
        message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
      }
    }),
  );
}
