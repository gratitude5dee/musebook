// packages/kernel/src/render/markdown.ts — the .md twin (§6.6).
import type { AccessDecision, Resource } from "@musebook/schema";
import { frontMatter } from "@musebook/content";
import { previewOf } from "./preview.js";

/** Atomic units -> exact decimal display, e.g. "2000" at 6 decimals -> "0.002000". */
function atomicDecimal(priceAtomic: string, decimals: number): string {
  const neg = priceAtomic.startsWith("-");
  const digits = (neg ? priceAtomic.slice(1) : priceAtomic).padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals) || "0";
  return `${neg ? "-" : ""}${whole}.${digits.slice(digits.length - decimals)}`;
}

export function renderMarkdown(
  resource: Resource,
  decision: AccessDecision,
  origin: string,
  previewChars: number,
): string {
  if (decision.bodyKind === "empty") return "";

  const fm = frontMatter(resource);
  if (decision.bodyKind === "full") {
    return fm + resource.canonicalMarkdown;
  }

  // preview: front matter + teaser blocks + sentinel + the pay line (§17.4).
  const price = atomicDecimal(resource.priceAtomic, 6);
  const network = resource.priceNetwork ?? "eip155:8453";
  const teaser = previewOf(resource.canonicalMarkdown, previewChars);
  const payLine =
    resource.publishMode === "human_free_agent_paid"
      ? `> This post is available to agents for ${price} USDC on ${network}.`
      : `> This post is available via x402 for ${price} USDC on ${network} per fetch.`;
  return (
    fm +
    teaser +
    `\n${payLine}\n` +
    `> Retry with a PAYMENT-SIGNATURE header. See ${origin}/llms.txt`
  );
}
