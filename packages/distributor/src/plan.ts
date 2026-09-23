// packages/distributor/src/plan.ts — §12.3.3 verbatim.
// The queue message — one shape, four stages. Every one of these is a few
// hundred bytes: bodies live in post_bodies, media in R2, variants in
// platform_variants. Nothing is ever inlined into a message.

/** platforms.slug values (section 4.12). [] means every connected channel of the author. */
export type PlanMessage = {
  readonly stage: "plan";
  readonly jobId: number;
  readonly postId: string;
  readonly postVersionId: string;
  readonly platforms: readonly string[];
  readonly source: "composer" | "agent_draft" | "approval" | "republish";
};

export type VariantMessage = {
  readonly stage: "variant";
  readonly postId: string;
  readonly postVersionId: string;
  readonly channelId: string;
  readonly platformSlug: string;
  /** distribution_jobs.id — the row this message owns. */
  readonly jobId: string;
};

export type SendMessage = {
  readonly stage: "send";
  readonly postId: string;
  readonly postVersionId: string;
  /** ISO-8601 publish instant; one send message per distinct bucket. */
  readonly scheduledFor: string;
};

export type ReconcileMessage = {
  readonly stage: "reconcile";
  readonly postizPostId: string;
};

export type DistributionMessage = PlanMessage | VariantMessage | SendMessage | ReconcileMessage;

// ---- Stage 1 planner inputs. The consumer resolves channels + stagger and
// emits one VariantMessage per channel plus one SendMessage per time bucket.

export interface PlanChannel {
  readonly id: string;
  readonly platform: string;
  readonly postizChannelId: string;
  readonly staggerSeconds: number;
  readonly concurrencyCeiling: number | null;
}

export interface PlanDecision {
  readonly variantMessages: readonly Omit<VariantMessage, "stage">[];
  readonly sendMessages: readonly Omit<SendMessage, "stage">[];
  /** channel_id -> scheduled_for ISO instant (bucket assignment). */
  readonly channelBuckets: Readonly<Record<string, string>>;
}

/**
 * Bucket channels by their platform's stagger_seconds (12.3.8 rule 2): one
 * SendMessage per distinct publish instant, delaySeconds applied at enqueue.
 * "Publish now" becomes now+60s so `type:"schedule"` always works (rule 1).
 */
export function planSendBuckets(
  channels: readonly PlanChannel[],
  now: Date,
): { readonly buckets: ReadonlyMap<number, readonly string[]> } {
  const buckets = new Map<number, string[]>();
  for (const ch of channels) {
    const offset = ch.staggerSeconds;
    const at = buckets.get(offset) ?? [];
    at.push(ch.id);
    buckets.set(offset, at);
  }
  return {
    buckets: new Map(
      [...buckets.entries()].map(([offset, ids]) => [
        new Date(now.getTime() + 60_000 + offset * 1000).getTime(),
        ids,
      ]),
    ),
  };
}
