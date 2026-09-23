-- 20260922092105_dsar_jobs.sql — M11.
--
-- The DSAR surface (§15.11) is a queue-driven job kind plus the plane-scoped
-- helpers the edge routes and the worker consumer call. `dsar` is added to
-- the outbox kind set; the route writes one durable row, the sweeper's
-- Q_DSAR send carries it, the consumer does the work.

alter table public.job_outbox drop constraint job_outbox_kind_allowed;
alter table public.job_outbox
  add constraint job_outbox_kind_allowed check (kind in (
    'classify','embed','distribute','media','media_finalize','agent_cancel','dsar'));

-- ------------------------------------------------------------ consent write
-- One statement in, one consent_events row (and, for a signed-in subject, the
-- users.analytics_consent flag §13.4.6 checks) out. Kernel plane because the
-- caller is the reader's own request.
create or replace function app.record_consent_event(
  p_user_id uuid,
  p_anon_id text,
  p_purpose text,
  p_granted boolean,
  p_source  text,
  p_ip_hash text default null
) returns bigint
language plpgsql
security invoker
set search_path = public, app, pg_temp
as $$
declare
  v_id bigint;
begin
  perform app.enter('musebook_kernel', p_user_id);
  insert into public.consent_events (user_id, anon_id, purpose, granted, source)
  values (p_user_id, p_anon_id, p_purpose, p_granted, p_source)
  returning id into v_id;
  if p_user_id is not null and p_purpose = 'analytics' then
    update public.users set analytics_consent = p_granted where id = p_user_id;
  end if;
  return v_id;
end;
$$;
revoke all on function app.record_consent_event(uuid, text, text, boolean, text, text)
  from public, anon, authenticated;
grant execute on function app.record_consent_event(uuid, text, text, boolean, text, text)
  to musebook_worker;

-- -------------------------------------------------------------- dsar intake
create or replace function app.create_dsar_request(
  p_user_id uuid,
  p_agent_id uuid,
  p_kind    text,
  p_note    text default null
) returns uuid
language plpgsql
security invoker
set search_path = public, app, pg_temp
as $$
declare
  v_id uuid;
begin
  perform app.enter('musebook_kernel', p_user_id);
  insert into public.dsar_requests (user_id, agent_id, kind, note)
  values (p_user_id, p_agent_id, p_kind, p_note)
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function app.create_dsar_request(uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function app.create_dsar_request(uuid, uuid, text, text)
  to musebook_worker;

-- The subject's own read-back of a request (status poll, download guard).
-- Kernel plane; the route enforces user_id = caller.
create or replace function app.read_dsar_request(
  p_request_id uuid,
  p_user_id    uuid
) returns table (
  id uuid, kind text, state text, requested_at timestamptz,
  completed_at timestamptz, artifact_key text
)
language plpgsql
security invoker
set search_path = public, app, pg_temp
as $$
begin
  perform app.enter('musebook_kernel', p_user_id);
  return query
    select r.id, r.kind, r.state, r.requested_at, r.completed_at, r.artifact_key
      from public.dsar_requests r
     where r.id = p_request_id and r.user_id = p_user_id;
end;
$$;
revoke all on function app.read_dsar_request(uuid, uuid) from public, anon, authenticated;
grant execute on function app.read_dsar_request(uuid, uuid) to musebook_worker;

-- ------------------------------------------------------------------ the job
-- Consumer half, jobs plane: claim the request, mark it running, return the
-- subject. Idempotent — a redelivered message finds state already 'running'
-- or 'completed' and gets zero rows.
create or replace function app.begin_dsar(p_request_id uuid)
returns table (user_id uuid, agent_id uuid, kind text, state text)
language plpgsql
security invoker
set search_path = public, app, pg_temp
as $$
#variable_conflict use_column
begin
  perform app.enter('musebook_jobs', null);
  update public.dsar_requests
     set state = 'running', started_at = now()
   where id = p_request_id and state in ('received', 'verifying');
  return query
    select r.user_id, r.agent_id, r.kind, r.state
      from public.dsar_requests r where r.id = p_request_id;
end;
$$;

create or replace function app.complete_dsar(
  p_request_id  uuid,
  p_artifact_key text default null,
  p_note         text default null
) returns void
language plpgsql
security invoker
set search_path = public, app, pg_temp
as $$
begin
  perform app.enter('musebook_jobs', null);
  update public.dsar_requests
     set state = 'completed', completed_at = now(),
         artifact_key = coalesce(p_artifact_key, artifact_key),
         note = coalesce(p_note, note)
   where id = p_request_id;
end;
$$;

create or replace function app.fail_dsar(p_request_id uuid, p_note text)
returns void
language plpgsql
security invoker
set search_path = public, app, pg_temp
as $$
begin
  perform app.enter('musebook_jobs', null);
  update public.dsar_requests set state = 'refused', note = p_note
   where id = p_request_id;
end;
$$;

-- §13.9.4 owns the export's contents: every action_events row of the subject,
-- every citations row, and the identity tables. ONE jsonb document, so the
-- consumer's R2 write is a snapshot, not a sequence of round trips.
create or replace function app.collect_dsar_export(p_user_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = public, app, pg_temp
as $$
declare
  v_doc jsonb;
begin
  perform app.enter('musebook_jobs', p_user_id);
  select jsonb_build_object(
    'exported_at', now(),
    'user', (select to_jsonb(u) - 'created_at' from public.users u where u.id = p_user_id),
    'wallets', coalesce((select jsonb_agg(to_jsonb(w)) from public.wallets w
                          where w.user_id = p_user_id), '[]'::jsonb),
    'action_events', coalesce((select jsonb_agg(to_jsonb(e) order by e.occurred_at)
        from public.action_events_human e where e.viewer_user_id = p_user_id), '[]'::jsonb),
    'posts', coalesce((select jsonb_agg(to_jsonb(p)) from public.posts p
                        where p.author_user_id = p_user_id), '[]'::jsonb),
    'dsar_requests', coalesce((select jsonb_agg(to_jsonb(r)) from public.dsar_requests r
                               where r.user_id = p_user_id), '[]'::jsonb)
  ) into v_doc;
  return v_doc;
end;
$$;

revoke all on function app.begin_dsar(uuid)          from public, anon, authenticated;
revoke all on function app.complete_dsar(uuid, text, text) from public, anon, authenticated;
revoke all on function app.fail_dsar(uuid, text)     from public, anon, authenticated;
revoke all on function app.collect_dsar_export(uuid) from public, anon, authenticated;
grant execute on function app.begin_dsar(uuid)          to musebook_worker;
grant execute on function app.complete_dsar(uuid, text, text) to musebook_worker;
grant execute on function app.fail_dsar(uuid, text)     to musebook_worker;
grant execute on function app.collect_dsar_export(uuid) to musebook_worker;

-- The lifecycle sweep's database half: the R2 rule deletes dsar/ objects at
-- 7 days; this nulls artifact_key on requests whose objects have aged out, so
-- the download route returns 410 instead of streaming nothing.
create or replace function app.null_expired_dsar_artifacts()
returns bigint
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare v_n bigint;
begin
  update public.dsar_requests
     set artifact_key = null
   where artifact_key is not null
     and completed_at < now() - interval '7 days';
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke all on function app.null_expired_dsar_artifacts() from public, anon, authenticated;
grant execute on function app.null_expired_dsar_artifacts() to musebook_jobs;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('dsar-artifact-sweep', '30 5 * * *',
      $cmd$select app.null_expired_dsar_artifacts()$cmd$);
  end if;
end $$;

insert into public.job_heartbeats (job, expected_every) values
  ('dsar-artifact-sweep', interval '1 day'),
  ('dsar-consumer',       interval '1 hour')
on conflict (job) do nothing;

-- ------------------------------------------------- /api/creator/stats read
-- §13.8's overview tile set, jobs plane, over the rollup tables only (§13.7.5:
-- the serve path never reads action_events, and rollups are readable nowhere
-- but through this function and the nightly jobs). 28 days, one document.
create or replace function app.creator_dashboard(p_user_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = public, app, pg_temp
as $$
declare
  v_doc jsonb;
begin
  perform app.enter('musebook_jobs', p_user_id);
  select jsonb_build_object(
    'days', 28,
    'days_missing_ae', (select count(distinct d.day)
       from public.post_stats_daily d
      where d.creator_id = p_user_id and d.day >= current_date - 28
        and d.ae_applied_at is null),
    'totals', coalesce((select jsonb_build_object(
        'impressions', sum(d.impressions), 'opens', sum(d.opens),
        'dwell_events', sum(d.dwell_events), 'dwell_ms_total', sum(d.dwell_ms_total),
        'scroll_completes', sum(d.scroll_completes),
        'media_q25', sum(d.media_q25), 'media_q50', sum(d.media_q50), 'media_q75', sum(d.media_q75),
        'likes', sum(d.likes), 'comments', sum(d.comments),
        'reposts', sum(d.reposts), 'bookmarks', sum(d.bookmarks), 'shares', sum(d.shares),
        'agent_fetches', sum(a.fetches), 'distinct_agents', max(a.distinct_agents),
        'signed_agents', max(a.signed_agents), 'mcp_calls', sum(a.mcp_calls),
        'paywall_hits', sum(a.paywall_hits), 'bytes_served', sum(a.bytes_served),
        'purchases', sum(a.purchases), 'revenue_atomic', sum(a.revenue_atomic))
       from public.post_stats_daily d
       left join public.post_agent_stats_daily a on a.day = d.day and a.post_id = d.post_id
      where d.creator_id = p_user_id and d.day >= current_date - 28), '{}'::jsonb),
    'per_day', coalesce((select jsonb_agg(p.doc order by p.day)
       from (select d.day,
                    jsonb_build_object(
                      'day', d.day, 'impressions', sum(d.impressions),
                      'opens', sum(d.opens), 'dwell_ms_total', sum(d.dwell_ms_total),
                      'agent_fetches', sum(a.fetches),
                      'revenue_atomic', sum(a.revenue_atomic)) as doc
               from public.post_stats_daily d
               left join public.post_agent_stats_daily a
                 on a.day = d.day and a.post_id = d.post_id
              where d.creator_id = p_user_id and d.day >= current_date - 28
              group by d.day) p), '[]'::jsonb),
    'per_post', coalesce((select jsonb_agg(j.doc order by j.impressions desc)
       from (select d.post_id, sum(d.impressions) as impressions,
                    jsonb_build_object(
                      'post_id', d.post_id, 'impressions', sum(d.impressions),
                      'opens', sum(d.opens),
                      'agent_fetches', sum(a.fetches), 'purchases', sum(a.purchases),
                      'revenue_atomic', sum(a.revenue_atomic)) as doc
               from public.post_stats_daily d
               left join public.post_agent_stats_daily a
                 on a.day = d.day and a.post_id = d.post_id
              where d.creator_id = p_user_id and d.day >= current_date - 28
              group by d.post_id) j), '[]'::jsonb)
  ) into v_doc;
  return v_doc;
end;
$$;
revoke all on function app.creator_dashboard(uuid) from public, anon, authenticated;
grant execute on function app.creator_dashboard(uuid) to musebook_worker;
