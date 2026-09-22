-- 03. Identity: users, profiles, wallets, sessions, agent_identities.

create table public.users (
  id                uuid primary key default gen_random_uuid(),
  email             text,
  email_verified_at timestamptz,
  country_code      char(2),
  tos_accepted_at   timestamptz,
  marketing_consent boolean not null default false,
  analytics_consent boolean not null default true,
  is_suspended      boolean not null default false,
  deleted_at        timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint users_email_shape check (email is null or email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')
);
create unique index users_email_lower_uniq on public.users (lower(email)) where email is not null;
create index users_deleted_at_idx on public.users (deleted_at) where deleted_at is not null;

create table public.profiles (
  user_id      uuid primary key references public.users(id) on delete cascade,
  handle       text not null,
  display_name text,
  bio          text,
  avatar_url   text,
  banner_url   text,
  website_url  text,
  is_verified  boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint profiles_handle_shape check (handle ~ '^[a-z0-9_]{3,30}$'),
  constraint profiles_bio_len check (bio is null or length(bio) <= 500)
);
create unique index profiles_handle_uniq on public.profiles (lower(handle));
-- Trigram index for the @-mention autocomplete and people search.
create index profiles_handle_trgm_idx on public.profiles using gin (handle extensions.gin_trgm_ops);
create index profiles_display_name_trgm_idx on public.profiles using gin (display_name extensions.gin_trgm_ops);

create table public.wallets (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.users(id) on delete cascade,
  address     text not null,
  is_primary  boolean not null default false,
  verified_at timestamptz,
  created_at  timestamptz not null default now(),
  constraint wallets_address_shape check (app.is_evm_address(address))
);
-- One address maps to at most one user, globally. This is the join key for x402 grants.
create unique index wallets_address_uniq on public.wallets (address);
create unique index wallets_one_primary_per_user on public.wallets (user_id) where is_primary;
create index wallets_user_idx on public.wallets (user_id);

-- SIWE / EIP-191 replay prevention. Ported verbatim in shape from
-- /home/user/mog/supabase/migrations/20260305101500_phase1_stability_walletproof.sql,
-- which is the single best piece of security code in the MogBook repo.
create table public.wallet_nonces (
  id          uuid primary key default gen_random_uuid(),
  nonce       text not null unique,
  address     text not null,
  action      text not null,
  message     text not null,
  expires_at  timestamptz not null,
  consumed_at timestamptz,
  created_at  timestamptz not null default now(),
  constraint wallet_nonces_address_shape check (app.is_evm_address(address)),
  constraint wallet_nonces_action_shape check (action ~ '^[a-z0-9_:-]{3,64}$')
);
create index wallet_nonces_address_action_idx on public.wallet_nonces (address, action, created_at desc);
create index wallet_nonces_expires_idx on public.wallet_nonces (expires_at) where consumed_at is null;

create table public.sessions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.users(id) on delete cascade,
  actor        actor_class not null,
  token_sha256 text not null,
  issued_at    timestamptz not null default now(),
  expires_at   timestamptz not null,
  revoked_at   timestamptz,
  last_seen_at timestamptz,
  ip_hash      text,
  user_agent   text,
  constraint sessions_token_hash_len check (length(token_sha256) = 64)
);
create unique index sessions_token_uniq on public.sessions (token_sha256);
create index sessions_user_active_idx on public.sessions (user_id, expires_at desc) where revoked_at is null;
create index sessions_expires_idx on public.sessions (expires_at) where revoked_at is null;

-- Every non-human actor the system has ever seen: the creator's own agent,
-- a third-party crawler, an MCP caller. One row per identity, not per request.
create table public.agent_identities (
  id                 uuid primary key default gen_random_uuid(),
  slug               text not null,
  display_name       text not null,
  owner_user_id      uuid references public.users(id) on delete set null,
  wallet_address     text,
  verification       agent_verification not null default 'none',
  signature_agent    text,   -- Signature-Agent header value, e.g. https://agent.example
  directory_url      text,   -- /.well-known/http-message-signatures-directory
  directory_keyid    text,   -- Ed25519 keyid last used to verify a request
  user_agent_pattern text,
  moltbook_id        text,
  registry_token_id  numeric(78,0),  -- Moltbook Registry (Base) tokenId, if registered
  first_seen_at      timestamptz not null default now(),
  last_seen_at       timestamptz,
  is_blocked         boolean not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint agent_identities_slug_shape check (slug ~ '^[a-z0-9][a-z0-9_-]{1,62}$'),
  constraint agent_identities_wallet_shape
    check (wallet_address is null or app.is_evm_address(wallet_address))
);
create unique index agent_identities_slug_uniq on public.agent_identities (slug);
create unique index agent_identities_moltbook_uniq
  on public.agent_identities (moltbook_id) where moltbook_id is not null;
create index agent_identities_owner_idx on public.agent_identities (owner_user_id)
  where owner_user_id is not null;
create index agent_identities_sigagent_idx on public.agent_identities (signature_agent)
  where signature_agent is not null;

create trigger users_set_updated_at            before update on public.users            for each row execute function app.set_updated_at();
create trigger profiles_set_updated_at         before update on public.profiles         for each row execute function app.set_updated_at();
create trigger agent_identities_set_updated_at before update on public.agent_identities for each row execute function app.set_updated_at();

-- RLS
alter table public.users            enable row level security;  -- kernel plane only (4.14)
alter table public.wallets          enable row level security;  -- kernel plane only (4.14)
alter table public.wallet_nonces    enable row level security;  -- kernel plane only (4.14)
alter table public.sessions         enable row level security;  -- kernel plane only (4.14)
alter table public.profiles         enable row level security;
alter table public.agent_identities enable row level security;

grant select on public.profiles to anon, authenticated;
create policy profiles_public_read on public.profiles
  for select to anon, authenticated
  using (true);

grant select on public.agent_identities to anon, authenticated;
create policy agent_identities_public_read on public.agent_identities
  for select to anon, authenticated
  using (is_blocked = false);
