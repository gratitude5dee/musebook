-- 20260922091601_settlement_ops.sql — the SettlementStore the x402 settleOnce
-- (§6.8) drives over HYPERDRIVE_FRESH. Every function enters the kernel plane
-- inside itself (D23), every statement is a single round trip — no BEGIN/COMMIT
-- across a pooled Hyperdrive connection.
--
-- Deviation D63: §16.8's M8 migration list names only 20260922091600; these
-- functions are additive against §6.8/§6.10 verbatim shapes.

-- The signed payment is stored for resend: the worker's reconciler needs the
-- verbatim payload to retry a facilitator-settle that never broadcast (§6.8's
-- pending-row sweep). D68: §6.9's table sketch doesn't list the column.
alter table public.x402_settlements add column payment_payload jsonb;

-- §4.14's rule: every RLS-enabled table also FORCES it for the table owner.
alter table public.revenue_share_policies force row level security;

-- ── quote reads ─────────────────────────────────────────────────────────────
-- Shape returned to packages/x402 SettlementStore.findQuoteById /
-- findLiveQuote. requirements is echoed so the caller can rebuild the pinned
-- PaymentRequirements without re-deriving it.

create or replace function app.find_quote_by_id(p_id uuid, p_actor uuid default null)
returns table (
  id uuid, content_hash text, network text, asset text, pay_to text,
  amount_atomic numeric, max_timeout_seconds integer, rate_source text,
  expires_at timestamptz, consumed_at timestamptz
)
language plpgsql stable
set search_path = public, pg_temp
as $$
begin
  perform app.enter('musebook_kernel', p_actor);
  return query
    select q.id, q.content_hash, q.network, q.asset, q.pay_to,
           q.amount_atomic, q.max_timeout_seconds, q.rate_source,
           q.expires_at, q.consumed_at
      from public.x402_quotes q
     where q.id = p_id;
end;
$$;

-- The fallback lookup for a client that did not echo extra.quoteId (§6.7.6):
-- the most recent unconsumed quote matching (content_hash, network, asset,
-- amount_atomic) with expires_at > now().
create or replace function app.find_live_quote(
  p_content_hash  text,
  p_network       text,
  p_asset         text,
  p_amount_atomic numeric,
  p_actor         uuid default null
)
returns table (
  id uuid, content_hash text, network text, asset text, pay_to text,
  amount_atomic numeric, max_timeout_seconds integer, rate_source text,
  expires_at timestamptz, consumed_at timestamptz
)
language plpgsql stable
set search_path = public, pg_temp
as $$
begin
  perform app.enter('musebook_kernel', p_actor);
  return query
    select q.id, q.content_hash, q.network, q.asset, q.pay_to,
           q.amount_atomic, q.max_timeout_seconds, q.rate_source,
           q.expires_at, q.consumed_at
      from public.x402_quotes q
     where q.content_hash = p_content_hash
       and q.network = p_network
       and q.asset = lower(p_asset)
       and q.amount_atomic = p_amount_atomic
       and q.consumed_at is null
       and q.expires_at > now()
     order by q.issued_at desc
     limit 1;
end;
$$;

-- ── the replay claim (§6.8 step 3) ──────────────────────────────────────────
-- packages/x402/sql/insert_pending.sql verbatim, wrapped so the kernel plane is
-- entered inside the statement. `on conflict do nothing ... returning id` makes
-- the unique-violation race a NULL return instead of a 23505 to catch.

create or replace function app.insert_pending_settlement(
  p_quote_id              uuid,
  p_post_id               uuid,
  p_content_hash          text,
  p_network               text,
  p_asset                 text,
  p_payer                 text,
  p_nonce                 text,
  p_amount_atomic         numeric,
  p_pay_to                text,
  p_facilitator_url       text,
  p_verify_response       jsonb,
  p_revenue_share_version text,
  p_payment_payload       jsonb,
  p_actor                 uuid default null
)
returns uuid
language plpgsql
set search_path = public, pg_temp
as $$
declare v_id uuid;
begin
  perform app.enter('musebook_kernel', p_actor);
  insert into public.x402_settlements (
    quote_id, post_id, content_hash, network, asset, payer, nonce,
    amount_atomic, pay_to, facilitator_url, verify_response,
    revenue_share_version, payment_payload, status
  ) values (
    p_quote_id, p_post_id, p_content_hash, p_network, lower(p_asset),
    lower(p_payer), lower(p_nonce), p_amount_atomic, lower(p_pay_to),
    p_facilitator_url, p_verify_response, p_revenue_share_version,
    p_payment_payload, 'pending'
  )
  on conflict (network, asset, payer, nonce) do nothing
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function app.find_settlement(
  p_network text,
  p_asset   text,
  p_payer   text,
  p_nonce   text,
  p_actor   uuid default null
)
returns table (
  id uuid, content_hash text, status text, settled_at timestamptz,
  settle_response jsonb
)
language plpgsql stable
set search_path = public, pg_temp
as $$
begin
  perform app.enter('musebook_kernel', p_actor);
  return query
    select s.id, s.content_hash, s.status::text, s.settled_at, s.settle_response
      from public.x402_settlements s
     where s.network = p_network and s.asset = lower(p_asset)
       and s.payer = lower(p_payer) and s.nonce = lower(p_nonce)
     limit 1;
end;
$$;

-- markSettled flips only a 'pending' row: a second call, or the reconciler
-- racing the original request, is a no-op rather than a double-write.
create or replace function app.mark_settlement_settled(
  p_id              uuid,
  p_settle_response jsonb,
  p_actor           uuid default null
)
returns void
language plpgsql
set search_path = public, pg_temp
as $$
begin
  perform app.enter('musebook_kernel', p_actor);
  update public.x402_settlements
     set status = 'settled',
         transaction = coalesce(p_settle_response->>'transaction', transaction),
         settle_response = p_settle_response,
         settled_at = now()
   where id = p_id and status = 'pending';
end;
$$;

create or replace function app.mark_settlement_failed(
  p_id              uuid,
  p_settle_response jsonb,
  p_error_reason    text,
  p_actor           uuid default null
)
returns void
language plpgsql
set search_path = public, pg_temp
as $$
begin
  perform app.enter('musebook_kernel', p_actor);
  update public.x402_settlements
     set status = 'failed',
         settle_response = coalesce(p_settle_response, settle_response),
         error_reason = p_error_reason
   where id = p_id and status = 'pending';
end;
$$;

create or replace function app.consume_quote(p_id uuid, p_actor uuid default null)
returns void
language plpgsql
set search_path = public, pg_temp
as $$
begin
  perform app.enter('musebook_kernel', p_actor);
  update public.x402_quotes set consumed_at = now()
   where id = p_id and consumed_at is null;
end;
$$;

-- ── revenue split legs (§6.10) ──────────────────────────────────────────────
-- packages/x402/sql/post_settlement_legs.sql verbatim: one insert, three legs,
-- sums to zero — the deferred payout_ledger_balanced constraint trigger fires
-- at the implicit commit of this single statement.

-- D66: one row per (ledger_tx_id, account_kind) — a reconciler re-posting the
-- same settlement's legs after a crash hits this index inside
-- post_settlement_legs' `on conflict do nothing` and inserts nothing.
create unique index payout_ledger_tx_kind_uniq
  on public.payout_ledger (ledger_tx_id, account_kind);

create or replace function app.post_settlement_legs(
  p_ledger_tx_id        uuid,
  p_settlement_id       uuid,
  p_payer               text,
  p_creator_user_id     uuid,
  p_creator_address     text,
  p_asset               text,
  p_network             text,
  p_gross_atomic        numeric,
  p_platform_fee_atomic numeric,
  p_creator_net_atomic  numeric,
  p_actor               uuid default null
)
returns void
language plpgsql
set search_path = public, pg_temp
as $$
begin
  perform app.enter('musebook_kernel', p_actor);
  -- D66: the reconciler may re-run settle+flip after a crash; the unique
  -- index below makes a second post for the same settlement a no-op instead
  -- of a second accrual.
  insert into public.payout_ledger
    (ledger_tx_id, account_kind, account_user_id, account_address,
     asset, network, amount_atomic, settlement_id, memo)
  values
    (p_ledger_tx_id, 'payer',    null, lower(p_payer), p_asset, p_network,
     -p_gross_atomic, p_settlement_id, 'x402 settlement'),
    (p_ledger_tx_id, 'platform', null,
     (select lower(s.pay_to) from public.x402_settlements s where s.id = p_settlement_id),
     p_asset, p_network,
     p_platform_fee_atomic, p_settlement_id, 'platform fee'),
    (p_ledger_tx_id, 'creator',  p_creator_user_id, lower(p_creator_address),
     p_asset, p_network, p_creator_net_atomic, p_settlement_id,
     'creator accrual')
  on conflict do nothing;
end;
$$;

-- platform_fee_bps for the policy version pinned on the settlement row —
-- never a bare integer on the post (gate 11).
create or replace function app.policy_bps(p_version text, p_actor uuid default null)
returns integer
language plpgsql stable
set search_path = public, pg_temp
as $$
declare v_bps integer;
begin
  perform app.enter('musebook_kernel', p_actor);
  select platform_fee_bps into v_bps
    from public.revenue_share_policies where version = p_version;
  return v_bps;
end;
$$;

-- The legs poster's read: one statement returning everything
-- post_settlement_legs needs that settleOnce's outcome does not carry.
create or replace function app.settlement_for_legs(p_id uuid, p_actor uuid default null)
returns table (
  amount_atomic numeric, payer text, asset text, network text,
  revenue_share_version text, creator_user_id uuid, creator_address text
)
language plpgsql stable
set search_path = public, pg_temp
as $$
begin
  perform app.enter('musebook_kernel', p_actor);
  return query
    select s.amount_atomic, s.payer, s.asset, s.network, s.revenue_share_version,
           p.author_user_id, w.address
      from public.x402_settlements s
      join public.posts p on p.id = s.post_id
      left join public.wallets w
        on w.user_id = p.author_user_id and w.is_primary
     where s.id = p_id;
end;
$$;

-- ── the reconciler's sweep set (§6.8): pending rows older than p_seconds, ──
-- bounded; the worker re-/settle's each idempotently on the same nonce.
create or replace function app.list_stale_settlements(
  p_seconds integer,
  p_limit   integer default 200,
  p_actor   uuid default null
)
returns table (
  id uuid, quote_id uuid, post_id uuid, content_hash text, network text,
  asset text, payer text, nonce text, amount_atomic numeric, pay_to text,
  facilitator_url text, verify_response jsonb, revenue_share_version text,
  payment_payload jsonb, created_at timestamptz
)
language plpgsql stable
set search_path = public, pg_temp
as $$
begin
  perform app.enter('musebook_kernel', p_actor);
  return query
    select s.id, s.quote_id, s.post_id, s.content_hash, s.network, s.asset,
           s.payer, s.nonce, s.amount_atomic, s.pay_to, s.facilitator_url,
           s.verify_response, s.revenue_share_version, s.payment_payload,
           s.created_at
      from public.x402_settlements s
     where s.status = 'pending'
       and s.created_at < now() - make_interval(secs => p_seconds)
     order by s.created_at
     limit p_limit;
end;
$$;

-- The >10-minute-stuck alert input (§6.8): oldest pending row age.
create or replace function app.oldest_pending_settlement_age_s(p_actor uuid default null)
returns double precision
language plpgsql stable
set search_path = public, pg_temp
as $$
declare v_age double precision;
begin
  perform app.enter('musebook_kernel', p_actor);
  select extract(epoch from now() - min(created_at)) into v_age
    from public.x402_settlements where status = 'pending';
  return coalesce(v_age, 0);
end;
$$;

-- The Worker plane calls every one of these directly over Hyperdrive as
-- musebook_worker (NOINHERIT — role grants do not reach it). musebook_kernel is
-- also granted: after app.enter switches the role mid-statement, later EXECUTE
-- and table checks inside the same call bind to the new role.
grant execute on function app.find_quote_by_id(uuid, uuid) to musebook_worker, musebook_kernel;
grant execute on function app.find_live_quote(text, text, text, numeric, uuid) to musebook_worker, musebook_kernel;
grant execute on function app.insert_pending_settlement(
  uuid, uuid, text, text, text, text, text, numeric, text, text, jsonb, text, jsonb, uuid
) to musebook_worker, musebook_kernel;
grant execute on function app.find_settlement(text, text, text, text, uuid) to musebook_worker, musebook_kernel;
grant execute on function app.mark_settlement_settled(uuid, jsonb, uuid) to musebook_worker, musebook_kernel;
grant execute on function app.mark_settlement_failed(uuid, jsonb, text, uuid) to musebook_worker, musebook_kernel;
grant execute on function app.consume_quote(uuid, uuid) to musebook_worker, musebook_kernel;
grant execute on function app.post_settlement_legs(
  uuid, uuid, text, uuid, text, text, text, numeric, numeric, numeric, uuid
) to musebook_worker, musebook_kernel;
grant execute on function app.policy_bps(text, uuid) to musebook_worker, musebook_kernel;
grant execute on function app.settlement_for_legs(uuid, uuid) to musebook_worker, musebook_kernel;
grant execute on function app.list_stale_settlements(integer, integer, uuid) to musebook_worker, musebook_kernel;
grant execute on function app.oldest_pending_settlement_age_s(uuid) to musebook_worker, musebook_kernel;

-- Two app.* calls in one implicit transaction (or a plpgsql function that
-- reaches a second app.* after the role switch) re-execute app.enter under the
-- NEW role — grant it to all three planes so the second switch can proceed.
grant execute on function app.enter(text, uuid)
  to musebook_kernel, musebook_jobs, musebook_public_reader;

-- The settle flips and consume_quote UPDATE the money tables; the 91300
-- matrix only admitted kernel INSERTs. Same emission pattern, one narrow
-- block: UPDATE privilege + the matching _kernel_update policy.
grant update on public.x402_settlements, public.x402_quotes to musebook_kernel;
create policy x402_settlements_kernel_update on public.x402_settlements
  for update to musebook_kernel using (true) with check (true);
create policy x402_quotes_kernel_update on public.x402_quotes
  for update to musebook_kernel using (true) with check (true);
