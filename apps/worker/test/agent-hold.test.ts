// apps/worker/test/agent-hold.test.ts — §16.5 M9 item 7: the two-phase hold
// is real. A 'held' reservation past its window is released by the sweeper
// and the delegation's cap is restored; a settled reservation never settles
// twice; a released reservation can never settle at all.
import { beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { resetSeed } from "./helpers/db.js";

const DELEGATION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-000000000002";
const WORKER_DB_URL = "postgres://musebook_worker:postgres@127.0.0.1:54322/postgres";
const ADMIN_DB_URL = "postgres://postgres:postgres@127.0.0.1:54322/postgres";

async function withWorkerDb<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: WORKER_DB_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function withAdminDb<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: ADMIN_DB_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function currentSpend(): Promise<bigint> {
  return withAdminDb(async (c) => {
    const { rows } = await c.query<{ spent: string }>(
      `select coalesce(sum(spent_atomic),0)::text as spent
         from public.delegation_spend where delegation_id = $1`,
      [DELEGATION_ID],
    );
    return BigInt(rows[0].spent);
  });
}

async function reserve(key: string) {
  return await withWorkerDb(async (c) => {
    const { rows } = await c.query<{
      allowed: boolean;
      reason: string;
      reservation_id: string;
      remaining_atomic: string;
    }>(
      `select * from public.reserve_agent_spend(
         $1::uuid, 400000::numeric, 'connector.call', $2)`,
      [DELEGATION_ID, key],
    );
    return rows[0];
  });
}

async function settle(reservationId: string) {
  return await withWorkerDb(async (c) => {
    const { rows } = await c.query<{ settled: boolean; reason: string }>(
      `select * from public.settle_agent_spend($1::uuid, 350000::numeric)`,
      [reservationId],
    );
    return rows[0];
  });
}

beforeAll(async () => {
  await resetSeed();
  // Prior runs leave their own holds; clear every non-settled reservation on
  // the fixture delegation so remaining_atomic arithmetic is deterministic.
  await withAdminDb((c) =>
    c.query(
      `update public.agent_spend_reservations
          set state = 'released', actual_atomic = 0, closed_at = now()
        where delegation_id = $1 and state = 'held'`,
      [DELEGATION_ID],
    ),
  );
  // Committed spend also accumulates across runs — reset it to the seeded zero
  // so the spend_cap arithmetic below is deterministic.
  await withAdminDb((c) =>
    c.query(`delete from public.delegation_spend where delegation_id = $1`, [DELEGATION_ID]),
  );
});

describe("M9.7 — the two-phase hold", () => {
  it("a stale hold is swept, the cap is restored, and settle never double-commits", async () => {
    const stamp = crypto.randomUUID().slice(0, 12);

    // 1. Reserve against the seed delegation (spend_cap_atomic = 1000000).
    const first = await reserve(`m9-hold-${stamp}-a`);
    expect(first.allowed).toBe(true);
    expect(first.reservation_id).toBeTruthy();
    const heldBefore = await withAdminDb(async (c) => {
      const { rows } = await c.query<{ held: string }>(
        `select coalesce(sum(estimate_atomic),0)::text as held
           from public.agent_spend_reservations
          where delegation_id = $1 and state = 'held'`,
        [DELEGATION_ID],
      );
      return BigInt(rows[0].held);
    });
    // cap minus committed spend minus everything currently held, incl. this.
    expect(BigInt(first.remaining_atomic)).toBeLessThanOrEqual(1000000n - heldBefore);

    // 2. Age the hold past its window, then sweep — the release path.
    await withAdminDb((c) =>
      c.query(
        `update public.agent_spend_reservations
            set created_at = now() - interval '7 hours' where id = $1`,
        [first.reservation_id],
      ),
    );
    const swept = await withWorkerDb(async (c) => {
      const { rows } = await c.query<{ sweep_stale_holds: number }>(
        `select app.sweep_stale_holds('1 second'::interval)`,
      );
      return rows[0].sweep_stale_holds;
    });
    expect(swept).toBe(1);
    const released = await withAdminDb(async (c) => {
      const { rows } = await c.query<{ state: string; actual_atomic: string }>(
        `select state, actual_atomic from public.agent_spend_reservations where id = $1`,
        [first.reservation_id],
      );
      return rows[0];
    });
    expect(released.state).toBe("released");
    expect(BigInt(released.actual_atomic)).toBe(0n);

    // 3. Cap restored: the released hold no longer counts — an identical
    // reserve reports the same remaining budget the first one did.
    const second = await reserve(`m9-hold-${stamp}-b`);
    expect(second.allowed).toBe(true);
    expect(second.remaining_atomic).toBe(first.remaining_atomic);

    // 4. A released reservation can never settle.
    const settleReleased = await settle(first.reservation_id);
    expect(settleReleased.settled).toBe(false);

    // 5. Settle once; a second settle reports 'reservation_settled' — idempotent
    // acknowledgement, never a second charge into delegation_spend.
    const before = await currentSpend();
    const settleOnce = await settle(second.reservation_id);
    expect(settleOnce.settled).toBe(true);
    expect((await currentSpend()) - before).toBe(350000n);
    const settleTwice = await settle(second.reservation_id);
    expect(settleTwice.settled).toBe(true);
    expect(settleTwice.reason).toBe("reservation_settled");
    expect((await currentSpend()) - before).toBe(350000n);
  });
});
