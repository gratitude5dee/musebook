-- supabase/migrations/20260922090210_identity_link.sql
-- Companion to migration 03 (section 4.3) and migration 14 (section 4.14).
-- Kept as its own file so those migrations stay byte-stable.

create or replace function public.link_wallet_identity(
  p_address  text,
  p_chain_id integer default 8453
)
returns table (user_id uuid, handle text, created boolean)
language plpgsql
security definer
set search_path = public, app, extensions
as $$
declare
  v_user_id uuid;
  v_handle  text;
  v_created boolean := false;
  v_addr    text := lower(p_address);
begin
  if not app.is_evm_address(v_addr) then
    raise exception 'link_wallet_identity: % is not an EVM address', p_address
      using errcode = '22023';
  end if;

  -- Fast path: the address is already known.
  select w.user_id into v_user_id
  from public.wallets w
  where w.address = v_addr;

  if v_user_id is null then
    insert into public.users (analytics_consent) values (true)
    returning id into v_user_id;

    -- Deterministic, collision-safe handle: mb_<last 8 hex of the address>,
    -- with a numeric suffix only if that is somehow taken.
    v_handle := 'mb_' || right(v_addr, 8);
    if exists (select 1 from public.profiles p where lower(p.handle) = v_handle) then
      v_handle := v_handle || '_' || to_char(floor(random() * 9000 + 1000), 'FM9999');
    end if;

    insert into public.profiles (user_id, handle) values (v_user_id, v_handle);

    insert into public.wallets (user_id, address, is_primary, verified_at)
    values (v_user_id, v_addr, true, now())
    on conflict (address) do nothing;

    -- Lost the race: another transaction created the user first. Adopt theirs.
    select w.user_id into v_user_id from public.wallets w where w.address = v_addr;
    v_created := true;
  else
    update public.wallets w set verified_at = now()
    where w.address = v_addr;
  end if;

  select p.handle into v_handle from public.profiles p where p.user_id = v_user_id;
  return query select v_user_id, v_handle, v_created;
end;
$$;

revoke all on function public.link_wallet_identity(text, integer) from public, anon, authenticated;

-- -------------------------------------------------------------------------
-- The Worker plane's two narrow capabilities.
--
-- Both are SECURITY DEFINER on purpose, and that means both bypass RLS. That is
-- the honest trade of 5.6.3: rather than widen the §4.14 grant matrix (which
-- would let ANY kernel query read ANY delegation row), each capability is a
-- function whose argument IS the authorization. You cannot get a delegation out
-- of resolve_delegation without already holding its token.
-- -------------------------------------------------------------------------

-- (a) Bootstrap read for resolveActor. §4.14's delegations_actor_read policy is
--     `owner_user_id = app.actor_id()`, which cannot work here: resolveActor is
--     the thing that DISCOVERS the actor, so app.actor_id() is null when it runs.
--     Returns the authorization fields only — never the token hash, never a cap.
create or replace function app.resolve_delegation(p_token_sha256 text)
returns table (
  id                 uuid,
  owner_user_id      uuid,
  agent_identity_id  uuid,
  connector_slug     text,
  scopes             text[],
  requires_approval  boolean,
  state              text,
  expires_at         timestamptz,
  quarantined_until  timestamptz
)
language plpgsql
security definer
stable
set search_path = public, app
as $$
begin
  -- plpgsql, not sql: §16.8 runs this file before 20260922091000_agents.sql
  -- creates public.delegations, and language-sql bodies are name-checked at
  -- create time. plpgsql defers the lookup to first call, by which time the
  -- table exists.
  return query
  select d.id, d.owner_user_id, d.agent_identity_id, c.slug, d.scopes,
         d.requires_approval, d.state::text, d.expires_at, d.quarantined_until
    from public.delegations d
    join public.connectors  c on c.id = d.connector_id
   where d.token_sha256 = p_token_sha256
     and c.is_enabled;
end;
$$;

revoke all on function app.resolve_delegation(text) from public, anon, authenticated;
-- grant execute lives in 20260922091300_worker_role_and_rls_audit.sql — the roles
-- are created there and this file runs before them (§16.8 ordering).

-- (b) The agent-sighting upsert, called ONLY from the jobs plane (5.6.2). The
--     request path never writes agent_identities; it enqueues and returns.
create or replace function app.touch_agent_identity(
  p_signature_agent text,
  p_directory_keyid text,
  p_display_name    text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, app
as $$
declare
  v_id   uuid;
  v_slug text := 'wba-' || substr(encode(digest(lower(p_signature_agent), 'sha256'), 'hex'), 1, 16);
begin
  update public.agent_identities
     set last_seen_at = now(),
         directory_keyid = p_directory_keyid,
         verification = 'web_bot_auth'
   where signature_agent = lower(p_signature_agent)
   returning id into v_id;

  if v_id is null then
    insert into public.agent_identities
      (slug, display_name, verification, signature_agent, directory_url,
       directory_keyid, first_seen_at, last_seen_at)
    values
      (v_slug,
       coalesce(p_display_name, lower(p_signature_agent)),
       'web_bot_auth',
       lower(p_signature_agent),
       lower(p_signature_agent) || '/.well-known/http-message-signatures-directory',
       p_directory_keyid, now(), now())
    on conflict (slug) do update set last_seen_at = now()
    returning id into v_id;
  end if;

  return v_id;
end;
$$;

revoke all on function app.touch_agent_identity(text, text, text) from public, anon, authenticated;
-- grant execute lives in 20260922091300_worker_role_and_rls_audit.sql.
