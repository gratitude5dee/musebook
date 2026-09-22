-- 20260922091500_app_enter.sql — §4.14's per-statement plane switch.
--
-- Set the plane and the actor for the remainder of THIS statement's implicit
-- transaction. `pg`'s extended query protocol binds $1 inside exactly one
-- statement, so `set local role …; select … $1` cannot be parameterized; a
-- SECURITY INVOKER function is the wrapping that makes the switch single-
-- round-trip, parameterized, and SET LOCAL-scoped at once. INVOKER on purpose:
-- it must not add privilege, only narrow it.
create or replace function app.enter(p_role text, p_actor uuid default null)
returns void
language plpgsql
as $$
begin
  if p_role not in ('musebook_public_reader','musebook_kernel','musebook_jobs') then
    raise exception 'app.enter: unknown plane %', p_role using errcode = '42501';
  end if;
  perform set_config('app.actor_id', coalesce(p_actor::text, ''), true);  -- true = LOCAL
  execute format('set local role %I', p_role);
end;
$$;

revoke all on function app.enter(text, uuid) from public, anon, authenticated;
-- The login role needs USAGE on the schema to invoke app.enter at all; the
-- plane roles gained that usage in 20260922091300_worker_role_and_rls_audit.sql
-- for their own function calls. This grant adds the worker to the schema's ACL
-- without touching the planes' narrower privileges.
grant usage on schema app to musebook_worker;
-- app.sha256_hex (INVOKER) reaches pgcrypto via the extensions schema — the
-- worker hashes nothing itself but callers inside helper functions do.
grant usage on schema extensions to musebook_worker;
grant execute on function app.enter(text, uuid) to musebook_worker;

-- ── §5.6.1 ladder read/write helpers ─────────────────────────────────────────
-- RLS and table grants bind at PLAN time in Postgres, so `app.enter(...)` and
-- the privileged read cannot be siblings in one SELECT — the plan's sanctioned
-- alternative is "one plpgsql call" (§4.13): a SECURITY INVOKER helper that
-- performs app.enter first, then runs its statements under the plane's role.

-- Session lookup for resolveActor row 2 (mb_session → human_creator). Returns
-- the session, its owner, and the owner's primary wallet in one round trip.
create or replace function app.read_session_by_token(p_token_sha256 text)
returns table (id uuid, user_id uuid, wallet text)
language plpgsql
security invoker
set search_path = pg_catalog, public, app
as $$
begin
  perform app.enter('musebook_kernel', null);
  return query
    select s.id, s.user_id,
           (select w.address from public.wallets w
             where w.user_id = s.user_id and w.is_primary
             limit 1)
      from public.sessions s
     where s.token_sha256 = p_token_sha256
       and s.revoked_at is null
       and s.expires_at > now();
end;
$$;

-- The WBA row's identity read (row 3) and the FCrDNS row's (row 4): catalog
-- data keyed by signature_agent or slug.
create or replace function app.read_agent_identity(
  p_key text,
  p_kind text default 'signature_agent' -- 'signature_agent' | 'slug'
)
returns table (id uuid, wallet_address text)
language plpgsql
security invoker
set search_path = pg_catalog, public, app
as $$
begin
  perform app.enter('musebook_kernel', null);
  if p_kind = 'slug' then
    return query
      select a.id, a.wallet_address from public.agent_identities a
       where a.slug = p_key and not a.is_blocked;
  else
    return query
      select a.id, a.wallet_address from public.agent_identities a
       where a.signature_agent = p_key and not a.is_blocked;
  end if;
end;
$$;

-- §5.7.5's delegation-state re-read (fresh, never cached). Enters the kernel
-- plane with the actor id set so the delegations_actor_read policy admits
-- exactly that owner's row.
create or replace function app.check_delegation_state(
  p_delegation_id uuid,
  p_owner_user_id uuid
)
returns table (state text, expires_at timestamptz,
               rate_limit_per_hour integer, quarantined_until timestamptz)
language plpgsql
security invoker
set search_path = pg_catalog, public, app
as $$
begin
  perform app.enter('musebook_kernel', p_owner_user_id);
  return query
    select d.state::text, d.expires_at, d.rate_limit_per_hour, d.quarantined_until
      from public.delegations d
     where d.id = p_delegation_id;
end;
$$;

-- §5.6.2's agent sighting: one job_outbox row of kind 'classify' carrying the
-- sighting in payload, jobs plane, deduped by (keyid, UTC hour bucket) at the
-- storage engine. Returns the outbox id when a row was inserted, else null so
-- the caller only sends Q_CLASSIFY on a real insert.
create or replace function app.enqueue_sighting(
  p_dedupe_key text,
  p_sighting jsonb
)
returns bigint
language plpgsql
security invoker
set search_path = pg_catalog, public, app
as $$
declare v_id bigint;
begin
  perform app.enter('musebook_jobs', null);
  insert into public.job_outbox (kind, dedupe_key, payload)
  values ('classify', p_dedupe_key, jsonb_build_object('sighting', p_sighting))
  on conflict (kind, dedupe_key) do nothing
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function app.read_session_by_token(text) from public, anon, authenticated;
revoke all on function app.read_agent_identity(text, text) from public, anon, authenticated;
revoke all on function app.check_delegation_state(uuid, uuid) from public, anon, authenticated;
revoke all on function app.enqueue_sighting(text, jsonb) from public, anon, authenticated;
grant execute on function app.read_session_by_token(text) to musebook_worker;
grant execute on function app.read_agent_identity(text, text) to musebook_worker;
grant execute on function app.check_delegation_state(uuid, uuid) to musebook_worker;
grant execute on function app.enqueue_sighting(text, jsonb) to musebook_worker;

-- resolve_delegation already returns the delegation row the ladder needs; the
-- only field it lacks is the connector manifest's declared intent, and adding
-- it here keeps row 1 at one round trip (drop+create: the return type changes).
drop function app.resolve_delegation(text);
create function app.resolve_delegation(p_token_sha256 text)
returns table (
  id                 uuid,
  owner_user_id      uuid,
  agent_identity_id  uuid,
  connector_slug     text,
  scopes             text[],
  requires_approval  boolean,
  state              text,
  expires_at         timestamptz,
  quarantined_until  timestamptz,
  declared_intent    text
)
language plpgsql
security definer
stable
set search_path = pg_catalog, public, app
as $$
begin
  -- plpgsql, not sql: §16.8 runs this file before 20260922091000_agents.sql
  -- creates public.delegations, and language-sql bodies are name-checked at
  -- create time. plpgsql defers the lookup to first call, by which time the
  -- table exists.
  return query
  select d.id, d.owner_user_id, d.agent_identity_id, c.slug, d.scopes,
         d.requires_approval, d.state::text, d.expires_at, d.quarantined_until,
         c.manifest ->> 'declared_intent'
    from public.delegations d
    join public.connectors  c on c.id = d.connector_id
   where d.token_sha256 = p_token_sha256
     and c.is_enabled;
end;
$$;
revoke all on function app.resolve_delegation(text) from public, anon, authenticated;
-- The Worker calls it directly as itself when resolving a bearer token (row 1);
-- DEFINER bypasses RLS, so no plane switch is needed for the credential lookup.
grant execute on function app.resolve_delegation(text) to musebook_worker, musebook_kernel;

-- §5.7.7's Worker-side audit writer: one append-only row per call, jobs plane.
create or replace function app.audit_log_insert(p_rec jsonb)
returns bigint
language plpgsql
security invoker
set search_path = pg_catalog, public, app
as $$
declare v_id bigint;
begin
  perform app.enter('musebook_jobs', null);
  insert into public.audit_log
    (actor, actor_user_id, actor_agent_id, delegation_id, action,
     target_kind, target_id, before_state, after_state, request_id, ip_hash)
  values
    ((p_rec->>'actor')::actor_class,
     nullif(p_rec->>'actor_user_id','')::uuid,
     nullif(p_rec->>'actor_agent_id','')::uuid,
     nullif(p_rec->>'delegation_id','')::uuid,
     p_rec->>'action',
     p_rec->>'target_kind',
     nullif(p_rec->>'target_id','')::uuid,
     p_rec->'before_state',
     p_rec->'after_state',
     p_rec->>'request_id',
     p_rec->>'ip_hash')
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function app.audit_log_insert(jsonb) from public, anon, authenticated;
grant execute on function app.audit_log_insert(jsonb) to musebook_worker;

-- ---------------------------------------------------------------------------
-- The Vercel plane's rate limiter (apps/web/lib/ratelimit.ts). Serverless
-- instances share no memory; this bucket table is the counter store. Only the
-- service key calls it — a PostgREST RPC, never a Worker path.
-- ---------------------------------------------------------------------------
create table public.rate_limit_buckets (
  key         text primary key,
  count       integer not null,
  window_start timestamptz not null
);
alter table public.rate_limit_buckets enable row level security;
alter table public.rate_limit_buckets force row level security;
revoke all on public.rate_limit_buckets from public, anon, authenticated;

create or replace function public.check_rate_limit(
  p_key text, p_limit integer, p_window_s integer
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare v_count integer;
begin
  insert into public.rate_limit_buckets (key, count, window_start)
  values (p_key, 1, now())
  on conflict (key) do update
    set count = case when rate_limit_buckets.window_start
                          + make_interval(secs => p_window_s) > now()
                     then rate_limit_buckets.count + 1
                     else 1 end,
        window_start = case when rate_limit_buckets.window_start
                                 + make_interval(secs => p_window_s) > now()
                            then rate_limit_buckets.window_start
                            else now() end
  returning count into v_count;
  return v_count <= p_limit;
end;
$$;
revoke all on function public.check_rate_limit(text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.check_rate_limit(text, integer, integer)
  to service_role;

-- ---------------------------------------------------------------------------
-- §10.7.5: revoke_delegation — the atomic half AND the cancel intents, in one
-- statement (DELETE /api/agent/delegations/[id] calls it; nothing else does).
-- ---------------------------------------------------------------------------
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

  -- Every open hold dies here.
  update public.agent_spend_reservations r
     set state = 'cancelled', actual_atomic = 0, closed_at = p_now
   where r.delegation_id = p_delegation_id and r.state = 'held';

  -- Nothing pending may still be acted on.
  update public.approval_queue
     set state = 'rejected', decided_at = p_now, decided_by_user_id = p_actor_user_id
   where delegation_id = p_delegation_id and state = 'pending';

  -- The far-side cancels are outbox rows written in the SAME statement as the
  -- revocation, not HTTP calls the route attempts after commit.
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

revoke all on function public.revoke_delegation(uuid, text, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.revoke_delegation(uuid, text, uuid, timestamptz)
  to musebook_worker, service_role;
