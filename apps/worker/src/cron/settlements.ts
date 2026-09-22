// apps/worker/src/cron/settlements.ts — §6.8's reconciler on `* * * * *`,
// sharing the outbox sweep's slot. Re-/settle every `pending` row older than
// 90 s — idempotent on the facilitator's side because the nonce is the same —
// then flip and post legs. A row stuck > 10 min emits x402.settlement_stuck.
// Cron, never a queue (CF-SPINE §3); all reads/writes on HYPERDRIVE_FRESH.
import {
  FacilitatorClient,
  makeCdpAuthHeaders,
  postLegsForSettlement,
  X402_ASSETS,
} from "@musebook/x402";
import type { PaymentPayload, PaymentRequirements } from "@musebook/schema";
import { pgFresh, type DbClient } from "../db.js";

const STALE_SECONDS = 90;
const STUCK_SECONDS = 600;
const SWEEP_LIMIT = 200; // §6.8: the partial index is near-empty by design
const BATCH = 5; // sequential batches of 5 — under the 6-connection cap

interface StaleRow {
  id: string;
  quote_id: string | null;
  network: string;
  asset: string;
  amount_atomic: string;
  pay_to: string;
  facilitator_url: string;
  payment_payload: PaymentPayload | null;
}

function requirementsFor(row: StaleRow): PaymentRequirements {
  const cfg = X402_ASSETS[row.network];
  if (cfg === undefined) throw new Error(`no asset config for ${row.network}`);
  return {
    scheme: "exact",
    network: row.network,
    amount: row.amount_atomic,
    asset: cfg.asset,
    payTo: row.pay_to,
    maxTimeoutSeconds: 60,
    extra: { name: cfg.name, version: cfg.version, quoteId: row.quote_id ?? "" },
  };
}

async function resend(env: Env, db: DbClient, row: StaleRow): Promise<void> {
  // A row without its stored payload or facilitator URL can never be resent;
  // leave it pending for the stuck-settlement alert rather than throw.
  if (
    row.payment_payload === null ||
    typeof row.facilitator_url !== "string" ||
    row.facilitator_url === ""
  )
    return;
  let r;
  try {
    // Construction also lives inside the retry guard: the client refuses a
    // public-facilitator + mainnet pair, and a row holding one is equally
    // indeterminate — the next sweep retries rather than killing the cron.
    const fac = new FacilitatorClient({
      url: row.facilitator_url,
      network: row.network,
      timeoutMs: 8_000,
      ...(env.CDP_API_KEY_ID !== undefined && env.CDP_API_KEY_SECRET !== undefined
        ? { authHeaders: makeCdpAuthHeaders(env.CDP_API_KEY_ID, env.CDP_API_KEY_SECRET) }
        : {}),
    });
    r = await fac.settle(row.payment_payload, requirementsFor(row));
  } catch {
    return; // indeterminate again — the next minute retries the same nonce
  }
  if (r.success) {
    await db.query("select app.mark_settlement_settled($1::uuid, $2::jsonb)", [row.id, r]);
    await postLegsForSettlement(db, row.id);
  } else {
    await db.query("select app.mark_settlement_failed($1::uuid, $2::jsonb, $3)", [
      row.id,
      r,
      r.errorReason ?? "settle_failed",
    ]);
  }
}

export async function reconcileSettlements(env: Env): Promise<void> {
  const db = await pgFresh(env);
  try {
    const { rows } = await db.query(
      "select id, quote_id, network, asset, amount_atomic, pay_to, facilitator_url, payment_payload " +
        "from app.list_stale_settlements($1, $2)",
      [STALE_SECONDS, SWEEP_LIMIT],
    );
    for (let i = 0; i < rows.length; i += BATCH) {
      await Promise.all(
        rows.slice(i, i + BATCH).map((r) => resend(env, db, r as unknown as StaleRow)),
      );
    }
    const { rows: age } = await db.query(
      "select coalesce(app.oldest_pending_settlement_age_s(), 0) as age",
    );
    if (Number((age[0] as { age: number }).age) > STUCK_SECONDS) {
      // §15's alert evaluator reads this Analytics Engine datapoint at M15.
      console.warn(
        JSON.stringify({
          metric: "x402.settlement_stuck",
          oldest_s: (age[0] as { age: number }).age,
        }),
      );
    }
  } finally {
    await db.end();
  }
}
