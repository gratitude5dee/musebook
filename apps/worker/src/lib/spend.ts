// apps/worker/src/lib/spend.ts — §10.7.3 verbatim, adapted to the pgFresh
// helper. HYPERDRIVE_FRESH never HYPERDRIVE_CACHED; ONE statement, never an
// explicit BEGIN/COMMIT (Hyperdrive pools in transaction mode and a held
// transaction pins a pooled connection, §4.13); db.end() returns the
// connection immediately.
import { pgFresh } from "../db.js";

export interface ReserveArgs {
  delegationId: string;
  estimateAtomic: bigint;
  purpose: "media.generate" | "connector.call" | "distribution.publish" | "wallet.spend";
  idempotencyKey: string;
  externalKind?: string;
  externalRef?: string;
}

export type ReserveResult =
  { ok: true; reservationId: string; remainingAtomic: bigint } | { ok: false; reason: string };

export async function reserveSpend(env: Env, args: ReserveArgs): Promise<ReserveResult> {
  const db = await pgFresh(env);
  try {
    const { rows } = await db.query<{
      allowed: boolean;
      reason: string | null;
      reservation_id: string | null;
      remaining_atomic: string | null;
    }>(
      `select app.enter('musebook_jobs'),
              r.allowed, r.reason, r.reservation_id, r.remaining_atomic
         from public.reserve_agent_spend($1::uuid, $2::numeric, $3::text, $4::text,
                                         $5::text, $6::text) r`,
      [
        args.delegationId,
        args.estimateAtomic.toString(),
        args.purpose,
        args.idempotencyKey,
        args.externalKind ?? null,
        args.externalRef ?? null,
      ],
    );
    const row = rows[0];
    if (!row?.allowed || !row.reservation_id) {
      return { ok: false, reason: row?.reason ?? "reserve_failed" };
    }
    return {
      ok: true,
      reservationId: row.reservation_id,
      remainingAtomic: BigInt(row.remaining_atomic ?? "0"),
    };
  } finally {
    await db.end();
  }
}

export async function settleSpend(
  env: Env,
  reservationId: string,
  actualAtomic: bigint,
): Promise<void> {
  const db = await pgFresh(env);
  try {
    await db.query(
      `select app.enter('musebook_jobs'),
              r.settled, r.reason, r.committed_atomic
         from public.settle_agent_spend($1::uuid, $2::numeric) r`,
      [reservationId, actualAtomic.toString()],
    );
  } finally {
    await db.end();
  }
}

export async function releaseSpend(env: Env, reservationId: string, reason: string): Promise<void> {
  const db = await pgFresh(env);
  try {
    await db.query(
      `select app.enter('musebook_jobs'), public.release_agent_spend($1::uuid, $2::text)`,
      [reservationId, reason],
    );
  } finally {
    await db.end();
  }
}
