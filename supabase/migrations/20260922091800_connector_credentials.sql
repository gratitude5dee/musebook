-- 13. Connector credentials + agent appeals (§10.8.1, §10.9.5).
--     Both tables are owned by §10 here — this file, not §4.14's loop, owns their
--     grants, policies and FORCE RLS.

create table public.connector_credentials (
  id            uuid primary key default gen_random_uuid(),
  delegation_id uuid not null references public.delegations(id) on delete cascade,
  kind          text not null,
  -- AES-256-GCM: 12-byte iv || 16-byte tag || ciphertext. Encrypted in the Worker,
  -- not in SQL. The database never sees a plaintext credential or the key.
  ciphertext    bytea not null,
  key_id        text not null,
  expires_at    timestamptz,
  created_at    timestamptz not null default now(),
  rotated_at    timestamptz,
  constraint connector_credentials_kind_allowed
    check (kind in ('oauth_access','oauth_refresh','bearer','bridge_token')),
  constraint connector_credentials_ciphertext_min check (octet_length(ciphertext) >= 29)
);
create unique index connector_credentials_one_per_kind
  on public.connector_credentials (delegation_id, kind);
create index connector_credentials_expiry_idx on public.connector_credentials (expires_at)
  where expires_at is not null;

-- RLS, and FORCE, because a NOBYPASSRLS role is still exempt on tables it owns and
-- Supabase migrations create tables owned by `postgres` (§4.14, CF-SPINE §2).
alter table public.connector_credentials enable row level security;
alter table public.connector_credentials force row level security;

-- No grant to anon or authenticated. Ever. Not even select. The owner's UI shows
-- "connected, expires in N days" from a view over expires_at, never the value.
revoke all on public.connector_credentials from public, anon, authenticated;

-- Exactly one Worker plane may touch it: the jobs plane, which is the only plane
-- that runs an adapter. musebook_kernel (the paywall plane) must NOT be able to
-- read a third party's credential, and musebook_public_reader must not exist here.
grant select, insert, update, delete on public.connector_credentials to musebook_jobs;
create policy connector_credentials_jobs_all on public.connector_credentials
  for all to musebook_jobs using (true) with check (true);

-- Appeals (§10.9.5): their own table rather than approval_queue, because the
-- reviewer is Musebook staff rather than the delegation's owner.
create table public.agent_appeals (
  id            uuid primary key default gen_random_uuid(),
  delegation_id uuid not null references public.delegations(id) on delete cascade,
  owner_user_id uuid not null references public.users(id) on delete cascade,
  statement     text not null,
  state         text not null default 'open',
  reputation_before numeric(5,2) not null,
  decided_at    timestamptz,
  decision_note text,
  created_at    timestamptz not null default now(),
  constraint agent_appeals_state_allowed check (state in ('open','upheld','denied','withdrawn')),
  constraint agent_appeals_statement_len check (length(statement) between 20 and 2000)
);
create unique index agent_appeals_one_open_per_delegation
  on public.agent_appeals (delegation_id) where state = 'open';
create index agent_appeals_open_idx on public.agent_appeals (created_at) where state = 'open';

alter table public.agent_appeals enable row level security;
alter table public.agent_appeals force row level security;

-- Browser plane: an owner reads their own appeals through PostgREST, where
-- auth.uid() is real. This is the one table in this section with an
-- `authenticated` grant.
grant select on public.agent_appeals to authenticated;
create policy agent_appeals_owner_read on public.agent_appeals
  for select to authenticated using (owner_user_id = (select auth.uid()));

-- Worker plane: through Hyperdrive there is no auth.uid() — it returns null — so
-- the policy above is inert for a Worker and a separate one is required.
-- app.actor_id() is set by app.enter() per statement (§4.14.1); the ladder reads
-- appeals to decide whether a strike is under appeal.
grant select, update on public.agent_appeals to musebook_jobs;
create policy agent_appeals_jobs_all on public.agent_appeals
  for all to musebook_jobs using (true) with check (true);
