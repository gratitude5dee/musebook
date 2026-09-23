// apps/mcp/src/tools/subscribe-author.ts — §7.4 tool 9: follow/unfollow an
// author as the delegated owner. graph:write scope; the follow edge and the
// audit row land in one app.set_follow call.
import type { McpServer } from "@modelcontextprotocol/server";
import { fresh, release } from "../db/client.js";
import { resolveActorFromMcp } from "../auth/resolve-actor.js";
import { recordAgentEvent } from "../telemetry.js";
import { requireScope, errorResult } from "./shared.js";
import { subscribeAuthorInput } from "./schemas.js";

export function registerSubscribeAuthor(server: McpServer, env: Env, ctx: ExecutionContext): void {
  server.registerTool(
    "subscribe_author",
    {
      title: "Follow a Musebook author",
      description:
        "Follows or unfollows an author as the delegating owner. Requires the graph:write scope. " +
        "The follows edge is labeled with the agent identity and written to audit_log.",
      inputSchema: subscribeAuthorInput,
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async (args, toolCtx) => {
      const actor = await resolveActorFromMcp(toolCtx, env, ctx);
      const denied = requireScope(actor, "graph:write");
      if (denied !== null) return denied;
      if (actor.class !== "owner_agent")
        return errorResult("unauthenticated", "A delegation is required.");

      const sql = fresh(env);
      try {
        const rows = (await sql.unsafe(
          `select app.set_follow($1::uuid, $2::uuid, $3::uuid, $4::text, $5::text, $6::boolean) as r`,
          [
            actor.userId,
            actor.delegationId,
            actor.agentIdentityId,
            args.author,
            args.action ?? "follow",
            args.notify ?? false,
          ],
        )) as { r: { ok: boolean; error?: string } }[];
        const r = rows[0]?.r;
        if (r === undefined || !r.ok) {
          return errorResult(
            r?.error ?? "follow_failed",
            `Could not ${args.action}: ${r?.error ?? "unknown"}.`,
          );
        }
        recordAgentEvent(env, ctx, {
          actor,
          tool: "subscribe_author",
          outcome: args.action === "unfollow" ? "ok" : "ok",
        });
        return {
          content: [
            {
              type: "text" as const,
              text: `${args.action === "unfollow" ? "Unfollowed" : "Following"} @${args.author}.`,
            },
          ],
          structuredContent: { ok: true, action: args.action, author: args.author },
        };
      } finally {
        release(ctx, sql);
      }
    },
  );
}
