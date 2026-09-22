-- 09. Telemetry: action_events, LIST(actor_plane) -> RANGE(occurred_at, daily).

create table public.action_events (
  event_id        uuid not null default gen_random_uuid(),
  occurred_at     timestamptz not null default now(),
  actor_plane     actor_plane not null,

  viewer_user_id  uuid,
  actor_agent_id  uuid,
  post_id         uuid,
  comment_id      uuid,

  action          action_kind not null,
  surface         text not null,   -- same vocabulary as slates.surface (4.2), 'reels' included

  -- SPINE INVARIANT 3. All four NOT NULL, no defaults. Before a ranker exists the
  -- literals are 'none' and 'reverse_chron'. Omitting them is irreversible data loss.
  slate_id        uuid        not null,
  position        integer     not null,
  weights_version text        not null references public.ranking_weights(weights_version),
  model_version   text        not null references public.model_registry(model_version),

  dwell_ms        integer,
  client          jsonb not null default '{}'::jsonb,
  ip_hash         text,
  request_id      text,

  primary key (actor_plane, occurred_at, event_id),
  constraint action_events_position_non_negative check (position >= 0),
  constraint action_events_plane_actor check (
    (actor_plane = 'human' and viewer_user_id is not null) or
    (actor_plane = 'agent' and actor_agent_id is not null)
  )
) partition by list (actor_plane);

create table public.action_events_human
  partition of public.action_events for values in ('human')
  partition by range (occurred_at);

create table public.action_events_agent
  partition of public.action_events for values in ('agent')
  partition by range (occurred_at);

-- Partitioned indexes cascade to every current and future leaf partition.
create index action_events_post_time_idx   on public.action_events (post_id, occurred_at desc);
create index action_events_viewer_time_idx on public.action_events (viewer_user_id, occurred_at desc);
create index action_events_slate_idx       on public.action_events (slate_id, position);
create index action_events_action_time_idx on public.action_events (action, occurred_at desc);

-- Bootstrap leaves so the first INSERT cannot fail before maintenance runs.
create table public.action_events_human_20260922 partition of public.action_events_human
  for values from ('2026-09-22 00:00+00') to ('2026-09-23 00:00+00');
create table public.action_events_human_20260923 partition of public.action_events_human
  for values from ('2026-09-23 00:00+00') to ('2026-09-24 00:00+00');
create table public.action_events_agent_20260922 partition of public.action_events_agent
  for values from ('2026-09-22 00:00+00') to ('2026-09-23 00:00+00');
create table public.action_events_agent_20260923 partition of public.action_events_agent
  for values from ('2026-09-23 00:00+00') to ('2026-09-24 00:00+00');

-- §4.14 force posture applies to leaf partitions as well; the parent's
-- policies cover their rows but the flags do not cascade.
alter table public.action_events_human_20260922 enable row level security;
alter table public.action_events_human_20260922 force row level security;
alter table public.action_events_human_20260923 enable row level security;
alter table public.action_events_human_20260923 force row level security;
alter table public.action_events_agent_20260922 enable row level security;
alter table public.action_events_agent_20260922 force row level security;
alter table public.action_events_agent_20260923 enable row level security;
alter table public.action_events_agent_20260923 force row level security;

-- Daily aggregate that survives partition drop. Written by the rollup Cron Worker
-- (section 13.7.4), which calls the rollup functions over HYPERDRIVE_FRESH.
create table public.action_events_daily (
  day         date not null,
  actor_plane actor_plane not null,
  post_id     uuid,
  action      action_kind not null,
  n           bigint not null default 0,
  dwell_ms    bigint not null default 0,
  primary key (day, actor_plane, post_id, action)
);
create index action_events_daily_post_idx on public.action_events_daily (post_id, day desc);

alter table public.action_events       enable row level security;  -- jobs plane only (4.14)
alter table public.action_events_daily enable row level security;  -- jobs plane only (4.14)

-- Partition maintenance is the §4.9 deterministic fallback, not pg_partman.
-- create_parent on a table that already carries a bootstrap partition raises
-- "partition would overlap partition" (verified on pg_partman 5.3.1 / PG17):
-- partman tries to create the partitions we declared above itself. Registering
-- the parents first and declaring our own leaves later also collides on the
-- overlap check, so the two approaches cannot coexist on one parent. The
-- fallback the plan sanctions — app.ensure_action_event_partitions on pg_cron —
-- is idempotent and needs no partman state at all.
create or replace function app.ensure_action_event_partitions(p_days_ahead int default 7)
returns void language plpgsql as $$
declare d date; plane text; begin
  foreach plane in array array['human','agent'] loop
    for i in 0..p_days_ahead loop
      d := (current_date + i);
      execute format(
        'create table if not exists public.action_events_%s_%s
           partition of public.action_events_%s
           for values from (%L) to (%L)',
        plane, to_char(d, 'YYYYMMDD'), plane, d::timestamptz, (d + 1)::timestamptz);
      -- §4.14: every table carries FORCE RLS. A new partition is a table, so a
      -- partition created tomorrow without these flags would fail the posture
      -- audit (and PostgREST's rls_disabled_in_public lint) even though the
      -- parent's policies already cover its rows.
      execute format(
        'alter table public.action_events_%s_%s enable row level security',
        plane, to_char(d, 'YYYYMMDD'));
      execute format(
        'alter table public.action_events_%s_%s force row level security',
        plane, to_char(d, 'YYYYMMDD'));
    end loop;
  end loop;
end; $$;

-- pg_cron is only present when the extension is enabled. Hosted Supabase offers
-- it from Database → Extensions (its functions live in the `cron` schema); the
-- local CLI image does not preload it, so on a fresh local/CI stack the
-- schedule is skipped and the function can be run manually or from the Worker.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('action-events-partitions', '17 * * * *',
      'select app.ensure_action_event_partitions(7)');
  else
    raise notice 'pg_cron not enabled; action-events-partitions schedule skipped';
  end if;
end $$;

-- No retention job here either. Creating partitions and dropping them are separate
-- concerns with separate owners: this migration creates, section 13.7.4 drops.
