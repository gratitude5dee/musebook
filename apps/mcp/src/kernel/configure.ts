// apps/mcp/src/kernel/configure.ts — portsFor per tool call, never a module
// global (Hyperdrive clients may not cross requests, and the actor is
// resolved per call). The canonical site origin is always https://musebook.dev
// — the MCP host is a sibling, not a second site origin, and resource URLs in
// challenges point at the post page.
import type { KernelPorts, PolicyPort } from "@musebook/kernel";
import type { DbClient } from "../db/client.js";
import { makeGrantPort } from "./grants.js";
import { makeResourcePort } from "./resources.js";
import { makeMcpPaymentPort } from "../x402/settle.js";

export const SITE_ORIGIN = "https://musebook.dev";

export function makePolicyPort(env: Env, fresh: DbClient): PolicyPort {
  return {
    async isAgentBlocked(agentId) {
      const { rows } = await fresh.query<{ blocked: boolean }>(
        "select app.is_agent_blocked($1::uuid, null::uuid) as blocked",
        [agentId],
      );
      return rows[0]?.blocked ?? false;
    },
    previewChars() {
      return Number(env.PREVIEW_CHARS ?? 400);
    },
    siteOrigin: () => SITE_ORIGIN,
    mode: () => env.X402_MODE ?? "shadow",
  };
}

export function portsFor(
  env: Env,
  ctx: ExecutionContext,
  freshDb: DbClient,
  actorUserId: string | null = null,
): KernelPorts {
  return {
    now: () => new Date(),
    resources: makeResourcePort(freshDb, () => actorUserId),
    grants: makeGrantPort(env, freshDb, ctx),
    payments: makeMcpPaymentPort(env, freshDb),
    policy: makePolicyPort(env, freshDb),
    log: (e) => console.log(JSON.stringify(e)),
  };
}
