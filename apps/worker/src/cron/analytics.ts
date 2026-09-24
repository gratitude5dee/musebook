// apps/worker/src/cron/analytics.ts — §12.3.10's decaying collector, hourly.
// One Postiz analytics call per due tick per succeeded job on an
// analytics-capable platform; platform_analytics is upserted daily, then the
// yesterday->today delta projects into action_events_daily with
// source = the platform slug (never 'musebook').
import {
  collectionComplete,
  dueTicks,
  normalize,
  postizClient,
  type DistributorEnv,
} from "@musebook/distributor";
import { jobsTx, pgFresh } from "../db.js";

const MAX_JOBS_PER_TICK = 50;

interface CollectableJob {
  id: string;
  channel_id: string;
  postiz_post_id: string;
  platform_post_id: string | null;
  scheduled_for: string;
  platform: string;
}

export async function collectPlatformAnalytics(env: Env): Promise<void> {
  if ((env as { DISTRIBUTION_ENABLED?: string }).DISTRIBUTION_ENABLED !== "true") {
    return;
  }
  const db = await pgFresh(env);
  try {
    const { rows: jobs } = await jobsTx(db, async () =>
      db.query<CollectableJob>(
        `select dj.id::text, dj.channel_id::text, dj.postiz_post_id,
              dj.platform_post_id, dj.scheduled_for::text, c.platform
         from public.distribution_jobs dj
         join public.channels c on c.id = dj.channel_id
         join public.platforms p on p.slug = c.platform
        where dj.state = 'succeeded'
          and dj.postiz_post_id is not null
          and p.analytics_supported
          and dj.scheduled_for > now() - interval '8 days'
        order by dj.scheduled_for
        limit $1`,
        [MAX_JOBS_PER_TICK],
      ),
    );

    // Built lazily inside the loop: an empty tick must not require the
    // sidecar's config at all, while a pending job with no key stays loud.
    let client: ReturnType<typeof postizClient> | null = null;
    const getClient = () => (client ??= postizClient(env as unknown as DistributorEnv));
    const now = new Date();
    const today = now.toISOString().slice(0, 10);

    for (const job of jobs) {
      const publishedAt = new Date(job.scheduled_for);
      if (collectionComplete(publishedAt, now)) continue;
      const due = dueTicks(publishedAt, now);
      if (due.length === 0) continue;
      // Already collected today -> all remaining ticks ride the next day.
      const { rows: have } = await jobsTx(db, async () =>
        db.query<{ n: string }>(
          `select count(1)::text as n from public.platform_analytics
            where channel_id = $1::uuid and platform_post_id = $2
              and collected_for = $3::date`,
          [job.channel_id, job.postiz_post_id, today],
        ),
      );
      if (Number(have[0]?.n ?? "0") > 0) continue;

      let series;
      try {
        series = await getClient().postAnalytics(job.postiz_post_id, Math.max(...due));
      } catch {
        continue; // provider quota or a Postiz hiccup — next tick retries
      }
      const metrics = normalize(series);
      await jobsTx(db, async () => {
        await db.query(
          `insert into public.platform_analytics
           (channel_id, platform_post_id, post_id, collected_for,
            impressions, likes, comments, shares, reposts, saves, clicks, raw)
         select dj.channel_id, dj.postiz_post_id, dj.post_id, $2::date,
                $3, $4, $5, $6, $7, $8, $9, ($10::text)::jsonb
           from public.distribution_jobs dj
          where dj.id = $1::uuid
         on conflict (channel_id, platform_post_id, collected_for)
         do update set impressions = excluded.impressions, likes = excluded.likes,
                       comments = excluded.comments, shares = excluded.shares,
                       reposts = excluded.reposts, saves = excluded.saves,
                       clicks = excluded.clicks, raw = excluded.raw`,
          [
            job.id,
            today,
            metrics.impressions,
            metrics.likes,
            metrics.comments,
            metrics.shares,
            metrics.reposts,
            metrics.saves,
            metrics.clicks,
            JSON.stringify(series),
          ],
        );
      });
    }

    // §12.3.10 verbatim: project yesterday->today deltas into
    // action_events_daily — cumulative totals would report lifetime activity
    // as a single day's, every day, so the projection is a greatest(0) delta.
    await jobsTx(db, async () => {
      await db.query(
        `with today as (
         select pa.post_id, c.platform, pa.collected_for,
                pa.impressions, pa.likes, pa.comments, pa.shares, pa.reposts, pa.saves, pa.clicks
         from public.platform_analytics pa
         join public.channels c on c.id = pa.channel_id
         where pa.collected_for = $1::date and pa.post_id is not null
       ),
       prev as (
         select pa.post_id, c.platform,
                pa.impressions, pa.likes, pa.comments, pa.shares, pa.reposts, pa.saves, pa.clicks
         from public.platform_analytics pa
         join public.channels c on c.id = pa.channel_id
         where pa.collected_for = ($1::date - 1) and pa.post_id is not null
       ),
       delta as (
         select t.post_id, t.platform, t.collected_for as day,
                greatest(t.impressions - coalesce(p.impressions, 0), 0) as impression,
                greatest(t.likes       - coalesce(p.likes, 0),       0) as "like",
                greatest(t.comments    - coalesce(p.comments, 0),    0) as comment,
                greatest(t.shares      - coalesce(p.shares, 0),      0) as share,
                greatest(t.reposts     - coalesce(p.reposts, 0),     0) as repost,
                greatest(t.saves       - coalesce(p.saves, 0),       0) as bookmark
         from today t left join prev p
           on p.post_id = t.post_id and p.platform = t.platform
       )
       insert into public.action_events_daily (day, actor_plane, source, post_id, action, n, dwell_ms)
       select d.day, 'human'::actor_plane, d.platform, d.post_id, k.action, k.n, 0
       from delta d
       cross join lateral (values
         ('impression'::action_kind, d.impression),
         ('like',                    d."like"),
         ('comment',                 d.comment),
         ('share',                   d.share),
         ('repost',                  d.repost),
         ('bookmark',                d.bookmark)
       ) as k(action, n)
       where k.n > 0
       on conflict (day, actor_plane, source, post_id, action)
       do update set n = excluded.n`,
        [today],
      );
    });
  } finally {
    await db.end();
  }
}
