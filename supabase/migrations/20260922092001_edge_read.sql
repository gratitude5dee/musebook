-- 20260922092001_edge_read.sql — M6's two narrow capabilities, shipped early.
--
-- Registered in §16.8 as:
--   app.read_slate  (verbatim §9.7  — assigned file 20261103090300_muse_mixer.sql@M13)
--   app.finish_job  (verbatim §4.13 — assigned file 20261103090000_classification_battery.sql@M14)
-- M6 needs both: the feed route performs the one slate read and every queue
-- consumer finishes its claim through finish_job. Shipping here under a new
-- filename keeps the registry honest — see DEVIATIONS.md (D37). The later
-- files re-create the same functions with `create or replace`, harmlessly.
--
-- A third change rides along: `ops_events.subject_id`. §17.11.5's verbatim DLQ
-- test queries `ops_events where subject_id = $1`, and no §4 table declares the
-- column. It is additive and indexed for the per-job lookup the dashboard makes.

-- ---------------------------------------------------------------- read_slate
-- THE ONE READ the request path performs. It exists because 4.14's grant matrix
-- admits ONLY musebook_jobs to slates and slate_items, and the surface that has to
-- read a slate is musebook-edge, which connects as the kernel plane. The choice is
-- between widening that matrix and shipping one narrow capability; this is the
-- narrow capability. It returns a rendered page of a slate and nothing else -- no
-- grant rows, no bodies, no scores for posts it did not return.
--
-- `viewer_entitled` here is PRESENTATIONAL: it decides whether a card draws a
-- paywall badge. It is never an authorization. Bytes are still gated by
-- resolveAccess() in the Worker, on HYPERDRIVE_FRESH (section 6, spine invariant 9).
create or replace function app.read_slate(
  p_viewer_user_id  uuid,
  p_viewer_agent_id uuid,
  p_surface         text,
  p_slate_id        uuid,      -- from the cursor; null selects the viewer's newest
  p_after_position  integer,
  p_limit           integer
) returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with s as (
    select *
      from public.slates
     where surface = p_surface
       and (p_slate_id is not null and id = p_slate_id
            or p_slate_id is null
               and (p_viewer_user_id is not null and viewer_user_id = p_viewer_user_id
                    or p_viewer_agent_id is not null and viewer_agent_id = p_viewer_agent_id
                    or p_viewer_user_id is null and p_viewer_agent_id is null
                       and viewer_user_id is null and viewer_agent_id is null))
     order by created_at desc
     limit 1
  ), items as (
    select i.position, i.post_id, i.source, i.score,
           p.content_hash, p.kind, p.slug, p.title, p.published_at,
           p.author_user_id,
           (p.posted_by_agent_id is not null) as creator_is_agent,
           exists (
             select 1 from public.access_grants g
              where g.content_hash = p.content_hash
                and g.revoked_at is null
                and (g.expires_at is null or g.expires_at > now())
                and g.subject_user_id = p_viewer_user_id
           ) as viewer_entitled
      from public.slate_items i
      join s on s.id = i.slate_id
      join public.posts p on p.id = i.post_id
     where i.position > p_after_position
       and p.status = 'published'
       and p.deleted_at is null
     order by i.position
     limit least(greatest(p_limit, 1), 100)
  )
  select jsonb_build_object(
    'slate_id',        (select id from s),
    'surface',         (select surface from s),
    'weights_version', (select weights_version from s),
    'model_version',   (select model_version from s),
    'created_at',      (select created_at from s),
    'expires_at',      (select expires_at from s),
    'candidate_count', (select candidate_count from s),
    'items',           coalesce((select jsonb_agg(to_jsonb(items) order by position) from items),
                                '[]'::jsonb))
  where exists (select 1 from s);
$$;
revoke all on function app.read_slate(uuid, uuid, text, uuid, integer, integer)
  from public, anon, authenticated;
grant execute on function app.read_slate(uuid, uuid, text, uuid, integer, integer)
  to musebook_kernel, musebook_jobs;

-- ---------------------------------------------------------------- finish_job
-- The single statement that terminates a claimed job: flips job_outbox to its
-- terminal state and, when the caller names an event, writes the ops_events row
-- that goes with it — one round trip because the flip and the log are one
-- event; two round trips is how they end up disagreeing. Verbatim §4.13.
create or replace function app.finish_job(
  p_job_id    bigint,
  p_state     job_state,
  p_component text  default 'job',
  p_event     text  default null,     -- null = success, write no ops_events row
  p_error     text  default null,
  p_detail    jsonb default '{}'::jsonb
) returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  perform app.enter('musebook_jobs');

  update public.job_outbox
     set state      = p_state,
         last_error = p_error,
         claimed_at = case when p_state = 'queued' then null else claimed_at end,
         done_at    = case when p_state in ('succeeded','dead') then now() else null end
   where id = p_job_id;

  if p_event is not null then
    insert into public.ops_events (component, event_name, level, outcome, subject_id, metadata)
    values (p_component, p_event,
            case when p_state = 'dead' then 'error' else 'warn' end,
            p_state::text,
            p_job_id::text,
            p_detail || jsonb_build_object('job_id', p_job_id, 'error', p_error));
  end if;
end;
$$;
revoke all on function app.finish_job(bigint, job_state, text, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function app.finish_job(bigint, job_state, text, text, text, jsonb)
  to musebook_worker;

-- ----------------------------------------------------------------- subject_id
-- §17.11.5 asserts the DLQ consumer's ops_events row is findable by job id.
-- Add the column here rather than touching the §4 table body (D38).
alter table public.ops_events add column subject_id text;
create index ops_events_subject_idx on public.ops_events (subject_id, at desc)
  where subject_id is not null;
