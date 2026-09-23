// apps/worker/src/cron/distribute-reconcile.ts — §12.3.9's state machine,
// the */5 tick that is the REAL authority (webhook hints are only hints).
// Every read is through HYPERDRIVE_FRESH — a cached reconciler re-processes
// rows it already moved, forever.
import { postizClient, type DistributorEnv, type PostizClient } from "@musebook/distributor";
import { jobsTx, pgFresh } from "../db.js";

const MAX_JOBS_PER_TICK = 50;
const MISSING_AFTER_MS = 30 * 60_000; // plan: not found after 30m -> failed

interface StuckJob {
  id: string;
  postiz_post_id: string | null;
  postiz_channel_id: string | null;
  scheduled_for: string;
  state: "queued" | "running";
  attempts: number;
}

export async function distributeReconcile(env: Env): Promise<void> {
  if ((env as { DISTRIBUTION_ENABLED?: string }).DISTRIBUTION_ENABLED !== "true") {
    return;
  }
  const db = await pgFresh(env);
  try {
    // attempts exhausted -> dead (§12.3.9's terminal row), before probing.
    const jobs = await jobsTx(db, async () => {
      await db.query(
        `update public.distribution_jobs
            set state = 'dead', last_error = 'attempts exhausted'
          where state in ('queued','running') and attempts >= 10`,
      );
      const { rows } = await db.query<StuckJob>(
        `select dj.id::text, dj.postiz_post_id, c.postiz_channel_id,
                dj.scheduled_for::text, dj.state::text, dj.created_at::text, dj.attempts
           from public.distribution_jobs dj
           join public.channels c on c.id = dj.channel_id
          where dj.state in ('queued','running')
            and dj.scheduled_for < now() - interval '2 minutes'
          order by dj.scheduled_for
          limit $1`,
        [MAX_JOBS_PER_TICK],
      );
      return rows;
    });
    if (jobs.length === 0) return;

    const now = Date.now();
    // Lazy client: no due jobs means no sidecar calls, so the tick never
    // requires POSTIZ_* config until real work exists.
    let client: ReturnType<typeof postizClient> | null = null;
    const getClient = () => (client ??= postizClient(env as unknown as DistributorEnv));
    // One listPosts call per distinct scheduled_for bucket (§12.2.4's
    // timestamp grouping means a bucket is a tight cluster).
    const bucketCache = new Map<string, Awaited<ReturnType<PostizClient["listPosts"]>>>();
    const listFor = async (scheduledFor: string) => {
      const at = new Date(scheduledFor).getTime();
      const hit = bucketCache.get(scheduledFor);
      if (hit !== undefined) return hit;
      const rows = await getClient().listPosts(
        new Date(at - 5 * 60_000).toISOString(),
        new Date(at + 30 * 60_000).toISOString(),
      );
      bucketCache.set(scheduledFor, rows);
      return rows;
    };

    for (const job of jobs) {
      const scheduledAt = new Date(job.scheduled_for).getTime();
      let posts;
      try {
        posts = await listFor(job.scheduled_for);
      } catch {
        continue; // a Postiz read failure loses nothing — next tick re-probes
      }
      const match =
        posts.find((p) => p.id === job.postiz_post_id) ??
        posts.find(
          (p) =>
            job.postiz_channel_id !== null &&
            p.integration.id === job.postiz_channel_id &&
            Math.abs(new Date(p.publishDate).getTime() - scheduledAt) < 60_000,
        );

      if (match === undefined) {
        if (now - scheduledAt > MISSING_AFTER_MS) {
          await jobsTx(db, async () => {
            await db.query(
              `update public.distribution_jobs
                  set state = 'failed', last_error = 'no matching postiz post'
                where id = $1::uuid`,
              [job.id],
            );
          });
        }
        continue;
      }
      if (match.state === "PUBLISHED") {
        await jobsTx(db, async () => {
          await db.query(
            `update public.distribution_jobs
                set state = 'succeeded', platform_post_url = $2,
                    response_payload = response_payload || $3::jsonb
              where id = $1::uuid`,
            [job.id, match.releaseURL ?? null, JSON.stringify({ reconcile: match })],
          );
        });
      } else if (match.state === "ERROR") {
        await jobsTx(db, async () => {
          await db.query(
            `update public.distribution_jobs
                set state = 'failed', last_error = $2,
                    response_payload = response_payload || $3::jsonb
              where id = $1::uuid`,
            [job.id, match.error ?? "postiz ERROR", JSON.stringify({ reconcile: match })],
          );
        });
      }
      // QUEUE — still in flight on the Postiz side; leave 'running'.
    }
  } finally {
    await db.end();
  }
}
