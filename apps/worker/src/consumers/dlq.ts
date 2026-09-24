// apps/worker/src/consumers/dlq.ts — §4.13.4's dead-letter pass for every
// queue: mark the source job dead and emit the ops_events alert row (the alarm
// lives on ops_events, surfaced by §15's evaluator). musebook-r2-events-dlq is
// covered too — R2 event messages carry no job_id, so the alert row is all
// there is to write for them.
import { finishJob, pgFresh } from "../db.js";

interface DlqMessage {
  job_id?: number | bigint;
  kind?: string;
  dedupe_key?: string;
  object?: { key?: string };
  bucket?: string;
  action?: string;
}

function jobIdOf(msg: DlqMessage): number | null {
  const id = msg.job_id;
  if (typeof id === "bigint") return Number(id);
  return typeof id === "number" ? id : null;
}

export async function consumeDlq(env: Env, msg: DlqMessage, component: string): Promise<void> {
  const jobId = jobIdOf(msg);
  const db = await pgFresh(env);
  try {
    if (jobId !== null) {
      await finishJob(db, jobId, "dead", {
        component,
        event: "dlq_message",
        error: "retries_exhausted",
        detail: { dedupe_key: msg.dedupe_key ?? null },
      });
      return;
    }
    // Non-outbox payloads (R2 object events land here on r2-events-dlq): the
    // alert row is the whole dead-letter record — there is no job to mark.
    await db.query(
      "select app.write_ops_event($1,$2,$3,$4,$5,$6::uuid,($7::text)::jsonb,$8::uuid)",
      [
        "queues",
        "dlq_message",
        "error",
        "retries_exhausted",
        null,
        null,
        JSON.stringify({
          component,
          bucket: msg.bucket ?? null,
          action: msg.action ?? null,
          key: msg.object?.key ?? null,
        }),
        null,
      ],
    );
  } finally {
    await db.end();
  }
}
