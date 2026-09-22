// packages/kernel/src/render/mcp.ts — the get_post tool result (§6.6).
import type { AccessDecision, Resource } from "@musebook/schema";
import { renderJson } from "./json";

export function renderMcp(
  resource: Resource,
  decision: AccessDecision,
  origin: string,
  previewChars: number,
): { result: Record<string, unknown>; meta: Record<string, unknown> } {
  const meta: Record<string, unknown> = {
    postId: resource.postId,
    slug: resource.slug,
    reason: decision.reason,
  };

  if (decision.bodyKind === "empty") {
    return {
      result: {
        isError: true,
        content: [{ type: "text", text: "Post not available." }],
      },
      meta,
    };
  }

  if (decision.bodyKind === "preview") {
    // structuredContent IS the PaymentRequired; content[0].text is its JSON.
    const structured = decision.challenge ?? { error: "payment_required" };
    return {
      result: {
        isError: true,
        content: [{ type: "text", text: JSON.stringify(structured) }],
        structuredContent: structured,
      },
      meta,
    };
  }

  const envelope = renderJson(resource, decision, origin, previewChars);
  return {
    result: {
      content: [{ type: "text", text: resource.canonicalMarkdown }],
      structuredContent: envelope,
    },
    meta,
  };
}
