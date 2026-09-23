// apps/worker/src/consumers/index.ts — the queue() dispatch. One case per
// queue; every consumer claims the outbox row first so a redelivered message
// is a no-op, then finishes it. Dead-letter handling is per queue below.
import { claimJob, finishJob, pgFresh, retryDelaySeconds, type DbClient } from "../db.js";
import { consumeEmbedBatch } from "./embed.js";
import { classifyQueue } from "./classify.js";
import { runSlateJob, type SlateRequest } from "../slate-builder.js";
import { consumeDlq } from "./dlq.js";
import { handleR2ObjectCreated } from "./r2-events.js";
import { runAgentCancel } from "./agent-cancel.js";
import { runDistribute } from "./distribute.js";
import { runDsar } from "./dsar.js";

interface JobMessage {
  // postgres.js returns int8 as BigInt; producers JSON.stringify it away but a
  // hand-built batch (tests, a future caller) can still carry it — coerce.
  job_id?: number | bigint;
  kind?: string;
  dedupe_key?: string;
  // §12.2.6 webhook hints share this batch type — a raw DistributionMessage,
  // not an outbox claim. Dispatch routes on queue, not shape.
  stage?: string;
  // R2 event notifications share this batch type — dispatch routes on queue,
  // not shape.
  object?: { key?: string };
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
  "musebook-dsar": "dsar",
  "musebook-slates": "slates",
  "musebook-classify-dlq": "classify",
  "musebook-embed-dlq": "embed",
  "musebook-distribute-dlq": "distribute",
  "musebook-media-dlq": "media",
  "musebook-media-finalize-dlq": "media_finalize",
  "musebook-agent-cancel-dlq": "agent_cancel",
  "musebook-r2-events-dlq": "r2_events",
  "musebook-dsar-dlq": "dsar",
};

export { retryDelaySeconds };

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

/** batch.queue -> handler. `void batch` discipline: every message is acked or
 *  retried explicitly; nothing falls off the end of a batch. */
export async function dispatch(batch: MessageBatch, env: Env): Promise<void> {
  const handlers: Record<string, (m: JobMessage) => Promise<void>> = {
    "musebook-distribute": (m) => {
      // A message with no job_id is the Postiz webhook's raw reconcile hint
      // (§12.2.6): no outbox row exists for it, so it cannot be claimed — and
      // needs no dedupe because the stage is a read-then-conditional-write.
      // Only 'reconcile' may arrive outboxless; every other stage is produced
      // by insertStageJob behind a claim, so anything else is a producer bug
      // worth surfacing (it lands in the DLQ like any throw).
      if (jobIdOf(m) === null) {
        if (m.stage !== "reconcile") {
          throw new Error("distribute: outboxless message with non-reconcile stage");
        }
        return (async () => {
          const db = await pgFresh(env);
          try {
            await runDistribute(db, env, m as unknown as Record<string, unknown>);
          } finally {
            await db.end();
          }
        })();
      }
      return consume(env, m, "distribute", async (db, payload) => {
        await runDistribute(db, env, payload);
      });
    },
    "musebook-media": (m) =>
      consume(env, m, "media", async () => {
        // M8: transcode/derivatives for the media pipeline.
      }),
    "musebook-media-finalize": (m) =>
      consume(env, m, "media_finalize", async () => {
        // M8: post-upload finalize — marks the asset readable.
      }),
    "musebook-agent-cancel": (m) =>
      consume(env, m, "agent_cancel", async (_db, payload) => {
        await runAgentCancel(env, payload);
      }),
    "musebook-r2-events": (m) => handleR2ObjectCreated(env, m),
    "musebook-dsar": (m) =>
      consume(env, m, "dsar", async (db, payload) => {
        await runDsar(db, env, payload);
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
    "musebook-dsar-dlq": (m) => consumeDlq(env, m, "dsar"),
  };

  // §9.23: embed is batch-shaped — one gateway call per ≤100 claimed jobs,
  // so it owns the whole MessageBatch and does its own ack/retry.
  if (batch.queue === "musebook-embed") {
    await consumeEmbedBatch(batch, env);
    return;
  }

  // §8.9: classify is batch-shaped too — the circuit breaker and the
  // per-message disposition (ack vs retry-vs-heuristic) own the whole batch.
  if (batch.queue === "musebook-classify") {
    await classifyQueue(batch, env);
    return;
  }

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
