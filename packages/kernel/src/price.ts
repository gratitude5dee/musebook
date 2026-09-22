// packages/kernel/src/price.ts — plan.md §6.3, verbatim.

/**
 * Atomic units (a decimal string; numeric(78,0)) -> a decimal USD string with exactly
 * two places, using BigInt throughout. "250000" with 6 decimals -> "0.25".
 * Rounds half-up on the third place so a $0.002 crawl displays as "0.00" — the
 * badge shows the rounded figure; the wire always carries the exact atomic amount.
 * v1 is USDC-only, so the caller passes X402_ASSETS[network].decimals (6).
 */
export function formatPriceUsd(priceAtomic: string, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const cents = (BigInt(priceAtomic) * 100n + scale / 2n) / scale;
  const whole = cents / 100n;
  const frac = (cents % 100n).toString().padStart(2, "0");
  return `${whole.toString()}.${frac}`;
}
