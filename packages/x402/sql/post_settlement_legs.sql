-- packages/x402/sql/post_settlement_legs.sql
-- $1 ledger_tx_id, $2 settlement_id, $3 payer, $4 creator_user_id, $5 creator_address,
-- $6 asset, $7 network, $8 gross_atomic, $9 platform_fee_atomic, $10 creator_net_atomic
-- The live form is app.post_settlement_legs (20260922091601).
insert into public.payout_ledger
  (ledger_tx_id, account_kind, account_user_id, account_address,
   asset, network, amount_atomic, settlement_id, memo)
values
  ($1, 'payer',    null, lower($3), $6, $7, -$8,  $2, 'x402 settlement'),
  ($1, 'platform', null, null,      $6, $7,  $9,  $2, 'platform fee'),
  ($1, 'creator',  $4,   lower($5), $6, $7,  $10, $2, 'creator accrual');
