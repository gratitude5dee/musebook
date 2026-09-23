-- 14. The Worker-plane roles, FORCE ROW LEVEL SECURITY, the grant matrix,
--     and the assertions that keep all three true.

-- ---------------------------------------------------------------- roles
-- The ONLY role that ever appears in a Hyperdrive connection string. NOINHERIT:
-- it holds no privilege passively and must SET ROLE into a task role to do
-- anything at all. NOBYPASSRLS is the whole point; never
-- `grant postgres to musebook_worker` — Cloudflare's own Supabase snippet shows
-- that line and its own comment admits it is wrong for production.
-- LOGIN but NO PASSWORD here: see the note below.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'musebook_worker') then
    create role musebook_worker login
      noinherit nobypassrls nocreatedb nocreaterole nosuperuser;
  end if;
  -- Task roles. NOLOGIN: reachable only through SET ROLE.
  if not exists (select 1 from pg_roles where rolname = 'musebook_public_reader') then
    create role musebook_public_reader nologin noinherit nobypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'musebook_kernel') then
    create role musebook_kernel nologin noinherit nobypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'musebook_jobs') then
    create role musebook_jobs nologin noinherit nobypassrls;
  end if;
end;
$$;

grant musebook_public_reader, musebook_kernel, musebook_jobs to musebook_worker;

grant usage on schema public, app to
  musebook_public_reader, musebook_kernel, musebook_jobs;
-- `extensions` holds pgvector — jobs casts (r->>'embedding')::extensions.vector
-- in app.record_embeddings; without USAGE the type lookup itself 42501s.
grant usage on schema extensions to
  musebook_public_reader, musebook_kernel, musebook_jobs;
grant execute on function app.actor_id(), app.is_evm_address(text), app.sha256_hex(text) to
  musebook_public_reader, musebook_kernel, musebook_jobs;

-- ------------------------------------------------- FORCE on every table
-- ENABLE alone is not enough: in PostgreSQL the OWNER of a table is exempt from
-- its own policies unless FORCE is set, and Supabase migrations create tables
-- owned by `postgres`. A loop, not a list, so a table added by a later section
-- cannot be forgotten -- and the assertion at the bottom of this file proves it.
do $$
declare r record;
begin
  for r in
    select c.oid::regclass as t
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relkind in ('r','p')
       and c.relispartition = false        -- a leaf inherits its parent's posture
  loop
    execute format('alter table %s enable row level security', r.t);
    execute format('alter table %s force  row level security', r.t);
  end loop;
end;
$$;

-- ------------------------------------------------------- grant matrix
-- Emitted from arrays so the matrix is legible as data and a later addition is a
-- one-line diff. Each block grants the narrowest privilege the subsystem needs and
-- pairs it with the one policy that admits that role and no other.
do $$
declare t text;
begin
  -- (1) Public-readable: the catalog surface. Same rows the browser already reads.
  foreach t in array array[
    'profiles','agent_identities','posts','artifacts','post_assets','post_counters',
    'post_classifications','platforms','scopes','connectors',
    'platform_publishing_defaults','follows','likes','reposts','comments']
  loop
    execute format('grant select on public.%I to musebook_public_reader, musebook_kernel, musebook_jobs', t);
    execute format($f$create policy %1$I_worker_read on public.%1$I
                      for select to musebook_public_reader, musebook_kernel, musebook_jobs
                      using (true)$f$, t);
  end loop;

  -- (2) Kernel-only: identity, bodies and money. musebook_jobs and
  --     musebook_public_reader are NOT admitted, so a classification consumer or a
  --     catalog read cannot reach a paid body even with a SQL bug.
  foreach t in array array[
    'users','wallets','wallet_nonces','sessions','post_bodies','post_versions',
    'x402_quotes','x402_settlements','access_grants','refunds','payout_ledger']
  loop
    execute format('grant select on public.%I to musebook_kernel', t);
    execute format($f$create policy %1$I_kernel_read on public.%1$I
                      for select to musebook_kernel using (true)$f$, t);
  end loop;
  -- The kernel's writes: quotes, settlements, grants, ledger legs, sessions, nonces.
  foreach t in array array[
    'wallet_nonces','sessions','x402_quotes','x402_settlements','access_grants',
    'payout_ledger','refunds']
  loop
    execute format('grant insert on public.%I to musebook_kernel', t);
    execute format($f$create policy %1$I_kernel_write on public.%1$I
                      for insert to musebook_kernel with check (true)$f$, t);
  end loop;

  -- (3) Owner-scoped: the Worker sees one actor's rows, set per transaction.
  --     This is the one place the policy does real filtering rather than
  --     expressing least privilege between roles.
  --     The owner column differs per table, so the two families are emitted
  --     separately rather than with an `or` over a column one of them lacks.
  foreach t in array array['assets'] loop
    execute format('grant select on public.%I to musebook_kernel', t);
    execute format($f$create policy %1$I_actor_read on public.%1$I
                      for select to musebook_kernel
                      using (owner_user_id = app.actor_id())$f$, t);
  end loop;
  foreach t in array array['creator_publishing_defaults','delegations'] loop
    execute format('grant select on public.%I to musebook_kernel', t);
    execute format($f$create policy %1$I_actor_read on public.%1$I
                      for select to musebook_kernel
                      using (%2$I = app.actor_id())$f$, t,
                   case t when 'delegations' then 'owner_user_id' else 'user_id' end);
  end loop;

  -- (4) Jobs plane: everything the queue consumers and Cron Workers own.
  foreach t in array array[
    'job_outbox','ops_events','idempotency_keys','action_events',
    'action_events_daily','slates','slate_items','post_embeddings','user_embeddings',
    'post_classifications','post_classifications_raw','delegation_spend',
    'agent_spend_reservations','audit_log','platform_variants','distribution_jobs',
    'platform_analytics','post_counters','approval_queue']
  loop
    execute format('grant select, insert, update on public.%I to musebook_jobs', t);
    execute format($f$create policy %1$I_jobs_all on public.%1$I
                      for all to musebook_jobs using (true) with check (true)$f$, t);
  end loop;
  -- The two sub-partition parents under action_events: queries that go
  -- through them check their ACL directly (leaf partitions' own ACLs are
  -- never consulted, and the action_events_jobs_all policy already covers
  -- every leaf row).
  grant select on public.action_events_human, public.action_events_agent
    to musebook_jobs;

  -- Dimension tables the jobs plane reads but must never write.
  foreach t in array array['ranking_weights','model_registry','channels','delegations'] loop
    execute format('grant select on public.%I to musebook_jobs', t);
    execute format($f$create policy %1$I_jobs_read on public.%1$I
                      for select to musebook_jobs using (true)$f$, t);
  end loop;
end;
$$;

-- The append-only tables stay append-only for the Worker too.
revoke update, delete on public.payout_ledger, public.audit_log from
  musebook_worker, musebook_public_reader, musebook_kernel, musebook_jobs;

grant execute on function public.claim_job(bigint)          to musebook_jobs;
grant execute on function public.adjust_post_counter(uuid, text, bigint) to musebook_jobs;
grant execute on function public.publish_post(uuid, text[]) to musebook_kernel;
grant execute on function app.resolve_delegation(text) to musebook_kernel;
grant execute on function app.touch_agent_identity(text, text, text) to musebook_jobs;

-- Belt and braces: nothing is granted to a Worker role on a table created later.
-- This is a no-op today (no default privilege grants these roles anything) and it
-- stays a no-op if someone later adds one.
alter default privileges in schema public
  revoke all on tables from
    musebook_public_reader, musebook_kernel, musebook_jobs;
alter default privileges in schema public
  revoke all on sequences from
    musebook_public_reader, musebook_kernel, musebook_jobs;

-- Nothing in public is writable by a PostgREST client, enforced at the GRANT
-- layer as well as the policy layer (§4.14 block f). Supabase's built-in
-- default privileges grant ALL on each new table to anon and authenticated,
-- so both the standing revoke and the default-privileges revoke are needed.
revoke insert, update, delete on all tables in schema public
  from anon, authenticated;
alter default privileges in schema public
  revoke insert, update, delete on tables from anon, authenticated;

-- Pin search_path on every callable function. A function without the parameter
-- resolves objects through the *caller's* search_path at each call, which lets
-- a hostile caller shadow catalog or schema objects (PostgREST's
-- function_search_path_mutable lint, flagged on all seven of ours).
alter function public.claim_job(bigint) set search_path = pg_catalog, public, app;
alter function app.actor_id() set search_path = pg_catalog, public, app;
alter function app.assert_ledger_tx_balanced() set search_path = pg_catalog, public, app;
alter function app.ensure_action_event_partitions(integer) set search_path = pg_catalog, public, app;
alter function app.is_evm_address(text) set search_path = pg_catalog, public, app;
alter function app.set_updated_at() set search_path = pg_catalog, public, app;
alter function app.sha256_hex(text) set search_path = pg_catalog, public, app;
