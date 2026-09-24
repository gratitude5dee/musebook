-- ---------------------------------------------------------------------------
-- ai_gateway provider id (D156). The §8 battery may serve the identical
-- {state, questions} contract through the Vercel AI Gateway when
-- CLASSIFY_PROVIDER=gateway; rows produced that way tag provider 'ai_gateway'
-- rather than 'typesafe_jev'. Every read that means "a real classifier row,
-- not the heuristic fallback" widens to accept both ids: the freshness cache
-- in classification_state, the stale-row backfill cron, and the 24h
-- input-token meter. Writes were already provider-agnostic — the
-- excluded.provider <> 'heuristic' arm in write_classification covers the new
-- id unchanged.
-- ---------------------------------------------------------------------------

alter table public.post_classifications
  drop constraint post_classifications_provider_allowed;
alter table public.post_classifications
  add constraint post_classifications_provider_allowed
    check (provider in ('typesafe_jev', 'ai_gateway', 'heuristic'));

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
       and c.provider             in ('typesafe_jev','ai_gateway')
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
           where c.provider in ('typesafe_jev','ai_gateway')
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
   where c.provider in ('typesafe_jev','ai_gateway')
     and c.classified_at > now() - interval '24 hours';
  return v_tokens;
end;
$$;

revoke all on function app.classify_input_tokens_24h() from public;
grant execute on function app.classify_input_tokens_24h() to musebook_worker;
