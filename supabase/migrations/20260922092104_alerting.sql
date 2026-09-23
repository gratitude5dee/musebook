-- alerting (M11): alert_rules (all 28 §15.19 rules seeded), alert_state,
-- public.evaluate_alerts() + its pg_cron schedule.
create extension if not exists pg_net with schema extensions;

create table public.alert_rules (
  name        text primary key,
  severity    text not null,                 -- 'P1' | 'P2' | 'P3'
  sql         text not null,                 -- must return one boolean column named `firing`
  for_minutes integer not null default 1,
  runbook     text not null,                 -- e.g. 'plan section 15.26 R-1'
  enabled     boolean not null default true,
  constraint alert_rules_sev check (severity in ('P1','P2','P3'))
);

create table public.alert_state (
  name          text primary key references public.alert_rules(name) on delete cascade,
  firing_since  timestamptz,
  last_notified timestamptz,
  notify_count  integer not null default 0
);

create or replace function public.evaluate_alerts() returns void
language plpgsql security definer set search_path = public, extensions as $$
declare r record; v_firing boolean; v_since timestamptz; v_url text; v_secret text;
begin
  select current_setting('app.alert_webhook_url', true) into v_url;
  select current_setting('app.alert_webhook_secret', true) into v_secret;

  for r in select * from public.alert_rules where enabled loop
    begin
      execute r.sql into v_firing;
    exception when others then
      v_firing := true;   -- a rule that cannot evaluate is itself an alert
    end;

    insert into public.alert_state (name) values (r.name) on conflict (name) do nothing;
    select firing_since into v_since from public.alert_state where name = r.name;

    if coalesce(v_firing, false) then
      if v_since is null then
        update public.alert_state set firing_since = now() where name = r.name;
      elsif now() - v_since >= make_interval(mins => r.for_minutes)
            and (select coalesce(last_notified, 'epoch'::timestamptz) from public.alert_state where name = r.name)
                < now() - interval '30 minutes' then
        perform net.http_post(
          url := v_url,
          headers := jsonb_build_object('content-type','application/json','x-mb-alert-secret', v_secret),
          body := jsonb_build_object('alert', r.name, 'severity', r.severity,
                                     'runbook', r.runbook, 'since', v_since, 'at', now(),
                                     'evaluator', 'pg_cron')
        );
        update public.alert_state
           set last_notified = now(), notify_count = notify_count + 1
         where name = r.name;
      end if;
    else
      update public.alert_state set firing_since = null where name = r.name;
    end if;
  end loop;

  -- The primary's own heartbeat. The secondary reads this row.
  insert into public.job_heartbeats (job, last_success_at, expected_every)
  values ('evaluate-alerts', now(), interval '1 minute')
  on conflict (job) do update set last_success_at = now(), last_error = null;
end $$;
revoke execute on function public.evaluate_alerts() from public, anon, authenticated;

alter table public.alert_rules enable row level security;
alter table public.alert_state enable row level security;
alter table public.alert_rules force row level security;
alter table public.alert_state force row level security;
grant select on public.alert_rules to musebook_jobs;
create policy alert_rules_jobs on public.alert_rules for select to musebook_jobs using (true);

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('evaluate-alerts', '* * * * *',
      $cmd$select public.evaluate_alerts()$cmd$);
  end if;
end $$;

-- ============================================================== the 28 rules
-- cf-evaluated rules (Evaluator = 'cf' in §15.19.1) are seeded with a `select
-- false` body: evaluate_alerts still selects and heartbeat-covers them, but the
-- firing decision lives in runAlertPass (apps/worker/src/alerts.ts), which reads
-- Analytics Engine, queue metrics and HTTP synthetics that Postgres cannot see.
-- §13.6.1 plane-bleed probes for A17 — one function per plane so no single
-- statement ever names both telemetry partitions (G-PLANE-JOIN).
create or replace function app.plane_bleed_agent_side()
returns boolean
language sql stable
security invoker
set search_path = public, app, pg_temp
as $$
  select exists (select 1 from public.action_events_agent
                  where viewer_user_id is not null or anon_id is not null)
$$;
revoke all on function app.plane_bleed_agent_side() from public, anon, authenticated;
create or replace function app.plane_bleed_human_side()
returns boolean
language sql stable
security invoker
set search_path = public, app, pg_temp
as $$
  select exists (select 1 from public.action_events_human
                  where actor_agent_id is not null or agent_key_thumbprint is not null)
$$;
revoke all on function app.plane_bleed_human_side() from public, anon, authenticated;

insert into public.alert_rules (name, severity, sql, for_minutes, runbook) values

-- A1: gated bytes served free. Target zero, alert at one. Evaluated in BOTH
-- places: pg reads the folded counter (up to 5 min stale but survives a
-- Cloudflare outage), cf reads musebook_paywall directly (fast, but blind if
-- Analytics Engine is unavailable). Duplicate pages on one condition are
-- correct here; a missed one is not.
('paywall.serve_free_gated','P1', $q$
  select coalesce(sum(value),0) > 0 from public.ops_counters
   where metric = 'musebook.kernel.serve_free_gated'
     and bucket_start > now() - interval '10 minutes' $q$, 1, 'plan section 15.26 R-1'),

-- A2: cf half only — blob8 mode on paywall points.
('paywall.mode_not_live','P2', $q$ select false $q$, 5, 'plan section 15.26 R-1'),

-- A3: the paywall is configured on but is not challenging anyone. The Vercel-era
-- shape of this failure was proxy.ts matcher drift; the Cloudflare-era shape is a
-- wrangler.jsonc `routes` edit, or a grey-clouded DNS record. Both present as an
-- ABSENCE, which is why a rule on a zero is necessary at all.
('paywall.no_challenges','P2', $q$
  with c as (select coalesce(sum(value),0) n from public.ops_counters
              where metric='musebook.x402.challenge_issued'
                and bucket_start > now() - interval '60 minutes'),
       f as (select coalesce(sum(value),0) n from public.ops_counters
              where metric='musebook.kernel.decision'
                and labels->>'publish_mode' in ('x402_always','human_free_agent_paid')
                and bucket_start > now() - interval '60 minutes')
  select c.n = 0 and f.n >= 50 from c, f $q$, 5, 'plan section 15.26 R-1'),

-- A4: cf only — per-isolate breaker counters folded from musebook_paywall.
('x402.facilitator_open','P1', $q$ select false $q$, 1, 'plan section 15.26 R-2'),

-- A5: a payer was charged and may not have received bytes.
('x402.settlement_stuck','P1', $q$
  select exists (select 1 from public.x402_settlements
                  where status = 'pending' and created_at < now() - interval '10 minutes') $q$,
  1, 'plan section 15.26 R-3'),

-- A6: settle failure ratio > 2 % over 30 min, at least 20 attempts.
('x402.settle_error_rate','P2', $q$
  with s as (select coalesce(sum(value),0) total,
                    coalesce(sum(value) filter (where labels->>'result' in ('failed','timeout')),0) bad
               from public.ops_counters
              where metric='musebook.x402.settle'
                and bucket_start > now() - interval '30 minutes')
  select total >= 20 and bad::numeric / total > 0.02 from s $q$, 1, 'plan section 15.26 R-2'),

-- A7: > 5 % of slates at build-rung >= B3 or read-rung >= R2 over 10 min (folded).
('mixer.degraded','P2', $q$
  with r as (select labels->>'rung' as rung, sum(value) as n
               from public.ops_counters
              where metric='musebook.mixer.rung'
                and bucket_start > now() - interval '10 minutes'
              group by 1)
  select coalesce(sum(n) filter (where rung ~ 'B[3-9]|R[2-9]'),0)::numeric
         / greatest(sum(n),1) > 0.05
       and sum(n) > 100 from r $q$, 1, 'plan section 15.26 R-5'),

-- A8: > 1 % result_empty over 10 min.
('mixer.empty_feed','P2', $q$
  with e as (select coalesce(sum(value) filter (where metric='musebook.mixer.result_empty'),0) empty,
                    coalesce(sum(value) filter (where metric='musebook.mixer.rung'),0) served
               from public.ops_counters
              where bucket_start > now() - interval '10 minutes')
  select served > 100 and empty::numeric / served > 0.01 from e $q$, 1, 'plan section 15.26 R-5'),

-- A9: > 1 % of any single side effect over 15 min.
('mixer.side_effect_error','P2', $q$
  with e as (select labels->>'name' as name,
                    sum(value) filter (where metric='musebook.mixer.side_effect_error') as err,
                    sum(value) filter (where metric='musebook.mixer.rung' and labels->>'path' = 'side_effect') as total
               from public.ops_counters
              where bucket_start > now() - interval '15 minutes'
              group by 1)
  select exists (select 1 from e where total > 100 and err::numeric / total > 0.01) $q$,
  1, 'plan section 15.26 R-5'),

-- A10: irreversible training-data loss (spine invariant 3).
('mixer.slate_incomplete','P1', $q$
  select exists (
    select 1 from public.slates
     where created_at > now() - interval '15 minutes'
       and (weights_version is null or weights_version = ''
            or model_version is null or model_version = '')) $q$, 1, 'plan section 15.26 R-5'),

-- A11: reconcile_gap > 0 for 2 consecutive runs (folded counter over 15 min).
('distribute.reconcile_gap','P2', $q$
  select count(*) >= 2 from public.ops_counters
   where metric='musebook.distribute.reconcile_gap' and value > 0
     and bucket_start > now() - interval '15 minutes' $q$, 1, 'plan section 15.26 R-6'),

-- A12: > 5 dropped webhooks in 30 min.
('distribute.webhook_dropped','P2', $q$
  select coalesce(sum(value),0) > 5 from public.ops_counters
   where metric='musebook.distribute.webhook' and labels->>'result'='dropped'
     and bucket_start > now() - interval '30 minutes' $q$, 1, 'plan section 15.26 R-6'),

-- A13: any Postiz 429 in 15 min.
('distribute.rate_limited','P3', $q$
  select coalesce(sum(value),0) > 0 from public.ops_counters
   where metric='musebook.distribute.rate_limited'
     and bucket_start > now() - interval '15 minutes' $q$, 1, 'plan section 15.26 R-6'),

-- A14: > 10 % classify.outcome=degraded over 60 min.
('classify.degraded','P3', $q$
  with c as (select coalesce(sum(value),0) total,
                    coalesce(sum(value) filter (where labels->>'result'='degraded'),0) degraded
               from public.ops_counters
              where metric='musebook.classify.outcome'
                and bucket_start > now() - interval '60 minutes')
  select total > 50 and degraded::numeric / total > 0.10 from c $q$, 1, 'plan section 15.26 R-5'),

-- A15: dead man's switch. Catches "the job stopped and nothing else noticed",
-- which is how retention and reconciliation jobs fail. The subject list is now
-- every `crons` entry across three wrangler.jsonc files plus every
-- cron.schedule in supabase/migrations/ — NOT vercel.json, which no longer
-- schedules anything.
('job.heartbeat_missing','P1', $q$
  select exists (
    select 1 from public.job_heartbeats
     where coalesce(last_success_at,'epoch'::timestamptz) < now() - (expected_every + grace)) $q$,
  1, 'plan section 15.26 R-14'),

-- A16: T18, continuously. A migration applied by hand can undo section 4.14 and
-- nothing else in the system would notice. `relforcerowsecurity` is the half that
-- matters most: without FORCE, the postgres owner is exempt and every policy in
-- the schema is decorative.
('db.rls_regression','P1', $q$
  select exists (select 1 from pg_roles
                  where rolname in ('musebook_worker','musebook_public_reader',
                                    'musebook_kernel','musebook_jobs')
                    and (rolbypassrls or rolsuper))
      or exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                  where n.nspname = 'public' and c.relkind in ('r','p')
                    and c.relispartition = false and c.relforcerowsecurity = false) $q$,
  1, 'plan section 15.26 R-8'),

-- A17: the two telemetry planes must never share a subject (section 13.6.1).
-- Note there is no Analytics Engine half of this rule, and that is not an
-- omission: that store holds no subject identifier at all, so there is nothing
-- in it that could bleed. Each probe lives behind its own one-plane function
-- (defined above): G-PLANE-JOIN fails any single statement that names both
-- partitions, so the OR is evaluated between two functions, never inside one
-- query.
('telemetry.plane_bleed','P1', $q$
  select app.plane_bleed_agent_side() or app.plane_bleed_human_side() $q$,
  1, 'plan section 15.26 R-8'),

-- A18: collector.result=dropped > 2 % over 30 min.
('telemetry.collector_drop','P2', $q$
  with c as (select coalesce(sum(value),0) total,
                    coalesce(sum(value) filter (where labels->>'result'='dropped'),0) dropped
               from public.ops_counters
              where metric='musebook.telemetry.collector'
                and bucket_start > now() - interval '30 minutes')
  select total > 100 and dropped::numeric / total > 0.02 from c $q$, 1, 'plan section 15.26 R-14'),

-- A19: cf only — queue backlog via env.QUEUE.metrics().
('queue.backlog','P2', $q$ select false $q$, 1, 'plan section 15.26 R-14'),

-- A20: any open dsar_requests inside 9 days of due (fires at day 21).
('dsar.deadline','P2', $q$
  select exists (select 1 from public.dsar_requests
                  where completed_at is null and state <> 'refused'
                    and due_at < now() + interval '9 days') $q$, 60, 'plan section 15.26 R-12'),

-- A21: one delegation's held+settled reservations exceed 80 % of its window
-- cap within 2 h of window_start.
('spend.delegation_runaway','P2', $q$
  select exists (
    select 1
      from public.delegations d
      join public.agent_spend_reservations r
        on r.delegation_id = d.id and r.state in ('held','settled')
      left join public.delegation_spend s
        on s.delegation_id = d.id
       and s.window_start = r.window_start
     where d.state = 'active' and d.spend_cap_atomic > 0
       and r.window_start <= now()
       and r.window_start + interval '2 hours' > now()
     group by d.id, d.spend_cap_atomic, r.window_start, s.spent_atomic
    having coalesce(sum(coalesce(r.actual_atomic, r.estimate_atomic)),0)
           + coalesce(s.spent_atomic,0) > 0.8 * d.spend_cap_atomic) $q$,
  1, 'plan section 15.26 R-9'),

-- A22: > 20 internal.auth_fail in 10 min — attack or rotation error.
('internal.auth_fail_spike','P2', $q$
  select coalesce(sum(value),0) > 20 from public.ops_counters
   where metric='musebook.internal.auth_fail'
     and bucket_start > now() - interval '10 minutes' $q$, 1, 'plan section 15.26 R-7'),

-- A23: cf only — GraphQL analytics request-rate / MTD billable rules.
('cost.spend_burn','P2', $q$ select false $q$, 1, 'plan section 15.26 R-15'),

-- A24: S1 burn rate > 14.4x over 1 h (folded http counters: 5xx ratio vs
-- the trailing 7-day hourly median approximation from folded hour buckets).
('slo.budget_burn_fast','P1', $q$
  with last_hr as (
    select coalesce(sum(value) filter (where labels->>'status' like '5%'),0) bad,
           coalesce(sum(value),0) total
      from public.ops_counters
     where metric='musebook.http.requests'
       and bucket_start > now() - interval '1 hour'),
  base as (
    select coalesce(avg(v.bad),0) as median_bad from (
      select sum(value) filter (where labels->>'status' like '5%') as bad
        from public.ops_counters
       where metric='musebook.http.requests'
         and bucket_start between now() - interval '7 days' and now() - interval '1 hour'
       group by date_trunc('hour', bucket_start)) v)
  select last_hr.total > 50 and last_hr.bad > 14.4 * greatest(base.median_bad,1) from last_hr, base $q$,
  1, 'plan section 15.26 R-11'),

-- A25: the Analytics Engine window is 3 months, there is no replay, and Logpush
-- archives workers_trace_events, not an AE dataset. A nightly pass that has not
-- succeeded for 48 hours is 48 hours of firehose that will simply be gone.
-- Section 13.7.6 states this requirement; this is the rule.
('telemetry.ae_rollup_stale','P1', $q$
  select exists (
    select 1 from (select distinct pass from public.telemetry_ae_runs) p
     where coalesce((select max(day) from public.telemetry_ae_runs r
                      where r.pass = p.pass and r.status = 'succeeded'),
                    '-infinity'::date) < (current_date - 2)) $q$,
  1, 'plan section 15.26 R-14'),

-- A26, the pg half of the cross-watch. The cf half is in runAlertPass.
('alerts.evaluator_stale','P1', $q$
  select coalesce((select last_success_at from public.job_heartbeats
                    where job = 'edge-alert-pass'), '-infinity'::timestamptz)
         < now() - interval '20 minutes' $q$, 1, 'plan section 15.26 R-14'),

-- A27: cf only — the synthetic 402 + origin-404 probes.
('edge.gate_bypassable','P1', $q$ select false $q$, 1, 'plan section 15.26 R-16'),

-- A28: cf only — any DLQ with backlogCount > 0.
('queue.dlq_depth','P2', $q$ select false $q$, 1, 'plan section 15.26 R-14');
