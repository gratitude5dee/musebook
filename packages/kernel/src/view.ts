// packages/kernel/src/view.ts — legal here, illegal anywhere else.
// §14.1 is canonical for the body; the two types are re-exported from schema,
// never redefined here.
import type { AccessBadgeView, Resource } from "@musebook/schema";

export type { AccessBadgeKind, AccessBadgeView } from "@musebook/schema";

export function toAccessBadge(resource: Resource): AccessBadgeView {
  // resource.priceUsd is §6.2's DERIVED projection: computed once in loadResource()
  // by formatPriceUsd(priceAtomic, decimals) (§6.3), a two-place decimal string,
  // null when priceAtomic is "0". The badge reads it and never re-derives it.
  switch (resource.publishMode) {
    case "free":
      return { kind: "open", rule: "Free for everyone, human and machine." };
    case "human_free_agent_paid":
      return {
        kind: "toll",
        priceUsd: resource.priceUsd ?? "0.00",
        rule: "Free for people. Agents pay once to crawl it.",
      };
    case "x402_always":
      return {
        kind: "gated",
        priceUsd: resource.priceUsd ?? "0.00",
        rule: "Every read is paid, human or agent.",
      };
  }
}
