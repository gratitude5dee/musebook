// apps/edge/src/enqueue.ts — §4.13.2's outbox write path, verbatim rules:
//   * enqueueJob's durable half is exactly ONE statement — app.enqueue_job
//     inserts the job_outbox row (dedupe-keyed). Never an explicit
//     transaction: it pins a pooled Hyperdrive connection across round
//     trips and degrades the pool.
//   * then a best-effort Q_* queue .send() inside ctx.waitUntil(). The queue
//     message is the fast path over the outbox row, never the record itself —
//     a failed send leaves the row state='queued' for cron/outbox's sweep.
//   * never inline a payload: the limit is 128 KB per message, so the payload
//     carries R2 keys and row ids only.
import { bound, fresh } from "./db/client.js";

export type JobKind =
  "classify" | "embed" | "distribute" | "media" | "media_finalize" | "agent_cancel";

const PAYLOAD_CAP = 128 * 1024;

// §4.13.2's queue map — one producer per kind, no queue that is not here.
const QUEUE_FOR: Readonly<Record<JobKind, (env: Env) => Queue>> = {
  classify: (env) => bound(env.Q_CLASSIFY, "Q_CLASSIFY"),
  embed: (env) => bound(env.Q_EMBED, "Q_EMBED"),
  distribute: (env) => bound(env.Q_DISTRIBUTE, "Q_DISTRIBUTE"),
  media: (env) => bound(env.Q_MEDIA, "Q_MEDIA"),
  media_finalize: (env) => bound(env.Q_MEDIA_FINALIZE, "Q_MEDIA_FINALIZE"),
  agent_cancel: (env) => bound(env.Q_AGENT_CANCEL, "Q_AGENT_CANCEL"),
};

export async function enqueueJob(
  env: Env,
  ctx: ExecutionContext,
  kind: JobKind,
  dedupeKey: string,
  payload: Record<string, unknown>,
  actorUserId: string | null = null,
): Promise<number | null> {
  const body = JSON.stringify(payload);
  if (body.length >= PAYLOAD_CAP) {
    throw new Error(`job payload exceeds 128KB cap: ${body.length} bytes (kind=${kind})`);
  }
  const db = fresh(env);
  let jobId: number | null;
  try {
    const { rows } = await db.query<{ id: string | null }>(
      "select app.enqueue_job($1, $2, $3::jsonb, $4::uuid) as id",
      [kind, dedupeKey, body, actorUserId],
    );
    jobId = rows[0]?.id === null || rows[0]?.id === undefined ? null : Number(rows[0].id);
  } finally {
    await db.end().catch(() => undefined);
  }
  if (jobId !== null) {
    const message = JSON.stringify({ job_id: jobId, kind, dedupe_key: dedupeKey });
    ctx.waitUntil(
      QUEUE_FOR[kind](env)
        .send(message)
        .catch(() => undefined),
    );
  }
  return jobId;
}

/** §4.13.1's publish path, verbatim: one `publish_post` round trip — the posts
 *  update, the post_versions link and the three job_outbox rows in a single
 *  statement — then best-effort Q_* sends inside ctx.waitUntil. */
export async function publishPost(
  env: Env,
  ctx: ExecutionContext,
  postId: string,
  platforms: string[],
): Promise<{ postId: string; jobIds: number[] }> {
  const db = fresh(env);
  let jobIds: number[];
  try {
    const { rows } = await db.query<{ post_id: string; job_ids: string[] }>(
      "select * from public.publish_post($1, $2)",
      [postId, platforms],
    );
    jobIds = rows[0]?.job_ids.map(Number) ?? [];
  } finally {
    await db.end().catch(() => undefined);
  }

  // Fast path only. If this throws, or the isolate dies here, the rows are
  // already durable and the * * * * * sweeper picks them up within ~60 s.
  ctx.waitUntil(
    (async () => {
      try {
        await bound(env.Q_CLASSIFY, "Q_CLASSIFY").sendBatch([{ body: { job_id: jobIds[0] } }]);
        await bound(env.Q_EMBED, "Q_EMBED").send({ job_id: jobIds[1] });
        await bound(env.Q_DISTRIBUTE, "Q_DISTRIBUTE").send({ job_id: jobIds[2] });
      } catch (e) {
        console.error("enqueue_deferred", String(e));
      }
    })(),
  );
  return { postId, jobIds };
}
