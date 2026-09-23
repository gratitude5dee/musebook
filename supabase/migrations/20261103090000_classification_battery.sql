-- supabase/migrations/20261103090000_classification_battery.sql
-- plan.md §8.7 — the full battery column set on post_classifications,
-- app.classification_state (the privacy gate), app.write_classification
-- (the atomic upsert) and the enqueue-unclassified pg_cron schedule.
--
-- Deviations from the plan text (recorded in DEVIATIONS.md):
--  * agent_identities has no `model` column, which the §8.7 verbatim
--    selects for state.author.agent_model — added additively below.
--  * cron.schedule is wrapped in the pg_extension guard ops.sql uses:
--    pg_cron is not installed on the local Supabase image, and a bare
--    `select cron.schedule` fails the whole migration there.
--  * app.finish_job already shipped verbatim at M6 in
--    20260922092001_edge_read.sql (subject_id line included); re-asserted
--    here per §4.18's registry so this file is self-contained.

alter table public.agent_identities
  add column if not exists model text;

-- §8.7's classification_state selects ar.runtime for state.artifact; the
-- column arrives with the artifact-runtime milestone in the plan. Added
-- additively now so the verbatim function compiles (null until populated).
alter table public.artifacts
  add column if not exists runtime text;

-- Columns the Jev battery produces that 4.6's post_classifications does not carry.
-- Additive only. Every probability column is p_-prefixed because 4.6 already owns
-- the unprefixed booleans is_nsfw and is_ai_generated. The rubric-fed columns
-- (quality, audience_level, agent_value) are deliberately UNPREFIXED, matching
-- 4.18's registry; the score-vs-noul distinction is carried by
-- packages/classify/src/features.ts, not by spelling (§8.4).

alter table public.post_classifications
  add column if not exists question_set_version   text,
  add column if not exists taxonomy_version       text,
  add column if not exists taxonomy_path          text[] not null default '{}',
  add column if not exists taxonomy_leaf          text,
  add column if not exists taxonomy_score         real,
  add column if not exists medium                 text,
  add column if not exists medium_confidence      real,
  add column if not exists tone                   text,
  add column if not exists audience_level         real,
  add column if not exists audience_level_label   text,
  add column if not exists agent_value            real,
  add column if not exists agent_value_confidence real,
  add column if not exists topic_probabilities    jsonb   not null default '{}'::jsonb,
  add column if not exists p_unsafe               real,
  add column if not exists p_nsfw                 real,
  add column if not exists p_brand_unsafe         real,
  add column if not exists p_ai_generated         real,
  add column if not exists p_discloses_ai         real,
  add column if not exists p_contains_pii         real,
  add column if not exists input_tokens           integer,
  add column if not exists request_id             text;

alter table public.post_classifications
  add constraint post_classifications_provider_allowed
    check (provider in ('typesafe_jev', 'heuristic')),
  add constraint post_classifications_battery_bounded check (
    (audience_level is null or audience_level between 0 and 1) and
    (agent_value    is null or agent_value    between 0 and 1) and
    (taxonomy_score is null or taxonomy_score between 0 and 1) and
    (p_unsafe       is null or p_unsafe       between 0 and 1) and
    (p_nsfw         is null or p_nsfw         between 0 and 1) and
    (p_brand_unsafe is null or p_brand_unsafe between 0 and 1) and
    (p_ai_generated is null or p_ai_generated between 0 and 1) and
    (p_discloses_ai is null or p_discloses_ai between 0 and 1) and
    (p_contains_pii is null or p_contains_pii between 0 and 1)
  );

create index if not exists post_classifications_taxonomy_leaf_idx
  on public.post_classifications (taxonomy_leaf) where taxonomy_leaf is not null;
create index if not exists post_classifications_taxonomy_path_gin
  on public.post_classifications using gin (taxonomy_path);
create index if not exists post_classifications_agent_value_idx
  on public.post_classifications (agent_value desc nulls last);
create index if not exists post_classifications_stale_idx
  on public.post_classifications (question_set_version, model);

-- --------------------------------------------------------------------------
-- CAPABILITY 1 — the ONLY door from the jobs plane to a post body.
--
-- SECURITY DEFINER, so it runs as the owner and is exempt from the class (2)
-- policies that (correctly) keep musebook_jobs out of post_bodies. That is the
-- point: the grant is narrow, the projection is fixed, and the status filter
-- lives in SQL rather than in TypeScript where a later refactor could drop it.
-- It answers the cache question in the same round trip: NULL means either
-- "already classified at this exact version" or "not a classifiable post",
-- and both are terminal for the job.
-- --------------------------------------------------------------------------
create or replace function app.classification_state(
  p_content_hash          text,
  p_question_set_version  text,
  p_taxonomy_version      text,
  p_model                 text,
  p_force                 boolean default false
) returns jsonb
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  with post as (
    select p.id, p.kind, p.title, p.summary, p.language_code, p.tags,
           p.posted_by_agent_id, b.canonical_markdown
      from public.posts p
      join public.post_bodies b on b.content_hash = p.content_hash
     where p.content_hash = p_content_hash
       and p.deleted_at is null
       -- THE PRIVACY FILTER. draft, pending_approval and removed never leave.
       and p.status in ('published','scheduled','unlisted')
     order by p.published_at asc nulls last, p.created_at asc
     limit 1
  ),
  fresh as (
    select 1 from public.post_classifications c
     where c.content_hash         = p_content_hash
       and c.provider             = 'typesafe_jev'
       and c.question_set_version = p_question_set_version
       and c.taxonomy_version     = p_taxonomy_version
       and c.model                = p_model
  )
  select case
    when not p_force and exists (select 1 from fresh) then null   -- cache hit
    else (
      select jsonb_build_object(
        'post_id',           post.id,
        'kind',              post.kind,
        'title',             post.title,
        'summary',           post.summary,
        -- Truncated here as well as in truncateBody(): the 12 000-character
        -- budget must hold even if a future caller forgets the TS helper.
        'body',              left(post.canonical_markdown, 12000),
        'declared_tags',     to_jsonb(post.tags),
        'declared_language', post.language_code,
        'author', jsonb_build_object(
          'kind',        case when post.posted_by_agent_id is null then 'human' else 'agent' end,
          'agent_model', (select a.model from public.agent_identities a
                           where a.id = post.posted_by_agent_id)),
        'media', coalesce((
          select jsonb_agg(jsonb_build_object(
                   'content_type', s.content_type,
                   'duration_ms',  s.duration_ms,
                   'alt_text',     s.alt_text) order by pa.position)
            from public.post_assets pa
            join public.assets s on s.id = pa.asset_id
           where pa.post_id = post.id), '[]'::jsonb),
        'artifact', (select jsonb_build_object('runtime', ar.runtime)
                       from public.artifacts ar where ar.post_id = post.id)
      ) from post
    )
  end;
$$;
revoke all on function app.classification_state(text,text,text,text,boolean)
  from public, anon, authenticated;
grant execute on function app.classification_state(text,text,text,text,boolean)
  to musebook_worker;

-- --------------------------------------------------------------------------
-- CAPABILITY 2 — write the narrow row and the raw blob atomically, under the
-- jobs plane, in ONE round trip and ONE implicit transaction. Never an explicit
-- BEGIN/COMMIT: Hyperdrive pins a pooled connection for the whole of one and
-- the pool is ~100 connections wide per configuration (CF-SPINE §2, §4.13).
-- --------------------------------------------------------------------------
create or replace function app.write_classification(p_narrow jsonb, p_raw jsonb)
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare n public.post_classifications%rowtype;
begin
  perform app.enter('musebook_jobs');
  n := jsonb_populate_record(null::public.post_classifications, p_narrow);
  n.classified_at := now();

  insert into public.post_classifications select (n).*
  on conflict (content_hash) do update set
    provider = excluded.provider, model = excluded.model,
    question_set_version = excluded.question_set_version,
    taxonomy_version = excluded.taxonomy_version,
    primary_topic = excluded.primary_topic, topics = excluded.topics,
    topic_probabilities = excluded.topic_probabilities, language_code = excluded.language_code,
    quality = excluded.quality, toxicity = excluded.toxicity, spam = excluded.spam,
    commercial_intent = excluded.commercial_intent, is_nsfw = excluded.is_nsfw,
    is_ai_generated = excluded.is_ai_generated, taxonomy_path = excluded.taxonomy_path,
    taxonomy_leaf = excluded.taxonomy_leaf, taxonomy_score = excluded.taxonomy_score,
    medium = excluded.medium, medium_confidence = excluded.medium_confidence,
    tone = excluded.tone, audience_level = excluded.audience_level,
    audience_level_label = excluded.audience_level_label, agent_value = excluded.agent_value,
    agent_value_confidence = excluded.agent_value_confidence,
    p_unsafe = excluded.p_unsafe, p_nsfw = excluded.p_nsfw,
    p_brand_unsafe = excluded.p_brand_unsafe, p_ai_generated = excluded.p_ai_generated,
    p_discloses_ai = excluded.p_discloses_ai, p_contains_pii = excluded.p_contains_pii,
    input_tokens = excluded.input_tokens, request_id = excluded.request_id,
    latency_ms = excluded.latency_ms, classified_at = excluded.classified_at
  -- A heuristic row is always upgraded by a real one. A real row is NEVER
  -- downgraded by a heuristic one: without the second clause, a degraded write
  -- arriving after a successful classification would blank every model
  -- judgment, because `question_set_version IS DISTINCT FROM null` is true. An
  -- identical re-classification matches no clause at all and is a no-op, which
  -- is what makes at-least-once redelivery free (§8.9).
  where post_classifications.provider = 'heuristic'
     or (excluded.provider <> 'heuristic' and (
           post_classifications.question_set_version is distinct from excluded.question_set_version
        or post_classifications.taxonomy_version     is distinct from excluded.taxonomy_version
        or post_classifications.model                is distinct from excluded.model));

  -- The raw blob is the training and audit record. Written in the same
  -- transaction, and only by the provider path: a heuristic write passes null.
  if p_raw is not null then
    insert into public.post_classifications_raw (content_hash, provider, request_id, raw)
    values (n.content_hash, n.provider, n.request_id, p_raw)
    on conflict (content_hash) do update set
      provider = excluded.provider, request_id = excluded.request_id,
      raw = excluded.raw, created_at = now();
  end if;
end;
$$;
revoke all on function app.write_classification(jsonb, jsonb) from public, anon, authenticated;
grant execute on function app.write_classification(jsonb, jsonb) to musebook_worker;

-- --------------------------------------------------------------------------
-- CAPABILITY 3 — the finisher 4.13's claim_job() has no counterpart for, and
-- the ops_events writer that goes with it. Shipped verbatim at M6 in
-- 20260922092001_edge_read.sql (its ops_events insert carries subject_id,
-- a superset of the §8.7 text); re-asserted so this file is self-contained
-- on a fresh database.
-- --------------------------------------------------------------------------
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

-- --------------------------------------------------------------------------
-- Safety net: any published post with no real classification row after ten
-- minutes gets an outbox row. The `* * * * *` Cron Worker sweeper (4.13) turns
-- it into a Queues message within ~60 seconds. This is what makes "the post
-- publishes even if the enqueue failed" true rather than aspirational.
--
-- pg_cron, not a Cron Worker: pure SQL, no external service, no Hyperdrive
-- round trip, no Queues operation billed, and no queue extension on this
-- database (4.1). Guarded like ops.sql: pg_cron is absent on the local image.
-- --------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('enqueue-unclassified', '*/5 * * * *', $cron$
      insert into public.job_outbox (kind, dedupe_key, payload)
      select 'classify',
             'classify:' || d.content_hash,
             jsonb_build_object('post_id', d.post_id, 'content_hash', d.content_hash)
        from (
          -- DISTINCT ON is load-bearing: post_bodies is deduplicated by hash, so two
          -- creators can publish byte-identical markdown and share one content_hash,
          -- and ON CONFLICT DO UPDATE cannot affect the same row twice in one
          -- statement -- it raises, and the whole cron tick fails.
          select distinct on (p.content_hash) p.content_hash, p.id as post_id
            from public.posts p
            left join public.post_classifications c on c.content_hash = p.content_hash
           where p.status = 'published'
             and p.deleted_at is null
             and p.published_at < now() - interval '10 minutes'
             and (c.content_hash is null or c.provider = 'heuristic')
           order by p.content_hash, p.published_at asc
           limit 200
        ) d
      on conflict (kind, dedupe_key) do update
         set state = 'queued', attempts = 0, claimed_at = null, done_at = null,
             enqueued_at = null, last_error = null
       where public.job_outbox.state in ('succeeded','failed','dead');
    $cron$);
  else
    raise notice 'pg_cron not installed: skipping enqueue-unclassified';
  end if;
end $$;

-- --------------------------------------------------------------------------
-- §8.8 classify_versions: the one-row table the backfill predicate joins.
-- The plan's first choice was database-level GUCs (alter database postgres
-- set app.question_set_version = '…') written by the M14 deploy step, because
-- pg_cron has no access to a Worker's module constants. That path is
-- UNVERIFIED in the plan and CONFIRMED IMPOSSIBLE here: Supabase's postgres
-- role is not a superuser, and both ALTER DATABASE SET and ALTER ROLE SET
-- are rejected for custom GUCs. §8.8 names this exact fallback: "a one-row
-- public.classify_versions table written by the same deploy step and joined
-- in the predicate — same semantics, one more table."
-- --------------------------------------------------------------------------
create table if not exists public.classify_versions (
  singleton boolean primary key default true check (singleton),
  question_set_version text not null,
  taxonomy_version text not null,
  updated_at timestamptz not null default now()
);

alter table public.classify_versions enable row level security;
alter table public.classify_versions force row level security;
revoke all on public.classify_versions from public, anon, authenticated;
-- Jobs plane only (§4.14): musebook_worker holds no direct grant — readers go
-- through app.classification_state (definer) or the pg_cron backfill, which
-- runs as postgres and bypasses RLS.
grant select, insert, update, delete on public.classify_versions to musebook_jobs;
create policy classify_versions_jobs_all on public.classify_versions
  for all to musebook_jobs using (true) with check (true);

-- --------------------------------------------------------------------------
-- §8.8 classify-backfill: hourly, bounded at 500 rows/hour (~12k posts/day).
-- The consumer cannot be the throttle — Queues autoscales to 250 invocations
-- on backlog growth — so the producer must be. The version predicate joins
-- classify_versions (above) rather than current_setting. Guarded like the
-- enqueue cron: pg_cron is absent on the local image.
-- --------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('classify-backfill', '17 * * * *', $cron$
      insert into public.job_outbox (kind, dedupe_key, payload)
      select 'classify', 'classify:' || d.content_hash,
             jsonb_build_object('content_hash', d.content_hash)
        from (
          select distinct on (c.content_hash) c.content_hash
            from public.post_classifications c
           cross join public.classify_versions v
           where c.provider = 'typesafe_jev'
             and (c.question_set_version is distinct from v.question_set_version
               or c.taxonomy_version     is distinct from v.taxonomy_version)
           order by c.content_hash, c.classified_at asc
           limit 500
        ) d
      on conflict (kind, dedupe_key) do update
         set state = 'queued', attempts = 0, claimed_at = null, done_at = null,
             enqueued_at = null, last_error = null
       where public.job_outbox.state in ('succeeded','failed','dead');
    $cron$);
  else
    raise notice 'pg_cron not installed: skipping classify-backfill';
  end if;
end $$;

-- --------------------------------------------------------------------------
-- §8.9 consumer-side reads. A Worker connects as musebook_worker and needs two
-- aggregates the musebook_jobs role owns: rolling-24h input tokens (the daily
-- budget check) and the 5-minute classify error count (the circuit breaker).
-- Each fn performs app.enter itself: `set local role` is tx-scoped, so it
-- covers the fn's own query, and the caller's implicit transaction ends with
-- the statement. volatile is required — SET is rejected in stable functions.
-- --------------------------------------------------------------------------
create or replace function app.classify_input_tokens_24h()
returns bigint
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_tokens bigint;
begin
  perform app.enter('musebook_jobs');
  select coalesce(sum(c.input_tokens), 0) into v_tokens
    from public.post_classifications c
   where c.provider = 'typesafe_jev'
     and c.classified_at > now() - interval '24 hours';
  return v_tokens;
end;
$$;

revoke all on function app.classify_input_tokens_24h() from public;
grant execute on function app.classify_input_tokens_24h() to musebook_worker;

create or replace function app.classify_errors_5m()
returns integer
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_errors integer;
begin
  perform app.enter('musebook_jobs');
  -- warn counts too: finish_job logs a retryable provider failure at 'warn';
  -- 'rate_limited' is excluded — a 429 already paces itself via retryAfterMs.
  select count(*)::int into v_errors
    from public.ops_events
   where component = 'classify'
     and level in ('warn','error')
     and event_name <> 'rate_limited'
     and at > now() - interval '5 minutes';
  return v_errors;
end;
$$;

revoke all on function app.classify_errors_5m() from public;
grant execute on function app.classify_errors_5m() to musebook_worker;

-- Worker reachability for public.bump_ops_counter: the counter is SECURITY
-- DEFINER, so EXECUTE is the whole seam — an app.* invoker wrapper would
-- still permission-check the inner call as the invoker and gain nothing.
grant execute on function public.bump_ops_counter(text, jsonb, bigint, bigint, timestamptz)
  to musebook_worker;
