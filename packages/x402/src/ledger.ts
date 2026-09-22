// packages/x402/src/ledger.ts — plan.md §6.10, verbatim.

export interface RevenueSplit {
  readonly grossAtomic: bigint;
  readonly platformFeeAtomic: bigint;
  readonly creatorNetAtomic: bigint;
}

/** Floor division on the fee, so rounding always favours the creator. */
export function splitRevenue(grossAtomic: string, platformFeeBps: number): RevenueSplit {
  const gross = BigInt(grossAtomic);
  const fee = (gross * BigInt(platformFeeBps)) / 10000n;
  return { grossAtomic: gross, platformFeeAtomic: fee, creatorNetAtomic: gross - fee };
}
