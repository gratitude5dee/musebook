// packages/x402/src/legs.ts — the §6.10 three-leg insert after a settle,
// shared by the edge PaymentPort and the worker reconciler (which cannot
// import apps/edge). One read (app.settlement_for_legs), one policy read, one
// write — every statement on the caller's HYPERDRIVE_FRESH client.
import { splitRevenue } from "./ledger";

/** The narrowest client shape both apps' DbClients already satisfy. */
export interface SqlClient {
  query(sql: string, params?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export async function postLegsForSettlement(fresh: SqlClient, settlementId: string): Promise<void> {
  const { rows } = await fresh.query("select * from app.settlement_for_legs($1::uuid)", [
    settlementId,
  ]);
  const s = rows[0] as
    | {
        amount_atomic: string;
        payer: string;
        asset: string;
        network: string;
        revenue_share_version: string;
        creator_user_id: string;
        creator_address: string | null;
      }
    | undefined;
  if (s === undefined) return;
  const { rows: bpsRows } = await fresh.query("select app.policy_bps($1) as policy_bps", [
    s.revenue_share_version,
  ]);
  const bps = (bpsRows[0]?.policy_bps as number | undefined) ?? 0;
  const split = splitRevenue(s.amount_atomic, bps);
  await fresh.query(
    `select app.post_settlement_legs(
       $1::uuid, $2::uuid, $3, $4::uuid, $5, $6, $7,
       $8::numeric, $9::numeric, $10::numeric, $11::uuid)`,
    [
      // ledger_tx_id == settlement_id: deterministic, so a retried post (e.g.
      // the reconciler's) writes the same tx rather than a second accrual.
      settlementId,
      settlementId,
      s.payer,
      s.creator_user_id,
      s.creator_address,
      s.asset,
      s.network,
      s.amount_atomic,
      split.platformFeeAtomic.toString(),
      split.creatorNetAtomic.toString(),
      null,
    ],
  );
}
