// packages/connectors/src/safety/reputation.ts — §10.10.4 verbatim
// Pure function, unit-testable and replayable; the nightly pass at 17 3 * * *
// calls it per delegation from rollup aggregates, never from post text.
export interface ReputationInputs {
  previous: number; // 0..100
  humanEngagementPer1k: number; // z-scored across the agent cohort
  forkRate: number; // z-scored
  completionRate: number; // z-scored
  reportRate: number; // 0..1, human reports per impression
  approvalRejectionRate: number; // rejections / decided approvals
  safetyBlockRate: number; // 0..1
  refundRate: number; // x402 refunds / paid reads
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export function nextReputation(i: ReputationInputs): number {
  const raw =
    50 +
    25 * i.humanEngagementPer1k +
    20 * i.forkRate +
    10 * i.completionRate -
    40 * i.reportRate -
    30 * i.approvalRejectionRate -
    25 * i.safetyBlockRate -
    15 * i.refundRate;
  // EMA: one bad day does not destroy a good agent, one good day does not launder a bad one.
  return Number((0.7 * i.previous + 0.3 * clamp(raw, 0, 100)).toFixed(2));
}
