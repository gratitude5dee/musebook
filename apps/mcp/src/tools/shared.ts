// apps/mcp/src/tools/shared.ts — §7.4.2's in-band scope enforcement and the
// one place a kernel Rendered becomes a CallToolResult (§7.4.1 / §6.7.7).
import type { AccessDecision, Actor, Rendered, Resource, Scope } from "@musebook/schema";
import type { CallToolResult } from "@modelcontextprotocol/server";

export interface TextContent {
  type: "text";
  text: string;
}
export interface ResourceLinkContent {
  type: "resource_link";
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}
export type ToolContent = TextContent | ResourceLinkContent;

/** The SDK's own CallToolResult: isError + content + structuredContent +
 *  _meta envelope (§7.7.1). Tool files return this; registerTool's callback
 *  type accepts it (the union's other member is InputRequiredResult). */
export type ToolResult = CallToolResult;

/**
 * `actor` comes from resolveActorFromMcp, which has ALREADY re-read the
 * delegations row on HYPERDRIVE_FRESH (§5.8.1 checkGrant). actor.scopes is the
 * DATABASE's array — never props.scp, which is only a cache of it.
 */
export function requireScope(actor: Actor, scope: Scope): ToolResult | null {
  if (actor.class !== "owner_agent") {
    return errorResult(
      "unauthenticated",
      `This tool needs an OAuth 2.1 access token with the "${scope}" scope. ` +
        "Discover the authorization server at " +
        "https://mcp.musebook.dev/.well-known/oauth-protected-resource/mcp.",
    );
  }
  if (!actor.scopes.includes(scope)) {
    return errorResult(
      "insufficient_scope",
      `Missing scope "${scope}". Granted: ${actor.scopes.join(" ") || "(none)"}. ` +
        "The post owner grants scopes when they mint the delegation.",
    );
  }
  return null;
}

export function errorResult(code: string, message: string): ToolResult {
  const payload = { error: code, message };
  return {
    isError: true,
    structuredContent: payload,
    content: [{ type: "text", text: JSON.stringify(payload) }],
  };
}

export function notFound(what: string): ToolResult {
  return errorResult("not_found", `No such ${what}.`);
}

/** Rendered (as: 'mcp') → tool result. body and structured are two
 *  projections of one value (§6.7.7). A deny is isError:true with
 *  structuredContent = PaymentRequired (or a plain deny envelope) and
 *  content[0].text = JSON.stringify(structuredContent) — never any body bytes.
 *  A settle_failure shows up here as `!decision.allow`, which is why this file
 *  needs no separate payment branch. */
export function toolResultFrom(
  rendered: Rendered,
  decision: AccessDecision,
  resource: Resource,
): ToolResult {
  if (!decision.allow) {
    // For as:'mcp', rendered.structured IS the CallToolResult renderMcp built —
    // isError + content[0].text = JSON.stringify(structuredContent) +
    // structuredContent = PaymentRequired (§6.6). Passing it through keeps the
    // check-5 contract exact; wrapping it double-nests the 402 body.
    return {
      ...(rendered.structured as ToolResult),
      ...(rendered.mcpMeta !== null ? { _meta: rendered.mcpMeta } : {}),
    };
  }
  const structured = (rendered.structured ?? {}) as Record<string, unknown>;
  return {
    content: [{ type: "text", text: rendered.body }],
    structuredContent: {
      ...structured,
      content_hash: resource.contentHash,
      truncated: rendered.bodyKind !== "full",
      ...(decision.grantId !== null ? { grant: { grant_id: decision.grantId } } : {}),
    },
    ...(rendered.mcpMeta !== null ? { _meta: rendered.mcpMeta } : {}),
  };
}
