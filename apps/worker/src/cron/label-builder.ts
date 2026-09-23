// apps/worker/src/cron/label-builder.ts — §13.4.1's label builder on the
// `*/15 * * * *` slot. `not_dwelled` is never a client event: a reels-surface
// `impression` that settled (older than the session-settle window) with no
// `dwell`, `play`, `play_through` or `view` row in the same `view_session_id`
// is a negative training label, and the scorer's five-part corpus counts it.
//
// Exactly-once by construction: the insert's own `not exists` on a prior
// `not_dwelled` row makes a re-run a no-op, and the label builder is the only
// writer of that action_kind (M15.7's invariant 3). One statement per tick,
// jobs-plane role, bounded by SETTLE + BACKSCAN so an old partition never
// floods a tick.
import { pgFreshJobs } from "../db.js";

/** How long an impression may sit before "no dwell" means "will never dwell"
 *  — the same 15-minute slot this cron runs on. */
const SETTLE_MINUTES = 15;
/** An impression older than this is outside the training window anyway — the
 *  backscan is the crash-recovery bound, not the working set. */
const BACKSCAN_HOURS = 48;
/** Upper bound per tick; the predicate is index-covered so the cap is a
 *  statement-cost guard, not a cursor. */
const TICK_LIMIT = 20_000;

export async function deriveNotDwelledLabels(env: Env): Promise<number> {
  const db = await pgFreshJobs(env);
  try {
    const { rows } = await db.query<{ n: string }>(
      `with ins as (
       insert into public.action_events
         (occurred_at, actor_plane, viewer_user_id, actor_agent_id, post_id,
          action, surface, slate_id, position, weights_version, model_version,
          dwell_ms, client, ip_hash, request_id,
          view_session_id, content_hash, outcome)
       select i.occurred_at + ($1 || ' minutes')::interval,
              i.actor_plane, i.viewer_user_id, null::uuid,
              i.post_id, 'not_dwelled'::action_kind, i.surface, i.slate_id,
              i.position, i.weights_version, i.model_version,
              null, i.client, i.ip_hash, i.request_id,
              i.view_session_id, i.content_hash, 'ok'
         from (
           select * from public.action_events i0
            where i0.action = 'impression'
              and i0.surface = 'reels'
              and i0.actor_plane = 'human'
              and i0.view_session_id is not null
              and i0.post_id is not null
              and i0.occurred_at < now() - ($1 || ' minutes')::interval
              and i0.occurred_at > now() - ($2 || ' hours')::interval
            order by i0.occurred_at
            limit $3
         ) i
        where not exists (
          select 1 from public.action_events d
           where d.view_session_id = i.view_session_id
             and d.post_id = i.post_id
             and d.action in ('dwell', 'play', 'play_through', 'view'))
          and not exists (
          select 1 from public.action_events n
           where n.view_session_id = i.view_session_id
             and n.post_id = i.post_id
             and n.action = 'not_dwelled')
       on conflict (actor_plane, occurred_at, event_id) do nothing
       returning 1)
       select count(*)::text as n from ins`,
      [SETTLE_MINUTES, BACKSCAN_HOURS, TICK_LIMIT],
    );
    return Number(rows[0]?.n ?? 0);
  } finally {
    await db.end();
  }
}
