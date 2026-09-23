// packages/connectors/src/adapters/mcp-http.ts — §10.5.1 verbatim
// Musebook is the CLIENT here. Revision 2026-07-28 is stateless: no initialize,
// no Mcp-Session-Id, no HTTP GET endpoint, no SSE resumability. A request is one POST.
import { z } from "zod";
import type {
  AgentConnector,
  ConnectorContext,
  DraftOutcome,
  DraftResult,
  HandshakeRequest,
  HandshakeResult,
  HealthResult,
} from "../connector.js";
import type { AdapterInit } from "./index.js";

const MCP_REVISION = "2026-07-28";

type JsonRpcId = string;

interface McpRequestMeta {
  "io.modelcontextprotocol/protocolVersion": string;
  "io.modelcontextprotocol/clientCapabilities": Record<string, unknown>;
  [k: string]: unknown;
}

export interface McpCallResult {
  resultType: string; // 'complete' | 'input_required' | string
  content?: { type: string; text?: string }[];
  structuredContent?: unknown;
  isError?: boolean;
  inputRequests?: unknown[];
  requestState?: unknown;
}

export async function mcpCall(
  ctx: ConnectorContext,
  endpoint: string,
  credential: string | null,
  method: string,
  params: Record<string, unknown>,
): Promise<McpCallResult> {
  const id: JsonRpcId = `mb-${ctx.requestId}`;
  // _meta is NON-OPTIONAL on requests in 2026-07-28. It stays optional on
  // notifications and results — do not add it there.
  const _meta: McpRequestMeta = {
    "io.modelcontextprotocol/protocolVersion": MCP_REVISION,
    "io.modelcontextprotocol/clientCapabilities": {},
  };
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": MCP_REVISION,
    "mcp-method": method,
  };
  if (method === "tools/call" && typeof params.name === "string") {
    headers["mcp-name"] = params.name;
  }
  if (credential) headers.authorization = `Bearer ${credential}`;

  // ctx.fetch is guardedFetch: allowlisted, HTTPS-only, non-redirecting, and
  // RFC 9421-signed with Musebook's own Ed25519 key (10.8.2, 10.8.4).
  const res = await ctx.fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params: { ...params, _meta } }),
    signal: ctx.signal,
  });
  if (!res.ok) throw new Error(`mcp_http_${res.status}`);

  const body = (await res.json()) as {
    result?: McpCallResult;
    error?: { code?: number; message: string };
  };
  if (body.error) throw new Error(`mcp_rpc_error:${body.error.code ?? ""}:${body.error.message}`);
  // Absent resultType means an earlier-protocol server; treat as 'complete'.
  const result = body.result ?? { resultType: "complete" };
  return { ...result, resultType: result.resultType ?? "complete" };
}

export async function discover(ctx: ConnectorContext, endpoint: string, cred: string | null) {
  try {
    return await mcpCall(ctx, endpoint, cred, "server/discover", {});
  } catch (e) {
    if (!(e instanceof Error) || !e.message.includes("-32601")) throw e;
    return await mcpCall(ctx, endpoint, cred, "tools/list", {});
  }
}

// ---- connector wrapper ------------------------------------------------------

const DraftResultZ = z.object({
  text: z.string().max(100_000),
  hashtags: z.array(z.string().max(64)).max(30).default([]),
  modelUsed: z.string().max(80).optional(),
  costAtomic: z.union([z.string().regex(/^[0-9]{1,30}$/), z.number().int().nonnegative()]),
  remoteTraceId: z.string().max(120).optional(),
});

function endpointOf(init: AdapterInit): string {
  const t = init.transport;
  if (t.kind !== "mcp_http") throw new Error(`mcp_http_adapter_wrong_transport:${t.kind}`);
  return t.url;
}

function declinedAll(req: HandshakeRequest, reason: string): HandshakeResult["declined"] {
  return req.requestedCapabilities.map((capability) => ({ capability, reason }));
}

export function makeMcpHttpConnector(init: AdapterInit): AgentConnector {
  const url = endpointOf(init);
  const cred = init.credential;

  return {
    manifest: init.manifest,
    connectorRowId: init.connectorRowId,
    transport: "mcp_http",

    async handshake(ctx, req: HandshakeRequest): Promise<HandshakeResult> {
      // §10.4.4's review-time check already fetched the PRM; the runtime
      // handshake is one `server/discover` call.
      const discovered = await discover(ctx, url, cred);
      if (discovered.resultType === "input_required") {
        // MRTR declined, explicitly (10.5.1): the _meta is logged, never the
        // request text.
        await ctx.audit("connector.input_required_declined", {
          transport: "mcp_http",
        });
        return {
          ok: false,
          agentInstanceId: "",
          agentDisplayName: init.manifest.displayName,
          grantedCapabilities: [],
          declined: declinedAll(req, "input_required_declined"),
        };
      }
      const sc = (discovered.structuredContent ?? {}) as Record<string, unknown>;
      const tools = Array.isArray(sc.tools) ? (sc.tools as { name?: string }[]) : [];
      const canDraft = tools.some((t) => typeof t.name === "string" && /draft/i.test(t.name));
      const granted = req.requestedCapabilities.filter((c) => c !== "post.draft" || canDraft);
      const declined = req.requestedCapabilities
        .filter((c) => !granted.includes(c))
        .map((capability) => ({ capability, reason: "not_advertised" }));
      return {
        ok: true,
        agentInstanceId:
          typeof sc.agentInstanceId === "string"
            ? sc.agentInstanceId
            : `${init.manifest.connectorId}:${ctx.delegationId.slice(0, 8)}`,
        agentDisplayName:
          typeof sc.agentDisplayName === "string" ? sc.agentDisplayName : init.manifest.displayName,
        grantedCapabilities: granted,
        declined,
        remoteProtocolVersion:
          typeof sc.protocolVersion === "string" ? sc.protocolVersion : MCP_REVISION,
      };
    },

    async health(ctx): Promise<HealthResult> {
      const started = Date.now();
      try {
        const res = await ctx.fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": MCP_REVISION,
            "mcp-method": "server/ping",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: `mb-${ctx.requestId}`,
            method: "server/ping",
            params: {},
          }),
          signal: ctx.signal,
        });
        return { ok: res.ok, latencyMs: Date.now() - started };
      } catch (e) {
        return {
          ok: false,
          latencyMs: Date.now() - started,
          detail: e instanceof Error ? e.message.slice(0, 120) : "unknown",
        };
      }
    },

    async draftPost(ctx, req): Promise<DraftOutcome> {
      const res = await mcpCall(ctx, url, cred, "tools/call", {
        name: "draft_post",
        arguments: {
          intent: req.intent,
          targetPlatforms: req.targetPlatforms,
          maxLengthChars: req.maxLengthChars,
          tone: req.tone,
          referenceUrls: req.referenceUrls,
          taskId: req.taskId,
        },
      });
      if (res.isError) throw new Error("mcp_tool_error");
      if (res.resultType === "input_required") {
        await ctx.audit("connector.input_required_declined", {
          transport: "mcp_http",
        });
        throw new Error("input_required_declined");
      }
      const parsed = DraftResultZ.safeParse(res.structuredContent);
      if (!parsed.success) throw new Error("mcp_draft_invalid");
      const d = parsed.data;
      const draft: DraftResult = {
        text: d.text,
        hashtags: d.hashtags,
        modelUsed: d.modelUsed,
        costAtomic: BigInt(d.costAtomic),
        remoteTraceId: d.remoteTraceId,
      };
      return { kind: "complete", draft };
    },

    async revoke(ctx): Promise<void> {
      // Best-effort remote logout/forget verb; a failure here is retried by the
      // queue, and settle on a cancelled reservation is a no-op either way.
      try {
        await mcpCall(ctx, url, cred, "musebook/revoke", {
          delegationId: ctx.delegationId,
        });
      } catch (e) {
        if (e instanceof Error && e.message.includes("-32601")) return; // not implemented
        throw e;
      }
    },
  };
}
