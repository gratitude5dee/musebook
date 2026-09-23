// packages/connectors/src/adapters/a2a-card.ts — §10.5.2
// The card is a pure read; the v0.3.0 task JSON was unread during research, so
// draftPost is ABSENT — auto-check 7 and resolveAdapter refuse a post.draft
// manifest on this transport, and a connector that drafts adds mcp_http,
// http_openapi or bridge_token.
import { z } from "zod";
import type {
  AgentConnector,
  ConnectorContext,
  HandshakeRequest,
  HandshakeResult,
  HealthResult,
} from "../connector.js";
import type { AdapterInit } from "./index.js";

export const AgentCardZ = z
  .object({
    name: z.string().max(120),
    description: z.string().max(2000).optional(),
    url: z.url({ protocol: /^https$/ }),
    version: z.string().max(32).optional(),
    provider: z
      .object({ organization: z.string().max(120).optional() })
      .loose()
      .optional(),
    capabilities: z.record(z.string(), z.unknown()).optional(),
    skills: z
      .array(z.object({ id: z.string(), name: z.string() }).loose())
      .max(200)
      .optional(),
  })
  .loose();

export type AgentCard = z.infer<typeof AgentCardZ>;

function cardUrlOf(init: AdapterInit): string {
  const t = init.transport;
  if (t.kind !== "a2a_card") throw new Error(`a2a_adapter_wrong_transport:${t.kind}`);
  return t.agentCardUrl;
}

export function makeA2aConnector(init: AdapterInit): AgentConnector {
  const cardUrl = cardUrlOf(init);

  const fetchCard = async (ctx: ConnectorContext): Promise<AgentCard> => {
    const res = await ctx.fetch(cardUrl, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: ctx.signal,
    });
    if (!res.ok) throw new Error(`a2a_card_${res.status}`);
    const parsed = AgentCardZ.safeParse(await res.json());
    if (!parsed.success) throw new Error("a2a_card_invalid");
    return parsed.data;
  };

  return {
    manifest: init.manifest,
    connectorRowId: init.connectorRowId,
    transport: "a2a_card",

    async handshake(ctx, req: HandshakeRequest): Promise<HandshakeResult> {
      const card = await fetchCard(ctx);
      // §10.5.2: map the card's skills[] to granted/declined capabilities. A
      // skill grants a requested capability when its id or name names it.
      const skills = (card.skills ?? []).flatMap((s) =>
        [s.id, s.name].filter((x): x is string => typeof x === "string"),
      );
      const grants = req.requestedCapabilities.filter((cap) =>
        skills.some((s) => s === cap || s.replaceAll("_", ".").replaceAll("-", ".") === cap),
      );
      const declined = req.requestedCapabilities
        .filter((c) => !grants.includes(c))
        .map((capability) => ({ capability, reason: "a2a_card_not_advertised" }));
      await ctx.audit("connector.handshake", {
        transport: "a2a_card",
        card_name: card.name,
        granted: grants as unknown as string[],
        declined: declined.map((d) => d.capability) as unknown as string[],
      });
      return {
        ok: true,
        agentInstanceId: `${init.manifest.connectorId}:${ctx.delegationId.slice(0, 8)}`,
        agentDisplayName: card.name,
        grantedCapabilities: grants,
        declined,
        remoteProtocolVersion: card.version ?? "0.3.0",
      };
    },

    async health(ctx): Promise<HealthResult> {
      const started = Date.now();
      try {
        const card = await fetchCard(ctx);
        return { ok: true, latencyMs: Date.now() - started, detail: card.name };
      } catch (e) {
        return {
          ok: false,
          latencyMs: Date.now() - started,
          detail: e instanceof Error ? e.message.slice(0, 120) : "unknown",
        };
      }
    },

    // No draftPost: the v0.3.0 task JSON is UNVERIFIED (10.5.2). resolveAdapter
    // refuses this adapter for a post.draft manifest before it is ever called.

    async revoke(): Promise<void> {
      // Nothing to cancel: there is no session and no task on this transport.
    },
  };
}
