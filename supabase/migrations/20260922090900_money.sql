-- 10. Money: x402_quotes, x402_settlements, access_grants, payout_ledger, refunds.

create table public.x402_quotes (
  id                  uuid primary key default gen_random_uuid(),
  resource_url        text not null,
  post_id             uuid references public.posts(id) on delete cascade,
  content_hash        text not null,
  requested_by_agent  uuid references public.agent_identities(id) on delete set null,
  transport           text not null default 'http',  -- 'http' | 'mcp'
  x402_version        smallint not null default 2,
  scheme              text not null default 'exact',
  network             text not null,                 -- CAIP-2, e.g. 'eip155:8453'
  asset               text not null,                 -- ERC-20 contract address
  pay_to              text not null,                 -- ALWAYS the treasury X402_PAY_TO, never a creator wallet
  amount_atomic       numeric(78,0) not null,
  max_timeout_seconds integer not null default 60,   -- == QUOTE_TTL_SECONDS (section 6.7.6); 60 everywhere
  rate_source         text not null default 'direct_usdc',  -- v1 has no oracle; a fiat oracle is additive
  requirements        jsonb not null,                -- full PaymentRequired object as served
  issued_at           timestamptz not null default now(),
  expires_at          timestamptz not null,
  consumed_at         timestamptz,
  constraint x402_quotes_version_is_2 check (x402_version = 2),
  constraint x402_quotes_network_caip2 check (network ~ '^[a-z0-9-]{3,8}:[a-zA-Z0-9_-]{1,32}$'),
  constraint x402_quotes_amount_positive check (amount_atomic > 0),
  constraint x402_quotes_hash_len check (length(content_hash) = 64),
  constraint x402_quotes_transport_allowed check (transport in ('http','mcp')),
  constraint x402_quotes_rate_source_allowed check (rate_source in ('direct_usdc','oracle'))
);
create index x402_quotes_hash_idx on public.x402_quotes (content_hash, issued_at desc);
create index x402_quotes_expiry_idx on public.x402_quotes (expires_at) where consumed_at is null;

create table public.x402_settlements (
  id             uuid primary key default gen_random_uuid(),
  quote_id       uuid references public.x402_quotes(id) on delete set null,
  post_id        uuid references public.posts(id) on delete set null,
  content_hash   text not null,
  network        text not null,
  asset          text not null,
  payer          text not null,
  nonce          text not null,           -- EIP-3009 authorization nonce, 0x + 64 hex
  amount_atomic  numeric(78,0) not null,
  pay_to         text not null,
  transaction    text not null default '', -- '' until broadcast; see SettleResponse
  status         settlement_status not null default 'pending',
  error_reason   text,
  facilitator_url text not null,
  verify_response jsonb,
  settle_response jsonb,
  created_at     timestamptz not null default now(),
  settled_at     timestamptz,
  constraint x402_settlements_hash_len check (length(content_hash) = 64),
  constraint x402_settlements_payer_shape check (app.is_evm_address(payer)),
  constraint x402_settlements_nonce_shape check (nonce ~ '^0x[0-9a-f]{64}$'),
  constraint x402_settlements_amount_positive check (amount_atomic > 0),
  constraint x402_settlements_settled_has_tx check (
    status <> 'settled' or length(transaction) > 0
  )
);

-- THE REPLAY INDEX. An EIP-3009 authorization nonce is unique per (token, from);
-- this index makes a replayed PAYMENT-SIGNATURE a unique-violation rather than a
-- second grant. It covers every status on purpose: a failed settlement must not be
-- retried by reusing the same signed authorization.
create unique index x402_settlements_replay_uniq
  on public.x402_settlements (network, asset, payer, nonce);

create index x402_settlements_payer_idx on public.x402_settlements (payer, created_at desc);
create index x402_settlements_hash_idx on public.x402_settlements (content_hash, status);
create index x402_settlements_pending_idx on public.x402_settlements (created_at)
  where status = 'pending';

-- A durable entitlement. Only publish_mode = 'human_free_agent_paid' mints one;
-- 'x402_always' charges every fetch and mints nothing (section 1.4).
create table public.access_grants (
  id             uuid primary key default gen_random_uuid(),
  settlement_id  uuid not null references public.x402_settlements(id) on delete restrict,
  content_hash   text not null,
  post_id        uuid references public.posts(id) on delete set null,
  payer          text not null,
  subject_user_id  uuid references public.users(id) on delete set null,
  subject_agent_id uuid references public.agent_identities(id) on delete set null,
  granted_at     timestamptz not null default now(),
  expires_at     timestamptz,             -- null = durable for this content_hash
  revoked_at     timestamptz,
  constraint access_grants_hash_len check (length(content_hash) = 64),
  constraint access_grants_payer_shape check (app.is_evm_address(payer))
);
-- One live grant per payer per exact bytes. The grant does not survive an edit,
-- by construction, because content_hash changes.
create unique index access_grants_payer_hash_uniq
  on public.access_grants (payer, content_hash) where revoked_at is null;
create index access_grants_hash_idx on public.access_grants (content_hash) where revoked_at is null;
create index access_grants_agent_idx on public.access_grants (subject_agent_id)
  where subject_agent_id is not null and revoked_at is null;
create index access_grants_expiry_idx on public.access_grants (expires_at)
  where expires_at is not null and revoked_at is null;

-- Double-entry. Every row is one signed leg; every ledger_tx_id must sum to zero.
create table public.payout_ledger (
  id             uuid primary key default gen_random_uuid(),
  ledger_tx_id   uuid not null,
  account_kind   text not null,   -- 'creator' | 'platform' | 'payer' | 'refund_reserve'
  account_user_id uuid references public.users(id) on delete restrict,
  account_address text,
  asset          text not null,
  network        text not null,
  amount_atomic  numeric(78,0) not null,   -- signed: credit > 0, debit < 0
  settlement_id  uuid references public.x402_settlements(id) on delete restrict,
  refund_id      uuid,
  memo           text,
  created_at     timestamptz not null default now(),
  constraint payout_ledger_account_kind_allowed
    check (account_kind in ('creator','platform','payer','refund_reserve')),
  constraint payout_ledger_amount_nonzero check (amount_atomic <> 0),
  constraint payout_ledger_has_account
    check (account_user_id is not null or account_address is not null)
);
create index payout_ledger_tx_idx on public.payout_ledger (ledger_tx_id);
create index payout_ledger_account_idx on public.payout_ledger (account_user_id, created_at desc)
  where account_user_id is not null;
create index payout_ledger_settlement_idx on public.payout_ledger (settlement_id)
  where settlement_id is not null;

create or replace function app.assert_ledger_tx_balanced() returns trigger
language plpgsql as $$
declare v_sum numeric;
begin
  select coalesce(sum(amount_atomic), 0) into v_sum
    from public.payout_ledger where ledger_tx_id = new.ledger_tx_id;
  if v_sum <> 0 then
    raise exception 'payout_ledger tx % does not balance (sum=%)', new.ledger_tx_id, v_sum
      using errcode = '23514';
  end if;
  return null;
end;
$$;

create constraint trigger payout_ledger_balanced
  after insert on public.payout_ledger
  deferrable initially deferred
  for each row execute function app.assert_ledger_tx_balanced();

-- Append-only: correction is a reversing entry, never an UPDATE.
revoke update, delete on public.payout_ledger from public, anon, authenticated;

create table public.refunds (
  id            uuid primary key default gen_random_uuid(),
  settlement_id uuid not null references public.x402_settlements(id) on delete restrict,
  reason        text not null,
  amount_atomic numeric(78,0) not null,
  status        settlement_status not null default 'pending',
  transaction   text not null default '',
  initiated_by_user_id uuid references public.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  completed_at  timestamptz,
  constraint refunds_amount_positive check (amount_atomic > 0)
);
create unique index refunds_settlement_uniq on public.refunds (settlement_id);
create index refunds_pending_idx on public.refunds (created_at) where status = 'pending';

alter table public.payout_ledger add constraint payout_ledger_refund_fk
  foreign key (refund_id) references public.refunds(id) on delete restrict;

alter table public.x402_quotes      enable row level security;  -- kernel plane only (4.14)
alter table public.x402_settlements enable row level security;  -- kernel plane only (4.14)
alter table public.access_grants    enable row level security;  -- kernel plane only (4.14)
alter table public.refunds          enable row level security;  -- kernel plane only (4.14)
alter table public.payout_ledger    enable row level security;

grant select on public.payout_ledger to authenticated;
create policy payout_ledger_owner_read on public.payout_ledger
  for select to authenticated
  using (account_user_id = (select auth.uid()));
