// apps/worker/src/cron/media-poll.ts — the */5 reconciler (§11.8 step 12,
// §11.7.2). It picks up to 50 jobs still 'queued'/'running' after 60s — the
// deep-safety valve for webhook never arrives / provider dead-lettered the
// request / outbox lost the finalize row. Rows that sat 'queued' >30 minutes
// (submit-side never landed) fail 'provider_timeout' and release the hold.
import {
  backendByName,
  createBackends,
  type BackendName,
  type GenerateJobRef,
} from "@musebook/media";
import { audit } from "../lib/audit.js";
import { pgFreshJobs } from "../db.js";
import { mediaModelStore, type MediaJobRow } from "../consumers/media.js";
import { providerUrlsFor } from "../consumers/media-finalize.js";

const MAX_POLL_BATCH = 50;

/** Which client-side failures end the job (vs. keep polling). */
function isClient(err: unknown): boolean {
  const e = err as { httpStatus?: number };
  return (
    e.httpStatus !== undefined &&
    e.httpStatus >= 400 &&
    e.httpStatus < 500 &&
    e.httpStatus !== 408 &&
    e.httpStatus !== 429
  );
}

export async function mediaPoll(env: Env): Promise<void> {
  const db = await pgFreshJobs(env);
  try {
    const { rows } = await db.query<MediaJobRow>(
      `select * from public.media_jobs
        where status in ('queued','running')
          and created_at < now() - interval '60 seconds'
        order by created_at
        limit ${MAX_POLL_BATCH}`,
    );
    if (!rows.length) return;

    const store = mediaModelStore(db);
    const backends = createBackends(env, store);
    for (const job of rows) {
      try {
        // Submit never ran (outbox lost or consumer crashed between claim and
        // UPDATE) — re-enqueue the submit half and move on. dedupe_key keeps
        // the second trigger a no-op when the first is merely slow.
        if (job.status === "queued" && job.provider_request_id === null) {
          if (Date.parse(job.created_at) < Date.now() - 30 * 60_000) {
            await db.query(
              `select * from public.fail_media_job($1,'failed'::media_job_status,$2)`,
              [
                job.id,
                `provider_timeout: queued ${Math.round((Date.now() - Date.parse(job.created_at)) / 60_000)}m`,
              ],
            );
            continue;
          }
          const { rows: ins } = await db.query<{ id: string }>(
            `insert into public.job_outbox (kind, dedupe_key, payload)
             values ('media', $1, ($2::text)::jsonb)
             on conflict (kind, dedupe_key) do nothing
             returning id`,
            [`media:${job.id}`, JSON.stringify({ media_job_id: job.id })],
          );
          if (ins.length) {
            await env.Q_MEDIA?.send({ job_id: ins[0]!.id, media_job_id: job.id });
          }
          continue;
        }
        if (!job.backend || !job.model_id || !job.provider_request_id) continue;

        const backend = backendByName(backends, job.backend);
        if (!backend) {
          await db.query(`select * from public.fail_media_job($1,'failed'::media_job_status,$2)`, [
            job.id,
            "no_backend_for_model",
          ]);
          continue;
        }

        const urls = providerUrlsFor(job.backend, job.model_id, job.provider_request_id);
        const ref: GenerateJobRef = {
          jobId: job.id,
          backend: job.backend as BackendName,
          modelId: job.model_id,
          providerRequestId: job.provider_request_id,
          estimatedCostAtomic: job.estimated_cost_atomic,
          statusUrl: urls.statusUrl,
          cancelUrl: urls.cancelUrl,
          resultUrl: urls.resultUrl,
        };
        const result = await backend.poll(ref);
        if (result.status === "succeeded" || result.status === "failed") {
          if (result.status === "succeeded") {
            const { rows: ins } = await db.query<{ id: string }>(
              `insert into public.job_outbox (kind, dedupe_key, payload)
               values ('media_finalize', $1, ($2::text)::jsonb)
               on conflict (kind, dedupe_key) do nothing
               returning id`,
              [job.id, JSON.stringify({ media_job_id: job.id, provider: job.backend })],
            );
            if (ins.length) {
              await env.Q_MEDIA_FINALIZE?.send({ job_id: ins[0]!.id, media_job_id: job.id });
            }
          } else {
            await db.query(
              `select * from public.fail_media_job($1,'failed'::media_job_status,$2)`,
              [job.id, `poll:${result.error.slice(0, 120)}`],
            );
          }
          await audit(env, {
            action: "media.poll",
            delegation_id: job.delegation_id,
            target_kind: "media_job",
            target_id: job.id,
            after_state: { poll_status: result.status },
          });
        }
        // 'queued'/'running' is normal — the next */5 cycle re-reads.
      } catch (err) {
        if (isClient(err)) {
          await db.query(`select * from public.fail_media_job($1,'failed'::media_job_status,$2)`, [
            job.id,
            `poll_error:${(err as Error).message.slice(0, 120)}`,
          ]);
        }
        // Transient poll failures leave the row for the next cycle.
      }
    }
  } finally {
    await db.end();
  }
}
