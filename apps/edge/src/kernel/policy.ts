// apps/edge/src/kernel/policy.ts — PolicyPort (§6.3).
// isAgentBlocked is a FRESH read: a cached "not blocked" would serve a blocked
// agent for up to 75 s after the flag landed.
import type { PolicyPort } from "@musebook/kernel";
import type { DbClient } from "../db/client.js";
import { canonicalOrigin } from "../index.js";

export function makePolicyPort(env: Env, fresh: DbClient, request: Request): PolicyPort {
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
    // The canonical site origin, derived from the request host (§6.3) — the same
    // canonicalOrigin() the passthrough uses, so a twin URL never invents one.
    siteOrigin: () => canonicalOrigin(new URL(request.url)),
    mode: () => env.X402_MODE ?? "shadow",
  };
}
