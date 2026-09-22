import { describe, expect, it, vi } from "vitest";
import { splitRevenue } from "../src/ledger.js";
import { postLegsForSettlement, type SqlClient } from "../src/legs.js";

describe("splitRevenue", () => {
  it("floor-divides the fee so rounding favours the creator", () => {
    const s = splitRevenue("3333", 1000);
    expect(s.platformFeeAtomic).toBe(333n); // 3333*0.10 = 333.3 → 333
    expect(s.creatorNetAtomic).toBe(3000n);
    expect(s.grossAtomic).toBe(3333n);
  });

  it("1000 bps on a quarter-USDC price", () => {
    const s = splitRevenue("250000", 1000);
    expect(s.platformFeeAtomic).toBe(25000n);
    expect(s.creatorNetAtomic).toBe(225000n);
  });

  it("zero bps pays the creator everything", () => {
    const s = splitRevenue("999999", 0);
    expect(s.platformFeeAtomic).toBe(0n);
    expect(s.creatorNetAtomic).toBe(999999n);
  });
});

describe("postLegsForSettlement", () => {
  const sql = (
    impl: (q: string, p?: readonly unknown[]) => Record<string, unknown>[],
  ): SqlClient => ({
    query: vi.fn(async (q: string, p?: readonly unknown[]) => ({ rows: impl(q, p) })),
  });

  it("no settlement row → returns without writing", async () => {
    const db = sql(() => []);
    await postLegsForSettlement(db, "s-1");
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it("reads the settlement, the policy bps, then posts the three legs", async () => {
    const calls: { q: string; p: readonly unknown[] | undefined }[] = [];
    const db: SqlClient = {
      query: vi.fn(async (q: string, p?: readonly unknown[]) => {
        calls.push({ q, p });
        if (q.includes("settlement_for_legs")) {
          return {
            rows: [
              {
                amount_atomic: "250000",
                payer: "0xabc",
                asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
                network: "eip155:8453",
                revenue_share_version: "rs_2026_09_v1",
                creator_user_id: "u-1",
                creator_address: "0xcdef",
              },
            ],
          };
        }
        if (q.includes("policy_bps")) return { rows: [{ policy_bps: 1000 }] };
        return { rows: [] };
      }),
    };
    await postLegsForSettlement(db, "s-7");
    expect(calls).toHaveLength(3);
    expect(calls[2]?.p).toEqual([
      "s-7",
      "s-7", // ledger_tx_id == settlement id: a retried post writes the same tx
      "0xabc",
      "u-1",
      "0xcdef",
      "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "eip155:8453",
      "250000",
      "25000",
      "225000",
      null,
    ]);
  });
});
