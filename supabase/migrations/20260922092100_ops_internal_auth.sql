-- ops_internal_auth (M11): internal_request_nonces (§15.5) + the two
-- settlement-reality constraints (§15.3 MOG-2).
create table public.internal_request_nonces (
  nonce      text primary key,
  key_id     text not null,
  method     text not null,
  path       text not null,
  seen_at    timestamptz not null default now(),
  expires_at timestamptz not null,
  constraint internal_request_nonces_shape check (nonce ~ '^[A-Za-z0-9_-]{22,64}$')
);
create index internal_request_nonces_expires_idx on public.internal_request_nonces (expires_at);

alter table public.internal_request_nonces enable row level security;
alter table public.internal_request_nonces force row level security;   -- section 4.14
grant select, insert on public.internal_request_nonces to musebook_jobs;
create policy internal_nonces_jobs on public.internal_request_nonces
  for all to musebook_jobs using (true) with check (true);

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('reap-internal-nonces', '*/5 * * * *',
      $cmd$delete from public.internal_request_nonces where expires_at < now()$cmd$);
  end if;
end $$;

-- A settlement may only be 'settled' if it carries a real 32-byte transaction
-- hash AND the facilitator's own response that produced it. There is no code
-- path, privileged or otherwise, that can write a fabricated settlement.
alter table public.x402_settlements
  add constraint x402_settlements_settled_is_real check (
    status <> 'settled'
    or (transaction ~ '^0x[0-9a-f]{64}$' and settle_response is not null)
  );

alter table public.refunds
  add constraint refunds_completed_is_real check (
    status <> 'settled' or transaction ~ '^0x[0-9a-f]{64}$'
  );
