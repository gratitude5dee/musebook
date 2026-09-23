-- 20260922092200_launch_hardening.sql — M12.
-- One job: the landing page's honest counter (§14.3 S9) needs a network-wide
-- read of the rollup tables, and post_agent_stats_daily is musebook_jobs-only
-- with forced RLS. This is the §13.7.5-compliant public window onto it: jobs
-- plane inside, one un-authenticated aggregate out, nothing per-creator or
-- per-visitor crosses the boundary.
create or replace function app.network_stats_daily()
returns jsonb
language plpgsql
security invoker
set search_path = public, app, pg_temp
as $cmd$
declare
  v_doc jsonb;
begin
  perform app.enter('musebook_jobs');
  -- §14.3 S9's SQL, verbatim: freshest complete day = max(day), which is the
  -- day rollup-daily last finished (always current_date - 1 in steady state).
  select jsonb_build_object(
    'agent_reads', coalesce(sum(a.fetches), 0),
    'paid_reads',  coalesce(sum(a.purchases), 0))
    into v_doc
    from public.post_agent_stats_daily a
   where a.day = (select max(day) from public.post_agent_stats_daily);
  return coalesce(v_doc, '{"agent_reads":0,"paid_reads":0}'::jsonb);
end;
$cmd$;
revoke all on function app.network_stats_daily() from public, anon, authenticated;
grant execute on function app.network_stats_daily() to musebook_worker;
comment on function app.network_stats_daily() is
  'Network-wide agent_read/paid_read totals for the latest rolled-up day — the public, aggregate-only window onto the jobs-plane rollup tables (§13.7.5, §14.3 S9).';
