// packages/connectors/src/adapters/http-openapi.ts — §10.5.3
// The escape hatch: baseUrl + four fixed paths. openapiUrl is fetched at review
// time for documentation and is NEVER used to generate a client.
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
import type { Capability } from "../capabilities.js";

const HandshakeResultZ = z.object({
  ok: z.boolean(),
  agentInstanceId: z.string().max(200),
  agentDisplayName: z.string().max(120),
  agentAvatarUrl: z.url().optional(),
  grantedCapabilities: z.array(z.string()).default([]),
  declined: z
    .array(z.object({ capability: z.string(), reason: z.string().max(400) }))
    .default([]),
  remoteProtocolVersion: z.string().max(32).optional(),
  models: z.array(z.string().max(80)).max(40).optional(),
});

const HealthResultZ = z.object({
  ok: z.boolean(),
  latencyMs: z.number().nonnegative().optional(),
  detail: z.string().max(400).optional(),
});

const DraftResultZ = z.object({
  text: z.string().max(100_000),
  hashtags: z.array(z.string().max(64)).max(30).default([]),
  modelUsed: z.string().max(80).optional(),
  costAtomic: z.union([z.string().regex(/^[0-9]{1,30}$/), z.number().int().nonnegative()]),
  remoteTraceId: z.string().max(120).optional(),
});

function baseUrlOf(init: AdapterInit): string {
  const t = init.transport;
  if (t.kind !== "http_openapi")
    throw new Error(`http_openapi_adapter_wrong_transport:${t.kind}`);
  return t.baseUrl.replace(/\/$/, "");
}

export function makeHttpOpenApiConnector(init: AdapterInit): AgentConnector {
  const base = baseUrlOf(init);

  const authHeader = (): Record<string, string> => {
    const a = init.manifest.auth;
    if (a.kind !== "bearer" || !init.credential) return {};
    return { [a.header]: `${a.valuePrefix}${init.credential}` };
  };

  const call = async (
    ctx: ConnectorContext,
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<unknown> => {
    const res = await ctx.fetch(`${base}${path}`, {
      method,
      headers: {
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...authHeader(),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: ctx.signal,
    });
    if (method === "POST" && res.status === 204) return null;
    if (!res.ok) throw new Error(`http_openapi_${res.status}`);
    return res.json();
  };

  return {
    manifest: init.manifest,
    connectorRowId: init.connectorRowId,
    transport: "http_openapi",

    async handshake(ctx, req: HandshakeRequest): Promise<HandshakeResult> {
      const raw = await call(ctx, "POST", "/musebook/handshake", req);
      const parsed = HandshakeResultZ.safeParse(raw);
      if (!parsed.success) throw new Error("http_openapi_handshake_invalid");
      const d = parsed.data;
      return {
        ok: d.ok,
        agentInstanceId: d.agentInstanceId,
        agentDisplayName: d.agentDisplayName,
        agentAvatarUrl: d.agentAvatarUrl,
        grantedCapabilities: d.grantedCapabilities as Capability[],
        declined: d.declined.map((x) => ({
          capability: x.capability as Capability,
          reason: x.reason,
        })),
        remoteProtocolVersion: d.remoteProtocolVersion,
        models: d.models,
      };
    },

    async health(ctx): Promise<HealthResult> {
      const started = Date.now();
      try {
        const raw = await call(ctx, "GET", "/musebook/health");
        const parsed = HealthResultZ.safeParse(raw);
        if (!parsed.success) throw new Error("http_openapi_health_invalid");
        return {
          ok: parsed.data.ok,
          latencyMs: parsed.data.latencyMs ?? Date.now() - started,
          detail: parsed.data.detail,
        };
      } catch (e) {
        return {
          ok: false,
          latencyMs: Date.now() - started,
          detail: e instanceof Error ? e.message.slice(0, 120) : "unknown",
        };
      }
    },

    async draftPost(ctx, req): Promise<DraftOutcome> {
      const raw = await call(ctx, "POST", "/musebook/draft", req);
      const parsed = DraftResultZ.safeParse(raw);
      if (!parsed.success) throw new Error("http_openapi_draft_invalid");
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
      await call(ctx, "POST", "/musebook/revoke", {
        delegationId: ctx.delegationId,
        reason: "delegation_revoked",
      });
    },
  };
}
