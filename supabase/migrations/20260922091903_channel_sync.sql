-- 20260922091903_channel_sync.sql — §12.2.7's channel-sync helpers.
-- The edge route cannot open an explicit transaction over Hyperdrive and
-- musebook_worker holds no direct table grants (noinherit), so the merge is
-- one SECURITY DEFINER call per operation — the same posture as
-- insert_draft_post. Ownership stays in `channels`, never in Postiz.

create or replace function app.sync_postiz_channels(
  p_owner uuid,
  p_items jsonb       -- [{postiz_channel_id, platform, handle, display_name, avatar_url}]
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item     jsonb;
  v_existing record;
  v_channel  uuid;
  v_claimed  int := 0;
  v_updated  int := 0;
  v_skipped  int := 0;
  v_new      jsonb := '[]'::jsonb;
begin
  if jsonb_typeof(p_items) <> 'array' then
    raise exception 'sync_postiz_channels: items must be a jsonb array';
  end if;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    select id, owner_user_id into v_existing
      from public.channels
     where postiz_channel_id = v_item ->> 'postiz_channel_id'
     limit 1;

    if v_existing.id is not null then
      if v_existing.owner_user_id <> p_owner then
        v_skipped := v_skipped + 1;   -- claimed by another creator: leave alone
      else
        -- Ours: platform is mutable (provider migrations rename identifier),
        -- so it is rewritten on every sync, not only on insert.
        update public.channels
           set platform = v_item ->> 'platform',
               handle = v_item ->> 'handle',
               display_name = v_item ->> 'display_name',
               avatar_url = v_item ->> 'avatar_url',
               updated_at = now()
         where id = v_existing.id;
        v_updated := v_updated + 1;
      end if;
    else
      insert into public.channels
        (owner_user_id, platform, postiz_channel_id, handle, display_name, avatar_url)
      values (
        p_owner,
        v_item ->> 'platform',
        v_item ->> 'postiz_channel_id',
        v_item ->> 'handle',
        v_item ->> 'display_name',
        v_item ->> 'avatar_url')
      returning id into v_channel;
      v_claimed := v_claimed + 1;
      v_new := v_new || jsonb_build_object(
        'channel_id', v_channel,
        'postiz_channel_id', v_item ->> 'postiz_channel_id');
    end if;
  end loop;

  return jsonb_build_object(
    'claimed', v_claimed,
    'updated', v_updated,
    'skipped', v_skipped,
    'new_channels', v_new);
end;
$$;

revoke all on function app.sync_postiz_channels(uuid, jsonb) from public, anon, authenticated;
grant execute on function app.sync_postiz_channels(uuid, jsonb) to musebook_worker;

-- One upsert for the per-channel constraint cache (§12.2.7 step 4). FORCE RLS
-- on the table means even the definer enters the jobs plane first.
create or replace function app.channel_constraint_upsert(
  p_channel_id uuid,
  p_max_chars  integer,
  p_rules_text text,
  p_settings   jsonb default null
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform app.enter('musebook_jobs');
  insert into public.channel_constraint_overrides
    (channel_id, max_chars, rules_text, settings_schema, refreshed_at)
  values (p_channel_id, p_max_chars, p_rules_text, coalesce(p_settings, '{}'::jsonb), now())
  on conflict (channel_id) do update
    set max_chars = excluded.max_chars,
        rules_text = excluded.rules_text,
        settings_schema = excluded.settings_schema,
        refreshed_at = now();
end;
$$;

revoke all on function app.channel_constraint_upsert(uuid, integer, text, jsonb)
  from public, anon, authenticated;
grant execute on function app.channel_constraint_upsert(uuid, integer, text, jsonb)
  to musebook_worker;

-- §12.2.9's GET /api/v1/agents/me: the provider needs an id/display name/handle/
-- avatar for the delegation's agent identity. One security-definer read over
-- class-1 tables.
create or replace function app.agent_me(
  p_agent_identity_id uuid,
  p_owner_user_id     uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_agent   record;
  v_owner   record;
begin
  select id, slug, display_name into v_agent
    from public.agent_identities where id = p_agent_identity_id;
  if v_agent.id is null then return null; end if;
  select handle, avatar_url into v_owner
    from public.profiles where user_id = p_owner_user_id;
  return jsonb_build_object(
    'id', v_agent.id,
    'handle', v_agent.slug,
    'display_name', v_agent.display_name,
    'avatar_url', v_owner.avatar_url,
    'owner_handle', v_owner.handle);
end;
$$;

revoke all on function app.agent_me(uuid, uuid) from public, anon, authenticated;
grant execute on function app.agent_me(uuid, uuid) to musebook_worker;

-- §4.13's exactly-once record, endpoint-parameterized (same shape as
-- bridge_result_once): first writer wins; a replay reads the stored response
-- back. (endpoint, key, actor) is the triple-unique index.
create or replace function app.idempotent_record(
  p_endpoint text,
  p_key      text,
  p_actor    text,
  p_response jsonb,
  p_status   integer default 200
) returns table (applied boolean, response_body jsonb)
language plpgsql
security invoker
set search_path = pg_catalog, public, app
as $$
begin
  perform app.enter('musebook_jobs', null);
  return query
    with ins as (
      insert into public.idempotency_keys
        (endpoint, idempotency_key, actor, state, response_status, response_body)
      values (p_endpoint, p_key, p_actor, 'complete', p_status, p_response)
      on conflict (endpoint, idempotency_key, actor) do nothing
      returning idempotency_keys.response_body
    )
    select true, i.response_body from ins i
    union all
    select false, k.response_body
      from public.idempotency_keys k
     where k.endpoint = p_endpoint
       and k.idempotency_key = p_key
       and k.actor = p_actor
       and not exists (select 1 from ins)
    limit 1;
end;
$$;

revoke all on function app.idempotent_record(text, text, text, jsonb, integer)
  from public, anon, authenticated;
grant execute on function app.idempotent_record(text, text, text, jsonb, integer)
  to musebook_worker;

-- §12.3.7's fan-out review: the edge's Edit/Exclude buttons and the
-- validator's inputs. All plane-table access on the edge goes through app.*
-- functions because table ACLs are checked at plan time (noinherit roles).
create or replace function app.platform_constraint_for(p_slug text)
returns jsonb
language plpgsql stable
security invoker
set search_path = pg_catalog, public, app
as $$
begin
  perform app.enter('musebook_kernel', null);
  return (select to_jsonb(p) from public.platforms p where p.slug = p_slug);
end;
$$;

create or replace function app.channel_override_for(p_channel_id uuid)
returns jsonb
language plpgsql stable
security invoker
set search_path = pg_catalog, public, app
as $$
begin
  perform app.enter('musebook_jobs', null);
  return (select to_jsonb(o) from public.channel_constraint_overrides o
           where o.channel_id = p_channel_id);
end;
$$;

create or replace function app.distribute_job_for(
  p_post_version_id uuid,
  p_channel_id      uuid
) returns jsonb
language plpgsql stable
security invoker
set search_path = pg_catalog, public, app
as $$
begin
  perform app.enter('musebook_jobs', null);
  return (
    select to_jsonb(t) from (
      select dj.id, dj.idempotency_key, dj.state, dj.variant_id,
             dj.channel_id, dj.scheduled_for, c.platform
        from public.distribution_jobs dj
        join public.channels c on c.id = dj.channel_id
       where dj.post_version_id = p_post_version_id
         and dj.channel_id = p_channel_id
    ) t);
end;
$$;

-- A human edit (§12.3.7): sets generated_by='human' and stores the edge-run
-- validator report. A failing edit is stored is_valid=false and the channel's
-- job is failed — the UI says so rather than silently dropping it.
create or replace function app.save_edited_variant(
  p_post_version_id uuid,
  p_channel_id      uuid,
  p_body            text,
  p_thread_parts    jsonb,
  p_report          jsonb
) returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public, app
as $$
declare
  v_dj      record;
  v_ok      boolean := coalesce((p_report ->> 'ok')::boolean, false);
  v_variant uuid;
begin
  perform app.enter('musebook_jobs', null);
  select dj.id, dj.idempotency_key, c.platform
    into v_dj
    from public.distribution_jobs dj
    join public.channels c on c.id = dj.channel_id
   where dj.post_version_id = p_post_version_id
     and dj.channel_id = p_channel_id;
  if v_dj.id is null then return null; end if;

  update public.platform_variants v
     set body = p_body,
         thread_parts = p_thread_parts,
         generated_by = 'human',
         validator_report = p_report,
         is_valid = v_ok
   where v.post_version_id = p_post_version_id
     and v.platform = v_dj.platform
  returning v.id into v_variant;
  if v_variant is null then return null; end if;

  if not v_ok then
    update public.distribution_jobs
       set state = 'failed', last_error = 'edit failed validation'
     where id = v_dj.id and state = 'queued';
  end if;
  return jsonb_build_object('variant_id', v_variant, 'is_valid', v_ok);
end;
$$;

-- Exclude (§12.3.7): the creator removes one channel before send. The job
-- row is the schedule — failing it terminally (never 'dead', which means
-- retries-exhausted) keeps siblings' last-sibling send gate intact.
create or replace function app.exclude_distribution_job(
  p_post_version_id uuid,
  p_channel_id      uuid
) returns integer
language plpgsql
security invoker
set search_path = pg_catalog, public, app
as $$
declare
  v_n integer;
begin
  perform app.enter('musebook_jobs', null);
  update public.distribution_jobs
     set state = 'failed', last_error = 'excluded by creator'
   where post_version_id = p_post_version_id
     and channel_id = p_channel_id
     and state = 'queued';
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke all on function app.platform_constraint_for(text) from public, anon, authenticated;
revoke all on function app.channel_override_for(uuid) from public, anon, authenticated;
revoke all on function app.distribute_job_for(uuid, uuid) from public, anon, authenticated;
revoke all on function app.save_edited_variant(uuid, uuid, text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function app.exclude_distribution_job(uuid, uuid) from public, anon, authenticated;
grant execute on function app.platform_constraint_for(text) to musebook_worker;
grant execute on function app.channel_override_for(uuid) to musebook_worker;
grant execute on function app.distribute_job_for(uuid, uuid) to musebook_worker;
grant execute on function app.save_edited_variant(uuid, uuid, text, jsonb, jsonb) to musebook_worker;
grant execute on function app.exclude_distribution_job(uuid, uuid) to musebook_worker;

-- The stored variant the Edit action rewrites — body/media/thread_parts
-- verbatim so the edge can rebuild a VariantCandidate for validation.
create or replace function app.variant_for(p_variant_id uuid)
returns jsonb
language plpgsql stable
security invoker
set search_path = pg_catalog, public, app
as $$
begin
  perform app.enter('musebook_jobs', null);
  return (
    select to_jsonb(t) from (
      select v.id, v.post_id, v.post_version_id, v.platform,
             v.body, v.media, v.thread_parts, v.is_valid, v.generated_by
        from public.platform_variants v
       where v.id = p_variant_id
    ) t);
end;
$$;

revoke all on function app.variant_for(uuid) from public, anon, authenticated;
grant execute on function app.variant_for(uuid) to musebook_worker;
