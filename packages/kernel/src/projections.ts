// packages/kernel/src/projections.ts — plan.md §6.3, verbatim.
import type { PublishMode, Resource } from "@musebook/schema";
import { getPorts } from "./registry";

/** §12.3.3 / CF-SPINE §13.3: variants are FULL PORTS, never teasers — paid or
 *  not, the syndicated copy carries the whole piece. The union is kept so the
 *  teaser path can return if the product decision reverses. */
export type VariantIntent = "full" | "teaser";

/** The distributor's stage-1 planner calls this; it never sees publish_mode.
 *  Throws on an unknown post — the distributor must not fan out a post it cannot load. */
export async function variantIntentFor(postId: string): Promise<VariantIntent> {
  const row = await getPorts().resources.loadRowByPostId(postId);
  if (row === null) throw new Error(`variantIntentFor: no live post ${postId}`);
  // CF-SPINE §13.3: a paid post is ported in full like any other. The paywall
  // lives on the canonical URL; the variant always links back to it.
  return "full";
}

/**
 * Inbound mapping for the composer (§14.4.9) and MCP `submit_post` (§7.4.1), whose
 * argument is named `access`, not `publish_mode`, so the callers stay lint-clean.
 * The three literals are the badge kinds of §14.1; the mapping is exhaustive.
 */
export type AccessChoice = "open" | "toll" | "gated";
export function accessToPublishMode(access: AccessChoice): PublishMode {
  switch (access) {
    case "open":
      return "free";
    case "toll":
      return "human_free_agent_paid";
    case "gated":
      return "x402_always";
  }
}

/**
 * The one-line price signal for llms.txt / llms-full.txt (§7.13) and the 402 body's
 * `error` string. Reads `priceUsd`, the derived projection — never re-derives it.
 */
export function pricingLineFor(resource: Resource): string {
  switch (resource.publishMode) {
    case "free":
      return "Free for humans and agents.";
    case "human_free_agent_paid":
      return `Free for humans. Agents: ${resource.priceUsd ?? "0.00"} USDC once per content_hash (x402, eip155:8453).`;
    case "x402_always":
      return `${resource.priceUsd ?? "0.00"} USDC per fetch, human or agent (x402, eip155:8453).`;
  }
}
