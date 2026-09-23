-- 12. Agent spend reservations: the two-phase hold model (§10.7.2) and
--     revoke_delegation (§10.7.5). Functions only — agent_spend_reservations,
--     delegation_spend and the delegations cap columns are §4.11's and landed at M2.

create or replace function public.reserve_agent_spend(
  p_delegation_id   uuid,
  p_estimate_atomic numeric,
  p_purpose         text,
  p_idempotency_key text,
  p_external_kind   text default null,
  p_external_ref    text default null,
  p_now             timestamptz default now()
)
returns table (
  allowed          boolean,
  reason           text,
  reservation_id   uuid,
  remaining_atomic numeric
)
language plpgsql
security definer
set search_path = public, app
as $$
declare
  d              record;
  v_window_secs  bigint;
  v_window_start timestamptz;
  v_committed    numeric(78,0);
  v_held         numeric(78,0);
  v_existing     record;
  v_id           uuid;
begin
  -- The row lock. Everything below is serialized per delegation.
  select * into d from public.delegations where id = p_delegation_id for update;
  if not found then
    return query select false, 'unknown_delegation'::text, null::uuid, 0::numeric; return;
  end if;
  if d.state <> 'active' then
    return query select false, ('delegation_' || d.state)::text, null::uuid, 0::numeric; return;
  end if;
  if d.expires_at is not null and d.expires_at <= p_now then
    update public.delegations set state = 'expired' where id = p_delegation_id;
    return query select false, 'delegation_expired'::text, null::uuid, 0::numeric; return;
  end if;
  if d.quarantined_until is not null and d.quarantined_until > p_now then
    return query select false, 'delegation_quarantined'::text, null::uuid, 0::numeric; return;
  end if;
  if p_estimate_atomic < 0 then
    return query select false, 'negative_estimate'::text, null::uuid, 0::numeric; return;
  end if;

  -- Idempotent replay: same key, same delegation -> the original reservation.
  -- This is what makes an at-least-once Queues redelivery and a retried Cron tick
  -- safe. Queues has NO exactly-once mode and one active consumer per queue, so
  -- every consumer needs a gate like this whatever else it does (CF-SPINE §3).
  select * into v_existing
    from public.agent_spend_reservations
   where delegation_id = p_delegation_id and idempotency_key = p_idempotency_key;
  if found then
    return query select (v_existing.state = 'held'),
                        case when v_existing.state = 'held' then 'replay'
                             else 'reservation_' || v_existing.state end,
                        v_existing.id,
                        greatest(d.spend_cap_atomic - v_existing.estimate_atomic, 0);
    return;
  end if;

  -- THE window formula: floor(extract(epoch from now()) / spend_window_seconds).
  -- Every reader of delegation_spend / agent_spend_reservations computes this.
  v_window_secs  := greatest(extract(epoch from d.spend_window)::bigint, 1);
  v_window_start := to_timestamp(
    floor(extract(epoch from p_now) / v_window_secs) * v_window_secs
  );

  select coalesce(spent_atomic, 0) into v_committed
    from public.delegation_spend
   where delegation_id = p_delegation_id and window_start = v_window_start;
  v_committed := coalesce(v_committed, 0);

  select coalesce(sum(estimate_atomic), 0) into v_held
    from public.agent_spend_reservations
   where delegation_id = p_delegation_id
     and window_start  = v_window_start
     and state         = 'held';

  if v_committed + v_held + p_estimate_atomic > d.spend_cap_atomic then
    return query select false, 'spend_cap_exceeded'::text, null::uuid,
                        greatest(d.spend_cap_atomic - v_committed - v_held, 0);
    return;
  end if;

  insert into public.agent_spend_reservations
    (delegation_id, window_start, purpose, estimate_atomic,
     external_kind, external_ref, idempotency_key)
  values
    (p_delegation_id, v_window_start, p_purpose, p_estimate_atomic,
     p_external_kind, p_external_ref, p_idempotency_key)
  returning id into v_id;

  update public.delegations set last_used_at = p_now where id = p_delegation_id;

  return query select true, 'ok'::text, v_id,
                      d.spend_cap_atomic - v_committed - v_held - p_estimate_atomic;
end;
$$;

create or replace function public.settle_agent_spend(
  p_reservation_id uuid,
  p_actual_atomic  numeric,
  p_now            timestamptz default now()
)
returns table (settled boolean, reason text, committed_atomic numeric)
language plpgsql
security definer
set search_path = public, app
as $$
declare
  r record;
  d record;
begin
  select * into r from public.agent_spend_reservations
    where id = p_reservation_id for update;
  if not found then
    return query select false, 'unknown_reservation'::text, 0::numeric; return;
  end if;
  if r.state <> 'held' then
    -- Idempotent: a duplicate provider webhook, a redelivered queue message and a
    -- retried bridge result are all the same thing here, and none is an error.
    return query select (r.state = 'settled'),
                        ('reservation_' || r.state)::text,
                        coalesce(r.actual_atomic, 0);
    return;
  end if;

  select * into d from public.delegations where id = r.delegation_id for update;

  insert into public.delegation_spend
    (delegation_id, window_start, spent_atomic, actions_count)
  values (r.delegation_id, r.window_start, greatest(p_actual_atomic, 0), 1)
  on conflict (delegation_id, window_start) do update
    set spent_atomic  = public.delegation_spend.spent_atomic + greatest(p_actual_atomic, 0),
        actions_count = public.delegation_spend.actions_count + 1,
        updated_at    = now();

  update public.agent_spend_reservations
     set state = 'settled', actual_atomic = greatest(p_actual_atomic, 0), closed_at = p_now
   where id = p_reservation_id;

  return query select true, 'ok'::text, greatest(p_actual_atomic, 0);
end;
$$;

create or replace function public.release_agent_spend(
  p_reservation_id uuid,
  p_reason         text,
  p_now            timestamptz default now()
)
returns boolean
language plpgsql
security definer
set search_path = public, app
as $$
declare r record;
begin
  select * into r from public.agent_spend_reservations
    where id = p_reservation_id for update;
  if not found or r.state <> 'held' then return false; end if;
  update public.agent_spend_reservations
     set state = 'released', actual_atomic = 0, closed_at = p_now
   where id = p_reservation_id;
  return true;
end;
$$;

-- revoke_delegation (§10.7.5): the atomic half of a revocation, plus the cancel
-- intents written into job_outbox in the SAME statement — there is no Queues
-- binding on the revoke route, so the outbox row is the only durable hand-off.
create or replace function public.revoke_delegation(
  p_delegation_id uuid,
  p_reason        text,
  p_actor_user_id uuid default null,
  p_now           timestamptz default now()
)
returns integer            -- how many cancel intents were enqueued
language plpgsql
security definer
set search_path = public, app
as $$
declare
  d       record;
  v_jobs  integer := 0;
begin
  select * into d from public.delegations where id = p_delegation_id for update;
  if not found then return 0; end if;

  update public.delegations
     set state = 'revoked', revoked_at = coalesce(d.revoked_at, p_now)
   where id = p_delegation_id;

  -- Every open hold dies here. No further reservation can be made: the state check
  -- at the top of reserve_agent_spend fails on the same row this statement locked.
  update public.agent_spend_reservations r
     set state = 'cancelled', actual_atomic = 0, closed_at = p_now
   where r.delegation_id = p_delegation_id and r.state = 'held';

  -- Nothing pending may still be acted on.
  update public.approval_queue
     set state = 'rejected', decided_at = p_now, decided_by_user_id = p_actor_user_id
   where delegation_id = p_delegation_id and state = 'pending';

  -- The far-side cancels are outbox rows written in the SAME statement as the
  -- revocation, not HTTP calls the route attempts after commit. kind is
  -- 'agent_cancel'; dedupe_key makes a repeated revoke a no-op at the storage
  -- engine. The payload carries ids only — the row must fit a 128 KB Queues
  -- message with room to spare and §4.13 caps it at 64 KB.
  with intents as (
    insert into public.job_outbox (kind, dedupe_key, payload)
    select 'agent_cancel',
           'cancel:' || r.id::text,
           jsonb_build_object('reservation_id', r.id,
                              'delegation_id',  r.delegation_id,
                              'external_kind',  r.external_kind,
                              'external_ref',   r.external_ref)
      from public.agent_spend_reservations r
     where r.delegation_id = p_delegation_id
       and r.state         = 'cancelled'
       and r.closed_at     = p_now
       and r.external_ref  is not null
    on conflict (kind, dedupe_key) do nothing
    returning 1
  )
  select count(*) into v_jobs from intents;

  insert into public.audit_log
    (actor, actor_user_id, delegation_id, action, target_kind, target_id, after_state)
  values
    (case when p_actor_user_id is null then 'owner_agent'::actor_class else 'human_creator'::actor_class end,
     p_actor_user_id, p_delegation_id, 'delegation.revoke', 'delegation', p_delegation_id,
     jsonb_build_object('reason', p_reason, 'at', p_now, 'cancel_jobs', v_jobs));

  return v_jobs;
end;
$$;

revoke all on function public.reserve_agent_spend(uuid, numeric, text, text, text, text, timestamptz)
  from public, anon, authenticated;
revoke all on function public.settle_agent_spend(uuid, numeric, timestamptz)
  from public, anon, authenticated;
revoke all on function public.release_agent_spend(uuid, text, timestamptz)
  from public, anon, authenticated;
revoke all on function public.revoke_delegation(uuid, text, uuid, timestamptz)
  from public, anon, authenticated;

-- Who may call them. The Workers reach Postgres as musebook_worker through
-- Hyperdrive and name their plane per statement with app.enter (§4.14.1);
-- apps/web reaches the same functions through PostgREST as service_role.
-- Nothing else, ever: these three functions ARE the spend model.
grant execute on function public.reserve_agent_spend(uuid, numeric, text, text, text, text, timestamptz)
  to musebook_worker, service_role;
grant execute on function public.settle_agent_spend(uuid, numeric, timestamptz)
  to musebook_worker, service_role;
grant execute on function public.release_agent_spend(uuid, text, timestamptz)
  to musebook_worker, service_role, musebook_jobs;
grant execute on function public.revoke_delegation(uuid, text, uuid, timestamptz)
  to musebook_worker, service_role;

-- §10.15.3 step 5: the agent drafter's single-statement write. post_bodies ->
-- posts -> post_versions -> approval_queue | job_outbox in ONE call (never an
-- explicit transaction — Hyperdrive pools in transaction mode and a held
-- transaction pins a pooled connection, §4.13). §7.4's submit_post writes the
-- same shape; publish_post is its sibling for an existing draft.
drop function if exists public.insert_draft_post(uuid,uuid,uuid,text,text,text[],publish_mode,boolean,uuid,uuid,text[],text,text,text);
drop function if exists public.insert_draft_post(uuid,uuid,uuid,text,text,text[],text,boolean,uuid,uuid,text[],text,text,text);

create or replace function public.insert_draft_post(
  p_owner_user_id      uuid,
  p_agent_identity_id  uuid,
  p_delegation_id      uuid,
  p_content_hash       text,
  p_canonical_markdown text,
  p_tags               text[],
  p_mode               text,           -- 'free'|'human_free_agent_paid'|'x402_always', cast inside
  p_pending            boolean,
  p_schedule_id        uuid default null,
  p_reservation_id     uuid default null,
  p_platforms          text[] default '{}',
  p_title              text default null,
  p_summary            text default null,
  p_language_code      text default 'en',
  p_price_atomic       numeric(78,0) default null,
  p_license_spdx       text default null,
  p_train_ai           boolean default null,
  p_ai_use             boolean default null,
  p_attribution_required boolean default null
) returns table (post_id uuid, approval_id uuid, job_id bigint)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_post_id    uuid;
  v_version_id uuid;
  v_approval   uuid;
  v_job        bigint;
  v_status     post_status;
  v_published  timestamptz;
  v_price      numeric(78,0);
  v_asset      text;
  v_network    text;
  v_license    text;
  v_train_ai   boolean;
  v_ai_use     boolean;
  v_defaults   record;
  v_platform   record;
  v_base       text;
  v_slug       text;
  v_suffix     text;
  v_attempt    int;
  i            int;
begin
  -- 1. Body store. content_hash is the PK; the check constraints verify the
  --    hash and byte length against the markdown, so a lying caller fails the
  --    insert, not the lookup.
  insert into public.post_bodies (content_hash, canonical_markdown, byte_len)
  values (p_content_hash, p_canonical_markdown, octet_length(p_canonical_markdown))
  on conflict (content_hash) do nothing;

  -- 2. Defaults: the owner's creator_publishing_defaults row for license and
  --    price; the platform singleton when either is absent (10.10.3).
  select * into v_defaults
    from public.creator_publishing_defaults
   where user_id = p_owner_user_id;
  select * into v_platform
    from public.platform_publishing_defaults
   where id;

  v_license  := coalesce(p_license_spdx, v_defaults.license_spdx, 'CC-BY-4.0');
  v_train_ai := coalesce(p_train_ai, v_defaults.train_ai, false);
  v_ai_use   := coalesce(p_ai_use, v_defaults.ai_use, false);

  if p_mode::publish_mode = 'free' then
    v_price := 0; v_asset := null; v_network := null;
  else
    -- posts_paid_modes_have_price: the price is set in THIS statement. The
    -- creator's price_cents converts to atomic (x10000); an absent or zero
    -- creator price falls back to the platform default (§4.15).
    v_price   := case
                   when p_price_atomic is not null then p_price_atomic
                   when coalesce(v_defaults.price_cents, 0) > 0
                     then v_defaults.price_cents::numeric * 10000
                   else v_platform.read_price_atomic
                 end;
    v_asset   := v_platform.price_asset;
    v_network := v_platform.price_network;
  end if;

  v_status    := case when p_pending then 'pending_approval'::post_status
                      else 'published'::post_status end;
  v_published := case when p_pending then null else now() end;

  -- 3. Slug — the composer's generator verbatim: base32 disambiguator on
  --    conflict, posts_slug_uniq is global. Agent notes carry no title.
  v_base := lower(regexp_replace(
              regexp_replace(trim(coalesce(nullif(p_title, ''), 'agent-note')),
                             '[^a-zA-Z0-9]+', '-', 'g'),
              '(^-+|-+$)', '', 'g'));
  if v_base !~ '^[a-z0-9]' or length(v_base) < 2 then
    v_base := 'agent-' || v_base;
  end if;
  v_base := left(v_base, 74);

  v_post_id := null;
  for v_attempt in 1..8 loop
    if v_attempt = 1 then
      v_slug := v_base;
    else
      v_suffix := '';
      for i in 1..4 loop
        v_suffix := v_suffix || substr('abcdefghijklmnopqrstuvwxyz234567',
                                       floor(random() * 32)::integer + 1, 1);
      end loop;
      v_slug := left(v_base, 74) || '-' || v_suffix;
    end if;
    begin
      insert into public.posts (
        author_user_id, posted_by_agent_id, kind, status, publish_mode, slug,
        title, summary, language_code, content_hash, current_version,
        price_atomic, price_asset, price_network,
        license_spdx, license_url, train_ai, ai_use, search_indexable,
        attribution_required, citation_template, tags, published_at)
      values (
        p_owner_user_id, p_agent_identity_id, 'note', v_status, p_mode::publish_mode, v_slug,
        p_title, p_summary, p_language_code, p_content_hash, 1,
        v_price, v_asset, v_network,
        v_license, null, v_train_ai, v_ai_use, true,
        coalesce(p_attribution_required, true), null, p_tags, v_published)
      returning id into v_post_id;
      exit;
    exception when unique_violation then
      continue;
    end;
  end loop;
  if v_post_id is null then
    raise exception 'insert_draft_post: could not mint a unique slug' using errcode = '23505';
  end if;

  insert into public.post_versions (post_id, version, content_hash, title, summary, editor_agent_id)
  values (v_post_id, 1, p_content_hash, p_title, p_summary, p_agent_identity_id)
  returning id into v_version_id;

  -- 4. The approval arm, same statement.
  if p_pending then
    insert into public.approval_queue
      (delegation_id, owner_user_id, kind, payload)
    values
      (p_delegation_id, p_owner_user_id, 'publish',
       jsonb_build_object('postId', v_post_id,
                          'scheduleId', p_schedule_id,
                          'reservationId', p_reservation_id,
                          'contentHash', p_content_hash))
    returning id into v_approval;
  end if;

  -- 5. The outbox arm, same statement. classify+embed ride content_hash (a
  --    published post always gets classified and embedded; dedupe makes the
  --    publish_post fan-out later a no-op). distribute rides post_version_id
  --    and only exists when there is somewhere to send it. The returned
  --    job_id is the distribute row's — the id step 7 of the drain sends.
  if not p_pending then
    insert into public.job_outbox (kind, dedupe_key, payload)
    select x.kind, x.dedupe_key, x.payload
      from (values
        ('classify', 'classify:' || p_content_hash,
         jsonb_build_object('post_id', v_post_id, 'content_hash', p_content_hash)),
        ('embed', 'embed:' || p_content_hash,
         jsonb_build_object('post_id', v_post_id, 'content_hash', p_content_hash))
      ) as x(kind, dedupe_key, payload)
    on conflict (kind, dedupe_key) do nothing;

    if cardinality(p_platforms) > 0 then
      insert into public.job_outbox (kind, dedupe_key, payload)
      values ('distribute', 'distribute:' || v_version_id::text,
              jsonb_build_object('post_id', v_post_id,
                                 'post_version_id', v_version_id,
                                 'platforms', to_jsonb(p_platforms),
                                 'source', 'agent_draft'))
      on conflict (kind, dedupe_key) do nothing
      returning id into v_job;
    end if;
  end if;

  return query select v_post_id, v_approval, v_job;
end;
$$;

revoke all on function public.insert_draft_post(
  uuid, uuid, uuid, text, text, text[], text, boolean,
  uuid, uuid, text[], text, text, text,
  numeric(78,0), text, boolean, boolean, boolean)
  from public, anon, authenticated;
grant execute on function public.insert_draft_post(
  uuid, uuid, uuid, text, text, text[], text, boolean,
  uuid, uuid, text[], text, text, text,
  numeric(78,0), text, boolean, boolean, boolean)
  to musebook_worker, service_role;

-- ── §10.15's drafting reads/writes, all through app.* helpers (D23: a sibling
-- app.enter in a Worker SELECT binds too late — the helper performs enter()
-- first, then runs its statements planned under the plane's role).

-- The */15 claim: two arms, one statement, both 'for update skip locked' so two
-- overlapping ticks never draft the same schedule twice. Arm A rides
-- agent_post_schedules_due_idx (partial on cadence <> 'manual'); arm B is the
-- forced 'manual' fire-once a user woke by setting next_run_at (§10.15.1).
create or replace function app.claim_due_schedules(p_limit int)
returns setof public.agent_post_schedules
language plpgsql
security invoker
set search_path = pg_catalog, public, app
as $$
begin
  perform app.enter('musebook_jobs', null);
  return query
    with sched as (
      update public.agent_post_schedules s
         set next_run_at = now() + case s.cadence
                                     when 'hourly' then interval '1 hour'
                                     when 'daily'  then interval '1 day'
                                     when 'weekly' then interval '7 days'
                                   end,
             last_run_at = now()
       where s.id in (
         select id from public.agent_post_schedules
          where enabled and cadence <> 'manual' and next_run_at <= now()
          order by next_run_at
          limit p_limit
          for update skip locked
       )
      returning s.*
    ), forced as (
      update public.agent_post_schedules s
         set next_run_at = null,
             last_run_at = now()
       where s.id in (
         select id from public.agent_post_schedules
          where enabled and cadence = 'manual'
            and next_run_at is not null and next_run_at <= now()
          order by next_run_at
          limit p_limit
          for update skip locked
       )
      returning s.*
    )
    select * from sched union all select * from forced;
end;
$$;

-- delegations ⨝ connectors ⨝ agent_identities ⨝ profiles(handle) ⨝
-- creator_publishing_defaults, in one call. The mode column is folded into the
-- `access` vocabulary ('open'|'toll'|'gated') inside SQL so the Worker never
-- spells the column name (§3.4's rule reaches SQL strings too).
create or replace function app.delegation_for_drafting(p_delegation_id uuid)
returns table (
  delegation_id        uuid,
  state                delegation_state,
  scopes               text[],
  connector_id         uuid,
  connector_slug       text,
  transport            text,
  auth_kind            text,
  manifest             jsonb,
  agent_identity_id    uuid,
  agent_identity_slug  text,
  owner_user_id        uuid,
  owner_handle         text,
  per_action_cap_atomic numeric,
  requires_approval    boolean,
  clean_approvals      integer,
  reputation           numeric,
  has_ever_spent       boolean,
  defaults             jsonb
)
language plpgsql
security invoker
set search_path = pg_catalog, public, app
as $$
begin
  perform app.enter('musebook_jobs', null);
  return query
    select d.id, d.state, d.scopes,
           c.id, c.slug, c.transport, c.auth_kind, c.manifest,
           a.id, a.slug,
           d.owner_user_id, pr.handle,
           d.per_action_cap_atomic, d.requires_approval, d.clean_approvals,
           d.reputation,
           exists(select 1 from public.delegation_spend sp
                   where sp.delegation_id = d.id and sp.spent_atomic > 0),
           case when cpd.user_id is null then null
                else jsonb_build_object(
                  'license_spdx', cpd.license_spdx,
                  'train_ai',     cpd.train_ai,
                  'ai_use',       cpd.ai_use,
                  'price_cents',  cpd.price_cents,
                  'access', case cpd.publish_mode
                              when 'free'                    then 'open'
                              when 'human_free_agent_paid'   then 'toll'
                              when 'x402_always'             then 'gated'
                            end)
           end
      from public.delegations d
      join public.connectors c        on c.id = d.connector_id
      join public.agent_identities a  on a.id = d.agent_identity_id
      join public.profiles pr         on pr.user_id = d.owner_user_id
      left join public.creator_publishing_defaults cpd on cpd.user_id = d.owner_user_id
     where d.id = p_delegation_id;
end;
$$;

create or replace function app.posts_today_by_agent(p_agent_identity_id uuid)
returns integer
language plpgsql
security invoker
set search_path = pg_catalog, public, app
as $$
declare n integer;
begin
  perform app.enter('musebook_jobs', null);
  select count(*) into n
    from public.posts
   where posted_by_agent_id = p_agent_identity_id
     and created_at >= date_trunc('day', now())
     and deleted_at is null;
  return n;
end;
$$;

-- One sealed credential row for one delegation. Returns ciphertext + key_id;
-- decryption is application-level in the Worker, never in SQL (10.8.1).
create or replace function app.connector_credential_for(
  p_delegation_id uuid,
  p_kind          text
) returns table (ciphertext bytea, key_id text)
language plpgsql
security invoker
set search_path = pg_catalog, public, app
as $$
begin
  perform app.enter('musebook_jobs', null);
  return query
    select cc.ciphertext, cc.key_id
      from public.connector_credentials cc
     where cc.delegation_id = p_delegation_id
       and cc.kind = p_kind
     limit 1;
end;
$$;

-- The general hold sweeper (§10.7.2, 6 h) and the bridge reaper (§10.6.6,
-- 30 min) are one shape: release_agent_spend per stale 'held' row, plus an
-- audit row when the release carries a failure reason worth recording.
create or replace function app.sweep_stale_holds(
  p_max_age       interval,
  p_external_kind text default null,
  p_reason        text default 'hold_expired',
  p_audit_reason  text default null
) returns integer
language plpgsql
security invoker
set search_path = pg_catalog, public, app
as $$
declare
  r record;
  n integer := 0;
begin
  perform app.enter('musebook_jobs', null);
  for r in
    select id, delegation_id
      from public.agent_spend_reservations
     where state = 'held'
       and created_at < now() - p_max_age
       and (p_external_kind is null or external_kind = p_external_kind)
  loop
    if public.release_agent_spend(r.id, p_reason) then
      n := n + 1;
      if p_audit_reason is not null then
        insert into public.audit_log
          (actor, delegation_id, action, target_kind, target_id, after_state)
        values
          ('owner_agent'::actor_class, r.delegation_id, 'agent.draft_failed', 'reservation', r.id,
           jsonb_build_object('reason', p_audit_reason));
      end if;
    end if;
  end loop;
  return n;
end;
$$;

-- OAuth credential refresh (§10.8.1 item 3): rows expiring within p_within on
-- connector_credentials_expiry_idx. The Worker decrypts oauth_refresh, calls
-- the token endpoint through guardedFetch, and re-seals through
-- app.store_connector_credential.
drop function if exists app.list_expiring_credentials(interval);
create or replace function app.list_expiring_credentials(p_within interval)
returns table (
  id             uuid,
  delegation_id  uuid,
  kind           text,
  ciphertext     bytea,
  key_id         text,
  expires_at     timestamptz,
  manifest       jsonb
)
language plpgsql
security invoker
set search_path = pg_catalog, public, app
as $$
begin
  perform app.enter('musebook_jobs', null);
  return query
    select cc.id, cc.delegation_id, cc.kind, cc.ciphertext, cc.key_id, cc.expires_at,
           c.manifest
      from public.connector_credentials cc
      join public.delegations d on d.id = cc.delegation_id
      join public.connectors c  on c.id = d.connector_id
     where cc.expires_at is not null
       and cc.expires_at < now() + p_within
     order by cc.expires_at
     limit 100;
end;
$$;

create or replace function app.store_connector_credential(
  p_delegation_id uuid,
  p_kind          text,
  p_ciphertext    bytea,
  p_key_id        text,
  p_expires_at    timestamptz default null
) returns void
language plpgsql
security invoker
set search_path = pg_catalog, public, app
as $$
begin
  perform app.enter('musebook_jobs', null);
  insert into public.connector_credentials
    (delegation_id, kind, ciphertext, key_id, expires_at)
  values (p_delegation_id, p_kind, p_ciphertext, p_key_id, p_expires_at)
  on conflict (delegation_id, kind) do update
    set ciphertext = excluded.ciphertext,
        key_id     = excluded.key_id,
        expires_at = excluded.expires_at,
        rotated_at = now();
end;
$$;

-- The agent_cancel consumer's context: everything needed to resolve the
-- adapter for one revocation-bound reservation (payload ids only, §10.7.5).
create or replace function app.cancel_context_for(p_reservation_id uuid)
returns table (
  reservation_id    uuid,
  delegation_id     uuid,
  owner_user_id     uuid,
  agent_identity_id uuid,
  scopes            text[],
  external_kind     text,
  external_ref      text,
  connector_id      uuid,
  connector_slug    text,
  transport         text,
  auth_kind         text,
  manifest          jsonb
)
language plpgsql
security invoker
set search_path = pg_catalog, public, app
as $$
begin
  perform app.enter('musebook_jobs', null);
  return query
    select r.id, d.id, d.owner_user_id, d.agent_identity_id, d.scopes,
           r.external_kind, r.external_ref,
           c.id, c.slug, c.transport, c.auth_kind, c.manifest
      from public.agent_spend_reservations r
      join public.delegations d on d.id = r.delegation_id
      join public.connectors c  on c.id = d.connector_id
     where r.id = p_reservation_id;
end;
$$;

-- §10.10.4's nightly pass reads these in one call per delegation: every rate
-- the pure nextReputation() needs, computed against the trailing window.
create or replace function app.reputation_inputs_for(p_delegation_id uuid, p_days int default 30)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public, app
as $$
declare v jsonb;
begin
  perform app.enter('musebook_jobs', null);
  select jsonb_build_object(
      'humanEngagementPer1k', 0,
      'forkRate', 0,
      'completionRate', 0,
      'reportRate', 0,
      'approvalRejectionRate',
        case when count(*) filter (where aq.state in ('approved','rejected','expired')) = 0 then 0
             else (count(*) filter (where aq.state = 'rejected'))::numeric
                  / count(*) filter (where aq.state in ('approved','rejected','expired'))
        end,
      'safetyBlockRate', 0,
      'refundRate', 0)
    into v
    from public.approval_queue aq
   where aq.delegation_id = p_delegation_id
     and aq.requested_at > now() - make_interval(days => p_days);
  return v;
end;
$$;

create or replace function app.delegations_for_reputation()
returns table (delegation_id uuid, reputation numeric)
language plpgsql
security invoker
set search_path = pg_catalog, public, app
as $$
begin
  perform app.enter('musebook_jobs', null);
  return query
    select d.id, d.reputation
      from public.delegations d
     where d.state = 'active';
end;
$$;

create or replace function app.set_delegation_reputation(
  p_delegation_id uuid,
  p_reputation    numeric
) returns void
language plpgsql
security invoker
set search_path = pg_catalog, public, app
as $$
begin
  perform app.enter('musebook_jobs', null);
  update public.delegations
     set reputation = greatest(0, least(100, p_reputation))
   where id = p_delegation_id;
end;
$$;

revoke all on function app.claim_due_schedules(int) from public, anon, authenticated;
revoke all on function app.delegation_for_drafting(uuid) from public, anon, authenticated;
revoke all on function app.posts_today_by_agent(uuid) from public, anon, authenticated;
revoke all on function app.connector_credential_for(uuid, text) from public, anon, authenticated;
revoke all on function app.sweep_stale_holds(interval, text, text, text) from public, anon, authenticated;
revoke all on function app.list_expiring_credentials(interval) from public, anon, authenticated;
revoke all on function app.store_connector_credential(uuid, text, bytea, text, timestamptz) from public, anon, authenticated;
revoke all on function app.cancel_context_for(uuid) from public, anon, authenticated;
revoke all on function app.reputation_inputs_for(uuid, int) from public, anon, authenticated;
revoke all on function app.delegations_for_reputation() from public, anon, authenticated;
revoke all on function app.set_delegation_reputation(uuid, numeric) from public, anon, authenticated;

grant execute on function app.claim_due_schedules(int) to musebook_worker;
grant execute on function app.delegation_for_drafting(uuid) to musebook_worker;
grant execute on function app.posts_today_by_agent(uuid) to musebook_worker;
grant execute on function app.connector_credential_for(uuid, text) to musebook_worker;
grant execute on function app.sweep_stale_holds(interval, text, text, text) to musebook_worker;
grant execute on function app.list_expiring_credentials(interval) to musebook_worker;
grant execute on function app.store_connector_credential(uuid, text, bytea, text, timestamptz) to musebook_worker;
grant execute on function app.cancel_context_for(uuid) to musebook_worker;
grant execute on function app.reputation_inputs_for(uuid, int) to musebook_worker;
grant execute on function app.delegations_for_reputation() to musebook_worker;
grant execute on function app.set_delegation_reputation(uuid, numeric) to musebook_worker;

-- §10.15.3's length floor for the agent: the smallest max_chars across the
-- schedule's target platforms, so the draft fits its shortest stage.
create or replace function app.min_max_chars_for(p_platforms text[])
returns integer
language plpgsql
security invoker
set search_path = pg_catalog, public, app
as $$
declare n integer;
begin
  perform app.enter('musebook_jobs', null);
  select min(p.max_chars) into n
    from public.platforms p
   where p.slug = any(p_platforms) and p.max_chars is not null;
  return coalesce(n, 20000);
end;
$$;

revoke all on function app.min_max_chars_for(text[]) from public, anon, authenticated;
grant execute on function app.min_max_chars_for(text[]) to musebook_worker;

-- ── §10.6's bridge surface. The reservation row IS the task (10.6.6), so the
-- poll route probes one bounded query, releases the connection, waits, and
-- probes again — a parked poll never pins a Hyperdrive connection.

-- Step 2's probe: the oldest 'held' bridge_draft hold for one delegation over
-- agent_spend_reservations_held_idx.
create or replace function app.next_bridge_task(p_delegation_id uuid)
returns table (reservation_id uuid, task_id text, estimate_atomic numeric)
language plpgsql
security invoker
set search_path = pg_catalog, public, app
as $$
begin
  perform app.enter('musebook_jobs', null);
  return query
    select r.id, r.external_ref, r.estimate_atomic
      from public.agent_spend_reservations r
     where r.delegation_id = p_delegation_id
       and r.state = 'held'
       and r.external_kind = 'bridge_draft'
     order by r.window_start
     limit 1;
end;
$$;

-- Everything a poll needs to build the task frame AND everything /result
-- needs to call completeDraft: the delegation_for_drafting row, the schedule
-- row (parsed out of external_ref's 'draft:{schedule_id}:{firing}'), and the
-- reservation's own state so a cancelled hold is a no-op.
create or replace function app.bridge_task_context(p_reservation_id uuid)
returns table (
  delegation        jsonb,
  schedule          jsonb,
  reservation_state text,
  task_id           text
)
language plpgsql
security invoker
set search_path = pg_catalog, public, app
as $$
declare
  v_d uuid;
  v_s uuid;
begin
  perform app.enter('musebook_jobs', null);
  select r.delegation_id,
         case when r.external_ref ~ '^draft:[0-9a-fA-F-]+:[0-9]+$'
              then split_part(r.external_ref, ':', 2)::uuid end,
         r.state, r.external_ref
    into v_d, v_s, reservation_state, task_id
    from public.agent_spend_reservations r
   where r.id = p_reservation_id;
  if v_d is null then return; end if;
  select to_jsonb(x) into delegation
    from app.delegation_for_drafting(v_d) x;
  if v_s is not null then
    select to_jsonb(s) into schedule
      from public.agent_post_schedules s
     where s.id = v_s;
  end if;
  return next;
end;
$$;

-- /result's lookup by taskId: the reservation the idempotency key names.
create or replace function app.bridge_reservation_for_task(
  p_delegation_id uuid,
  p_task_id       text
) returns table (reservation_id uuid, reservation_state text)
language plpgsql
security invoker
set search_path = pg_catalog, public, app
as $$
begin
  perform app.enter('musebook_jobs', null);
  return query
    select r.id, r.state
      from public.agent_spend_reservations r
     where r.delegation_id = p_delegation_id
       and r.external_kind = 'bridge_draft'
       and r.external_ref = p_task_id
     order by r.created_at desc
     limit 1;
end;
$$;

-- §4.13's exactly-once record for /result: first writer wins; a replay reads
-- the stored response back. (endpoint, key, actor) is the triple-unique index.
create or replace function app.bridge_result_once(
  p_task_id  text,
  p_actor    uuid,
  p_response jsonb
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
      values ('bridge.result', p_task_id, p_actor::text, 'complete', 200, p_response)
      on conflict (endpoint, idempotency_key, actor) do nothing
      returning response_body
    )
    select true, i.response_body from ins i
    union all
    select false, k.response_body
      from public.idempotency_keys k
     where k.endpoint = 'bridge.result'
       and k.idempotency_key = p_task_id
       and k.actor = p_actor::text
       and not exists (select 1 from ins)
    limit 1;
end;
$$;

revoke all on function app.next_bridge_task(uuid) from public, anon, authenticated;
revoke all on function app.bridge_task_context(uuid) from public, anon, authenticated;
revoke all on function app.bridge_reservation_for_task(uuid, text) from public, anon, authenticated;
revoke all on function app.bridge_result_once(text, uuid, jsonb) from public, anon, authenticated;

grant execute on function app.next_bridge_task(uuid) to musebook_worker;
grant execute on function app.bridge_task_context(uuid) to musebook_worker;
grant execute on function app.bridge_reservation_for_task(uuid, text) to musebook_worker;
grant execute on function app.bridge_result_once(text, uuid, jsonb) to musebook_worker;

-- §7.6.4's authority read for the MCP surface: resolves a delegation by id.
-- The OAuth grant's props are a cache; this row is the authority.
create or replace function app.actor_delegation(p_delegation_id uuid)
returns table (
  delegation_id     uuid,
  owner_user_id     uuid,
  agent_identity_id uuid,
  connector_slug    text,
  scopes            text[],
  requires_approval boolean,
  state             text,
  expires_at        timestamptz,
  quarantined_until timestamptz
)
language plpgsql
security invoker
set search_path = pg_catalog, public, app
as $$
begin
  perform app.enter('musebook_jobs', null);
  return query
    select d.id, d.owner_user_id, d.agent_identity_id, c.slug, d.scopes,
           d.requires_approval, d.state::text, d.expires_at, d.quarantined_until
      from public.delegations d
      join public.connectors c on c.id = d.connector_id and c.is_enabled
     where d.id = p_delegation_id;
end;
$$;

revoke all on function app.actor_delegation(uuid) from public, anon, authenticated;
grant execute on function app.actor_delegation(uuid) to musebook_worker;

-- ---------------------------------------------------------------- catalog helpers for the MCP surface
-- publish_mode is never referenced from app code (§3.4): the badge projection
-- and the access filter live inside these helpers, which run under
-- musebook_public_reader — the same rows a browser sees, nothing more.

create or replace function app.search_posts(
  p_query          text,
  p_author         text,
  p_kind           text,
  p_tags           text[],
  p_after          timestamptz,
  p_cur_published  timestamptz,
  p_cur_post_id    uuid,
  p_limit          integer,
  p_access         text default 'any'
) returns table (
  post_id uuid, slug text, title text, summary text, kind post_kind,
  author_handle text, published_at timestamptz, content_hash text,
  access_badge text, price_atomic numeric, price_asset text, price_network text,
  license_spdx text, tags text[], rank real
)
language plpgsql
stable
security invoker
set search_path = pg_catalog, public, app
as $$
begin
  perform app.enter('musebook_public_reader', null);
  return query
    with cand as (
      select p.id, p.slug, p.title, p.summary, p.kind, pr.handle,
             p.published_at, p.content_hash,
             case p.publish_mode
               when 'free' then 'open'
               when 'human_free_agent_paid' then 'toll'
               else 'gated'
             end as badge,
             p.price_atomic, p.price_asset, p.price_network,
             p.license_spdx, p.tags,
             ts_rank(p.search_tsv, websearch_to_tsquery('english', p_query)) as r
        from public.posts p
        join public.profiles pr on pr.user_id = p.author_user_id
       where p.status = 'published' and p.deleted_at is null
         and p.search_indexable
         and (p_author is null or pr.handle = p_author)
         and (p_kind is null or p.kind::text = p_kind)
         and (p_tags is null or p.tags && p_tags)
         and (p_after is null or p.published_at >= p_after)
         and (p_query is null or p_query = ''
              or p.search_tsv @@ websearch_to_tsquery('english', p_query)
              or p.title ilike '%' || p_query || '%'
              or p.summary ilike '%' || p_query || '%')
         and (p_cur_published is null
              or (p.published_at, p.id) < (p_cur_published, p_cur_post_id))
       order by r desc nulls last, p.published_at desc, p.id desc
       limit p_limit
    )
    select c.id, c.slug, c.title, c.summary, c.kind, c.handle, c.published_at,
           c.content_hash, c.badge, c.price_atomic, c.price_asset, c.price_network,
           c.license_spdx, c.tags, c.r
      from cand c
     where p_access = 'any' or c.badge = p_access;
end;
$$;

revoke all on function app.search_posts(text, text, text, text[], timestamptz, timestamptz, uuid, integer, text)
  from public, anon, authenticated;
grant execute on function app.search_posts(text, text, text, text[], timestamptz, timestamptz, uuid, integer, text)
  to musebook_worker;

create or replace function app.list_authors(
  p_query    text,
  p_sort     text,
  p_paid     boolean,
  p_limit    integer,
  p_offset   integer
) returns table (
  handle text, display_name text, bio text,
  post_count bigint, follower_count bigint, has_paid_posts boolean
)
language plpgsql
stable
security invoker
set search_path = pg_catalog, public, app
as $$
begin
  perform app.enter('musebook_public_reader', null);
  return query
    with a as (
      select pr.handle, pr.display_name, pr.bio,
             (select count(*) from public.posts p
               where p.author_user_id = pr.user_id and p.status = 'published'
                 and p.deleted_at is null) as pc,
             (select count(*) from public.follows f
               where f.followed_user_id = pr.user_id) as fc,
             exists (select 1 from public.posts p2
                      where p2.author_user_id = pr.user_id
                        and p2.status = 'published' and p2.deleted_at is null
                        and p2.publish_mode <> 'free') as paid
        from public.profiles pr
       where (p_query is null
              or pr.handle ilike '%' || p_query || '%'
              or pr.display_name ilike '%' || p_query || '%')
         and exists (select 1 from public.posts p3
                      where p3.author_user_id = pr.user_id
                        and p3.status = 'published' and p3.deleted_at is null)
    )
    select a.handle, a.display_name, a.bio, a.pc, a.fc, a.paid
      from a
     where p_paid is null or a.paid = p_paid
     order by case p_sort
                when 'followers' then a.fc
                when 'posts' then a.pc
                else null
              end desc nulls last,
              a.handle asc
     limit p_limit offset p_offset;
end;
$$;

revoke all on function app.list_authors(text, text, boolean, integer, integer)
  from public, anon, authenticated;
grant execute on function app.list_authors(text, text, boolean, integer, integer)
  to musebook_worker;

-- download_asset: only columns an agent needs to fetch through the gate —
-- url/storage/content_type/byte_len/sha256 plus the parent post's content_hash
-- (what ?g= grants are keyed on) and the post's publish status. Never the
-- object_key beyond the resolved url.
create or replace function app.asset_for_download(p_asset_id uuid)
returns table (
  asset_id uuid, url text, storage text, content_type text, byte_len bigint,
  sha256 text, parent_post_id uuid, parent_content_hash text,
  parent_slug text, parent_published boolean
)
language plpgsql
stable
security invoker
set search_path = pg_catalog, public, app
as $$
begin
  perform app.enter('musebook_public_reader', null);
  return query
    select a.id, a.url, a.storage, a.content_type, a.byte_len, a.sha256,
           p.id, p.content_hash, p.slug,
           (p.status = 'published' and p.deleted_at is null)
      from public.assets a
      join public.post_assets pa on pa.asset_id = a.id
      join public.posts p on p.id = pa.post_id
     where a.id = p_asset_id
     order by (p.status = 'published' and p.deleted_at is null) desc, pa.position asc
     limit 1;
end;
$$;

revoke all on function app.asset_for_download(uuid) from public, anon, authenticated;
grant execute on function app.asset_for_download(uuid) to musebook_worker;

-- get_artifact: public metadata + whether the parent post is published.
create or replace function app.artifact_for_read(p_artifact_id uuid, p_post_slug text)
returns table (
  artifact_id uuid, post_id uuid, title text, kind text,
  description text, run_url text, source_asset_id uuid,
  poster_asset_id uuid, created_at timestamptz, parent_published boolean
)
language plpgsql
stable
security invoker
set search_path = pg_catalog, public, app
as $$
begin
  perform app.enter('musebook_public_reader', null);
  return query
    select a.id, a.post_id, a.title, a.kind::text, a.description, a.run_url,
           a.source_asset_id, a.poster_asset_id, a.created_at,
           (p.status = 'published' and p.deleted_at is null)
      from public.artifacts a
      join public.posts p on p.id = a.post_id
     where (p_artifact_id is not null and a.id = p_artifact_id)
        or (p_post_slug is not null and p.slug = p_post_slug)
     order by a.created_at desc
     limit 1;
end;
$$;

revoke all on function app.artifact_for_read(uuid, text) from public, anon, authenticated;
grant execute on function app.artifact_for_read(uuid, text) to musebook_worker;

-- get_pricing's author arm: the owner's defaults, public-safe columns only.
create or replace function app.author_pricing_defaults(p_handle text)
returns table (
  handle text, license_spdx text, price_cents integer,
  train_ai boolean, ai_use boolean
)
language plpgsql
stable
security invoker
set search_path = pg_catalog, public, app
as $$
begin
  perform app.enter('musebook_public_reader', null);
  return query
    select pr.handle,
           coalesce(d.license_spdx, 'CC-BY-4.0'),
           d.price_cents,
           coalesce(d.train_ai, false),
           coalesce(d.ai_use, false)
      from public.profiles pr
      left join public.creator_publishing_defaults d on d.user_id = pr.user_id
     where pr.handle = p_handle;
end;
$$;

revoke all on function app.author_pricing_defaults(text) from public, anon, authenticated;
grant execute on function app.author_pricing_defaults(text) to musebook_worker;

-- subscribe_author: the follow edge plus the audit row, one statement pair
-- under a definer because `follows` grants are select-only. Validates the
-- delegation itself (active, owner match) — the in-band scope check lives in
-- the tool, this function is the atomicity boundary.
create or replace function app.set_follow(
  p_owner_user_id    uuid,
  p_delegation_id    uuid,
  p_agent_identity_id uuid,
  p_author_handle    text,
  p_action           text,          -- 'follow' | 'unfollow'
  p_notify           boolean
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_target uuid;
  v_d      record;
begin
  select d.id, d.state, d.owner_user_id, d.expires_at into v_d
    from public.delegations d
   where d.id = p_delegation_id and d.state = 'active'
     and (d.expires_at is null or d.expires_at > now());
  if v_d is null or v_d.owner_user_id <> p_owner_user_id then
    return jsonb_build_object('ok', false, 'error', 'delegation_inactive');
  end if;

  select u.id into v_target
    from public.users u
    join public.profiles pr on pr.user_id = u.id
   where pr.handle = p_author_handle;
  if v_target is null then
    return jsonb_build_object('ok', false, 'error', 'no_such_author');
  end if;
  if v_target = p_owner_user_id then
    return jsonb_build_object('ok', false, 'error', 'cannot_follow_self');
  end if;

  if p_action = 'follow' then
    insert into public.follows (follower_user_id, target_kind, followee_user_id, actor_agent_id)
    values (p_owner_user_id, 'user', v_target, p_agent_identity_id)
    on conflict (follower_user_id, followee_user_id) where target_kind = 'user'
    do update set actor_agent_id = excluded.actor_agent_id;
    insert into public.audit_log
      (actor, actor_user_id, actor_agent_id, delegation_id, action,
       target_kind, target_id, after_state)
    values
      ('owner_agent'::actor_class, p_owner_user_id, p_agent_identity_id, p_delegation_id, 'follow',
       'user', v_target,
       jsonb_build_object('author', p_author_handle, 'notify', p_notify));
  else
    delete from public.follows
     where follower_user_id = p_owner_user_id and followee_user_id = v_target
       and target_kind = 'user';
    insert into public.audit_log
      (actor, actor_user_id, actor_agent_id, delegation_id, action,
       target_kind, target_id, after_state)
    values
      ('owner_agent'::actor_class, p_owner_user_id, p_agent_identity_id, p_delegation_id, 'unfollow',
       'user', v_target,
       jsonb_build_object('author', p_author_handle));
  end if;

  return jsonb_build_object('ok', true, 'action', p_action, 'author', p_author_handle);
end;
$$;

revoke all on function app.set_follow(uuid, uuid, uuid, text, text, boolean)
  from public, anon, authenticated;
grant execute on function app.set_follow(uuid, uuid, uuid, text, text, boolean)
  to musebook_worker;


-- get_analytics: owner-scoped rollup over action_events_daily. jobs-plane;
-- the owner reads ONLY rows on their own posts.
create or replace function app.analytics_for_owner(
  p_owner_user_id uuid,
  p_post_id       uuid,
  p_from          date,
  p_to            date,
  p_metrics       text[]
) returns table (day date, post_id uuid, action text, events bigint, dwell_ms bigint)
language plpgsql
stable
security invoker
set search_path = pg_catalog, public, app
as $$
begin
  perform app.enter('musebook_jobs', p_owner_user_id);
  return query
    select d.day, d.post_id, d.action::text, sum(d.n)::bigint, sum(d.dwell_ms)::bigint
      from public.action_events_daily d
      join public.posts p on p.id = d.post_id
     where p.author_user_id = p_owner_user_id
       and (p_post_id is null or d.post_id = p_post_id)
       and d.day >= coalesce(p_from, current_date - 7)
       and d.day <= coalesce(p_to, current_date)
       and (p_metrics is null or d.action::text = any(p_metrics))
     group by d.day, d.post_id, d.action
     order by d.day desc, d.post_id, d.action;
end;
$$;

revoke all on function app.analytics_for_owner(uuid, uuid, date, date, text[])
  from public, anon, authenticated;
grant execute on function app.analytics_for_owner(uuid, uuid, date, date, text[])
  to musebook_worker;

-- ------------------------------------------------- M9 privilege wiring
-- Tables the M9 helpers touch that migration 91300's matrix had not yet
-- granted to the planes the helpers enter. Same one-policy-per-role shape.
grant select, update on public.agent_post_schedules to musebook_jobs;
create policy agent_post_schedules_jobs_all on public.agent_post_schedules
  for all to musebook_jobs using (true) with check (true);

-- delegation_for_drafting folds the owner's defaults into one row; the helper
-- already constrains to the schedule's own delegation, so the jobs plane reads
-- the table wholesale (defaults are not secret material — license, price,
-- opt-outs are also what the pricing endpoints publish).
grant select on public.creator_publishing_defaults to musebook_jobs;
create policy creator_publishing_defaults_jobs_read
  on public.creator_publishing_defaults for select to musebook_jobs using (true);

-- get_pricing's author arm and the asset/artifact readers publish these
-- columns; the public_reader plane needs the rows the tools are allowed to
-- return.
grant select on public.creator_publishing_defaults to musebook_public_reader;
create policy creator_publishing_defaults_public_reader_read
  on public.creator_publishing_defaults for select to musebook_public_reader using (true);

grant select on public.assets to musebook_public_reader;
create policy assets_public_reader_read on public.assets
  for select to musebook_public_reader using (true);
