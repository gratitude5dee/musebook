// apps/mcp/src/auth/resolve-actor.ts — §5.6.1's ladder for the MCP surface:
// props → delegated owner_agent; else an anonymous crawler_agent carrying the
// x402 payment if the request presented one. Authorization and entitlement are
// orthogonal (§7.6): an anonymous agent with a wallet can buy and read; only a
// grant-bearing agent can write.
import { getMcpAuthContext } from "agents/mcp/server";
import type { Actor, PaymentPayload } from "@musebook/schema";
import type { ServerContext } from "@modelcontextprotocol/server";
import { checkGrant, type GrantProps } from "./props-to-actor.js";
import { currentMcpRequest } from "../request-context.js";
import { fresh, release } from "../db/client.js";

/** The signed EIP-3009 authorization's `from`, or null. Payer-provenance lives
 *  inside the payload; there is no shape check here — settleOnce verifies. */
function payerFromPayment(p: PaymentPayload | null): `0x${string}` | null {
  const from = (p?.payload as { authorization?: { from?: string } } | undefined)?.authorization
    ?.from;
  return typeof from === "string" && /^0x[0-9a-fA-F]{40}$/.test(from)
    ? (from as `0x${string}`)
    : null;
}

function evidenceFor(kind: "mcp_oauth_token" | "none"): Actor["evidence"] {
  return [
    {
      kind,
      detail:
        kind === "mcp_oauth_token"
          ? "workers-oauth-provider grant, delegation re-read"
          : "no OAuth grant",
      verifiedAt: new Date().toISOString(),
    },
  ];
}

/**
 * Reads `_meta["x402/payment"]` — the one place a payment payload enters the
 * Actor. The SDK exposes the unlifted `_meta` on `ctx.mcpReq` (§7.7.1's
 * UNVERIFIED resolves YES on this SDK); the AsyncLocalStorage copy is the
 * fallback for callers whose context is not a ServerContext.
 */
function paymentFrom(toolCtx: ServerContext | undefined): PaymentPayload | null {
  const meta = toolCtx?.mcpReq._meta ?? currentMcpRequest()?.meta;
  const p = meta?.["x402/payment"];
  return p && typeof p === "object" ? (p as PaymentPayload) : null;
}

export async function resolveActorFromMcp(
  toolCtx: ServerContext | undefined,
  env: Env,
  ctx: ExecutionContext,
): Promise<Actor> {
  const payment = paymentFrom(toolCtx);
  const payer = payerFromPayment(payment);
  const requestId = currentMcpRequest()?.requestId ?? crypto.randomUUID();

  const props = getMcpAuthContext()?.props as GrantProps | undefined;
  if (props?.dlg !== undefined && props.sub !== undefined) {
    const sql = fresh(env);
    try {
      const d = await checkGrant(sql, props);
      if (d !== null) {
        return {
          class: "owner_agent",
          plane: "agent",
          userId: d.owner_user_id,
          delegationId: d.delegation_id,
          agentIdentityId: d.agent_identity_id,
          connectorSlug: d.connector_slug,
          scopes: d.scopes,
          requiresApproval: d.requires_approval,
          walletAddress: payer,
          payerAddress: payer,
          payment,
          paymentTransport: payment === null ? null : "mcp",
          declaredIntent: "unknown",
          directoryKeyid: null,
          evidence: evidenceFor("mcp_oauth_token"),
          requestId,
        };
      }
      // Grant present but the row is gone/revoked: the caller is anonymous
      // for this call — NOT an owner_agent with zero scopes, which would let a
      // dead grant shadow a live payment.
    } finally {
      release(ctx, sql);
    }
  }

  return {
    class: "crawler_agent",
    plane: "agent",
    userId: null,
    agentIdentityId: null,
    signatureAgent: null,
    verification: "none",
    walletAddress: payer,
    payerAddress: payer,
    payment,
    paymentTransport: payment === null ? null : "mcp",
    declaredIntent: "unknown",
    directoryKeyid: null,
    scopes: [],
    evidence: evidenceFor("none"),
    requestId,
  };
}
