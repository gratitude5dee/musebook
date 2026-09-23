// apps/mcp/src/tools/get-feed.ts — §7.4 tool 3: reads a slate musebook-worker
// built (surface 'mcp_feed'); the ranking pass itself never runs here. Page 2
// reads the same cached slate via the cursor's slate_id + position.
import type { McpServer } from "@modelcontextprotocol/server";
import { fresh, release } from "../db/client.js";
import { recordAgentEvent } from "../telemetry.js";
import { resolveActorFromMcp } from "../auth/resolve-actor.js";
import { requireScope, errorResult } from "./shared.js";
import { getFeedInput } from "./schemas.js";

interface SlateItem {
  position: number;
  post_id: string;
  slug: string;
  kind: string;
  title: string | null;
  author_handle: string;
  content_hash: string;
  score: number;
}

interface SlatePage {
  slate_id: string;
  items: SlateItem[];
  weights_version: string;
  model_version: string;
  created_at: string;
}

const b64u = (s: string): string =>
  btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function registerGetFeed(server: McpServer, env: Env, ctx: ExecutionContext): void {
  server.registerTool(
    "get_feed",
    {
      title: "Read your Musebook feed",
      description:
        "Returns the next page of the ranked feed slate built for this agent, newest first. " +
        "Requires an OAuth token with the feed:read scope.",
      inputSchema: getFeedInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args, toolCtx) => {
      const actor = await resolveActorFromMcp(toolCtx, env, ctx);
      const denied = requireScope(actor, "feed:read");
      if (denied !== null) return denied;
      const ownerAgent = actor.class === "owner_agent" ? actor : null;
      if (ownerAgent === null) return errorResult("unauthenticated", "A delegation is required.");

      const sql = fresh(env);
      try {
        let slateId: string | null = null;
        let after = 0;
        if (args.cursor !== undefined) {
          try {
            const c = JSON.parse(atob(args.cursor.replace(/-/g, "+").replace(/_/g, "/"))) as {
              s?: unknown;
              p?: unknown;
            };
            slateId = typeof c.s === "string" ? c.s : null;
            after = typeof c.p === "number" ? c.p : 0;
          } catch {
            return errorResult("bad_cursor", "Unreadable cursor.");
          }
        }
        const surface =
          args.surface === "topic"
            ? `topic:${args.topic ?? ""}`
            : args.surface === "author"
              ? `author:${args.author ?? ""}`
              : "mcp_feed";
        const rows = (await sql.unsafe(
          `select app.read_slate($1::uuid, $2::uuid, $3::text, $4::uuid, $5::int, $6::int) as r`,
          [
            ownerAgent.userId,
            ownerAgent.agentIdentityId,
            surface,
            slateId,
            after,
            args.limit ?? 20,
          ],
        )) as { r: SlatePage | null }[];
        const page = rows[0]?.r ?? null;
        const items = page?.items ?? [];
        recordAgentEvent(env, ctx, {
          actor,
          tool: "get_feed",
          outcome: "ok",
          surface: "mcp_feed",
          n: items.length,
        });
        const last = items.at(-1);
        return {
          content: [
            {
              type: "text" as const,
              text:
                items.length === 0
                  ? "Feed is empty."
                  : items
                      .map(
                        (i) =>
                          `- [${i.title ?? i.slug}](https://musebook.dev/p/${i.slug}) — ${i.kind} by @${i.author_handle}`,
                      )
                      .join("\n"),
            },
          ],
          structuredContent: {
            slate_id: page?.slate_id ?? null,
            items,
            next_cursor:
              page !== null && last !== undefined && items.length === (args.limit ?? 20)
                ? b64u(JSON.stringify({ s: page.slate_id, p: last.position + 1 }))
                : null,
          },
        };
      } finally {
        release(ctx, sql);
      }
    },
  );
}
