-- 01. Extensions, schemas, shared helpers.
-- Target: musebook-prod, Postgres 17.x, org lskgtzehnlfzimkxhwre.

create schema if not exists extensions;
create schema if not exists app;          -- helper functions, never PostgREST-exposed

create extension if not exists vector     with schema extensions;  -- 0.8.0
create extension if not exists pg_partman with schema extensions;  -- 5.3.1
create extension if not exists pg_trgm    with schema extensions;  -- 1.6
create extension if not exists btree_gin  with schema extensions;  -- 1.3
-- pgcrypto 1.3  : already installed by Supabase in `extensions`. Do not re-create.
-- pg_cron 1.6   : already installed by Supabase in `pg_catalog`. Do not re-create.
-- pgmq          : DELIBERATELY NOT INSTALLED. Cloudflare Queues is the async spine
--                 (CF-spine §3); the outbox in 4.13 is a plain table.

-- Keep PostgREST away from the helper schema.
revoke all on schema app from anon, authenticated;

-- updated_at maintenance, attached to every mutable entity table.
create or replace function app.set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Lowercase 0x-prefixed EVM address. Used in CHECKs across identity and money.
create or replace function app.is_evm_address(p text) returns boolean
language sql immutable strict as $$
  select p ~ '^0x[0-9a-f]{40}$';
$$;

-- sha256 hex of a text value. Wraps pgcrypto so call sites need not schema-qualify.
create or replace function app.sha256_hex(p text) returns text
language sql immutable strict as $$
  select encode(extensions.digest(p, 'sha256'), 'hex');
$$;

-- The Worker-plane actor. Set per transaction by the Hyperdrive caller
-- (4.14's SET LOCAL pattern); null on the PostgREST plane, where auth.uid() is
-- the equivalent. Every owner-scoped policy that names musebook_* uses this.
-- STABLE, not IMMUTABLE: it reads session state, so it must not be used in a CHECK.
create or replace function app.actor_id() returns uuid
language sql stable as $$
  select nullif(current_setting('app.actor_id', true), '')::uuid;
$$;
