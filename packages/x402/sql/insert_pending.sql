-- packages/x402/sql/insert_pending.sql — returns zero rows on a replay.
-- The live form is app.insert_pending_settlement (20260922091601), which wraps
-- this verbatim so the kernel plane is entered inside the statement.
insert into public.x402_settlements (
  quote_id, post_id, content_hash, network, asset, payer, nonce,
  amount_atomic, pay_to, facilitator_url, verify_response,
  revenue_share_version, status
) values (
  $1, $2, $3, $4, lower($5), lower($6), lower($7),
  $8, lower($9), $10, $11, $12, 'pending'
)
on conflict (network, asset, payer, nonce) do nothing
returning id;
