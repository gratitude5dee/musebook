-- ops_metrics (M11): ops_counters, fold, job_heartbeats (§15.17).
create table public.ops_counters (
  bucket_start timestamptz not null,
  metric       text        not null,
  labels       jsonb       not null default '{}'::jsonb,
  value        bigint      not null default 0,
  sum_ms       bigint      not null default 0,   -- for latency-ish metrics; value = count
  primary key (bucket_start, metric, labels)
);
create index ops_counters_metric_idx on public.ops_counters (metric, bucket_start desc);

create or replace function public.bump_ops_counter(
  p_metric text, p_labels jsonb default '{}'::jsonb,
  p_delta  bigint default 1, p_ms bigint default 0,
  p_bucket timestamptz default null                 -- the fold pass backfills a past minute
) returns void
language sql security definer set search_path = public as $$
  insert into public.ops_counters (bucket_start, metric, labels, value, sum_ms)
  values (coalesce(date_trunc('minute', p_bucket), date_trunc('minute', now())),
          p_metric, coalesce(p_labels,'{}'::jsonb), p_delta, p_ms)
  on conflict (bucket_start, metric, labels)
  do update set value = public.ops_counters.value + excluded.value,
                sum_ms = public.ops_counters.sum_ms + excluded.sum_ms;
$$;
revoke execute on function public.bump_ops_counter(text, jsonb, bigint, bigint, timestamptz)
  from public, anon, authenticated;
grant  execute on function public.bump_ops_counter(text, jsonb, bigint, bigint, timestamptz)
  to musebook_jobs, musebook_kernel;

-- Retention: minute buckets for 14 days, then folded to the hour (section 15.12).
create or replace function public.fold_ops_counters() returns void
language sql security definer set search_path = public as $$
  with old as (
    delete from public.ops_counters
     where bucket_start < date_trunc('day', now() - interval '14 days')
       and bucket_start <> date_trunc('hour', bucket_start)
    returning date_trunc('hour', bucket_start) as h, metric, labels, value, sum_ms
  )
  insert into public.ops_counters (bucket_start, metric, labels, value, sum_ms)
  select h, metric, labels, sum(value), sum(sum_ms) from old group by 1,2,3
  on conflict (bucket_start, metric, labels)
  do update set value = public.ops_counters.value + excluded.value,
                sum_ms = public.ops_counters.sum_ms + excluded.sum_ms;
$$;
revoke execute on function public.fold_ops_counters() from public, anon, authenticated;

-- Dead-man's switch substrate: one row per scheduled job, updated on success.
create table public.job_heartbeats (
  job            text primary key,
  last_success_at timestamptz,
  last_error_at   timestamptz,
  last_error      text,
  expected_every  interval not null,
  grace           interval not null default interval '5 minutes'
);

alter table public.ops_counters   enable row level security;
alter table public.job_heartbeats enable row level security;
alter table public.ops_counters   force row level security;
alter table public.job_heartbeats force row level security;
grant select, insert, update on public.ops_counters, public.job_heartbeats to musebook_jobs;
create policy ops_counters_jobs   on public.ops_counters   for all to musebook_jobs using (true) with check (true);
create policy job_heartbeats_jobs on public.job_heartbeats for all to musebook_jobs using (true) with check (true);

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('fold-ops-counters', '17 3 * * *',
      $cmd$select public.fold_ops_counters()$cmd$);
  end if;
end $$;

-- One row per scheduled job: every cron.schedule in supabase/migrations/ plus
-- every cron-driven job in the three Workers' scheduled() switches (§15.19.1 A15).
insert into public.job_heartbeats (job, expected_every) values
  ('action-events-partitions',    interval '1 hour'),
  ('reap-idempotency',            interval '1 hour'),
  ('reap-job-outbox',             interval '1 hour'),
  ('reap-slates',                 interval '1 day'),
  ('reap-wallet-nonces',          interval '1 day'),
  ('reap-internal-nonces',        interval '5 minutes'),
  ('fold-ops-counters',           interval '1 day'),
  ('evaluate-alerts',             interval '1 minute'),
  ('telemetry-salt',              interval '1 day'),
  ('viewer-sequences',            interval '5 minutes'),
  ('rollup-daily-pg',             interval '1 day'),
  ('telemetry-scrub',             interval '1 day'),
  ('telemetry-compact',           interval '1 day'),
  ('rollup-daily-ae',             interval '1 day'),
  ('rollup-creator',              interval '1 day'),
  ('rollup-hourly',               interval '1 hour'),
  ('telemetry-retention',         interval '1 day'),
  ('edge-alert-pass',             interval '5 minutes'),
  ('outbox-sweeper',              interval '1 minute'),
  ('settlements-reconcile',       interval '1 minute'),
  ('distribute-reconcile',        interval '5 minutes'),
  ('agent-suite',                 interval '15 minutes'),
  ('slates-build',                interval '1 hour'),
  ('analytics-export',            interval '1 hour'),
  ('agent-reputation',            interval '1 day'),
  ('asset-domain-check',          interval '7 days'),
  ('channel-constraints-refresh', interval '7 days')
on conflict (job) do nothing;
