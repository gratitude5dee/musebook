// apps/worker/src/lib/approval.ts — §10.7.4 verbatim. Approval is earned, not
// permanent: the first five publishes and the first money move are always
// reviewed; reputation < 40 forces the queue.
const APPROVAL_BEARING = new Set([
  "post:publish",
  "comment:write",
  "channel:connect",
  "distribution:publish",
  "wallet:spend",
  "profile:write",
]);

export function needsApproval(input: {
  requiresApproval: boolean;
  cleanApprovals: number;
  reputation: number;
  scope: string;
  publishes: boolean;
  /** True iff the post is free to every reader — `access === 'open'`, the
   *  §7.4.1 vocabulary. The banned mode identifier never crosses this file. */
  isFree: boolean;
  estimateAtomic: bigint;
  hasEverSpent: boolean;
}): boolean {
  if (input.requiresApproval && APPROVAL_BEARING.has(input.scope)) return true;
  if (input.publishes && input.cleanApprovals < 5) return true;
  if (input.estimateAtomic > 0n && !input.hasEverSpent) return true;
  if (!input.isFree) return true;
  if (input.reputation < 40) return true;
  return false;
}
