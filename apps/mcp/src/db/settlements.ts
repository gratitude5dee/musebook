// apps/edge/src/db/settlements.ts — the SettlementStore settleOnce drives
// (§6.8). Every statement is a single app.* call on HYPERDRIVE_FRESH; the
// kernel plane is entered inside each function (D23), never via a session SET.
import type { Quote } from "@musebook/x402";
import type { SettlementStore } from "@musebook/x402";
import type { SettleResponse } from "@musebook/schema";
import type { DbClient } from "./client.js";

interface QuoteRow {
  id: string;
  content_hash: string;
  network: string;
  asset: string;
  pay_to: string;
  amount_atomic: string;
  max_timeout_seconds: number;
  rate_source: "direct_usdc" | "oracle";
  expires_at: string;
  consumed_at: string | null;
}

const toQuote = (r: QuoteRow): Quote | null =>
  r.consumed_at !== null
    ? null
    : {
        id: r.id,
        contentHash: r.content_hash,
        network: r.network,
        asset: r.asset,
        payTo: r.pay_to,
        amountAtomic: r.amount_atomic,
        maxTimeoutSeconds: r.max_timeout_seconds,
        rateSource: r.rate_source,
        expiresAt: new Date(r.expires_at),
      };

export function makeSettlementStore(fresh: DbClient): SettlementStore {
  return {
    async findQuoteById(id) {
      const { rows } = await fresh.query<QuoteRow>("select * from app.find_quote_by_id($1::uuid)", [
        id,
      ]);
      return rows[0] === undefined ? null : toQuote(rows[0]);
    },

    async findLiveQuote(q) {
      const { rows } = await fresh.query<QuoteRow>(
        "select * from app.find_live_quote($1, $2, $3, $4::numeric)",
        [q.contentHash, q.network, q.asset, q.amountAtomic],
      );
      return rows[0] === undefined ? null : toQuote(rows[0]);
    },

    async insertPending(row) {
      const { rows } = await fresh.query<{ id: string | null }>(
        `select app.insert_pending_settlement(
           $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::numeric, $9, $10,
           $11::jsonb, $12, $13::jsonb) as id`,
        [
          // ::jsonb params pass the raw object — each driver JSON-encodes it
          // itself; a JSON.stringify'ed string lands as a jsonb *scalar*
          // under postgres.js (the gate tier's pg shim). slate-builder.ts:32
          // documents the same constraint.
          row.quoteId,
          row.postId,
          row.contentHash,
          row.network,
          row.asset,
          row.payer,
          row.nonce,
          row.amountAtomic,
          row.payTo,
          row.facilitatorUrl,
          row.verifyResponse,
          row.revenueShareVersion,
          row.paymentPayload,
        ],
      );
      const id = rows[0]?.id;
      return id == null ? null : { id };
    },

    async findExisting(k) {
      const { rows } = await fresh.query<{
        id: string;
        content_hash: string;
        status: "pending" | "settled" | "failed" | "refunded";
        settled_at: string | null;
        settle_response: SettleResponse | null;
      }>("select * from app.find_settlement($1, $2, $3, $4)", [
        k.network,
        k.asset,
        k.payer,
        k.nonce,
      ]);
      const r = rows[0];
      if (r === undefined) return null;
      return {
        id: r.id,
        contentHash: r.content_hash,
        status: r.status,
        settledAt: r.settled_at,
        settleResponse: r.settle_response,
      };
    },

    async markSettled(id, r) {
      await fresh.query("select app.mark_settlement_settled($1::uuid, $2::jsonb)", [id, r]);
    },

    async markFailed(id, r, errorReason) {
      await fresh.query("select app.mark_settlement_failed($1::uuid, $2::jsonb, $3)", [
        id,
        r,
        errorReason,
      ]);
    },

    async consumeQuote(id) {
      await fresh.query("select app.consume_quote($1::uuid)", [id]);
    },
  };
}
