// apps/mcp/src/tools/search-posts.ts — §7.4 tool 1: public catalog search on
// HYPERDRIVE_CACHED (public rows only). Access badge comes from the SQL
// helper, never the column.
import type { McpServer } from "@modelcontextprotocol/server";
import { searchPosts } from "../db/search.js";
import { cached, release } from "../db/client.js";
import { recordAgentEvent } from "../telemetry.js";
import { resolveActorFromMcp } from "../auth/resolve-actor.js";
import { searchPostsInput } from "./schemas.js";

export function registerSearchPosts(server: McpServer, env: Env, ctx: ExecutionContext): void {
  server.registerTool(
    "search_posts",
    {
      title: "Search Musebook posts",
      description:
        "Full-text and keyword search across published Musebook posts. Returns titles, summaries, " +
        "content hashes, access badge and price. Never returns a gated body — use get_post for that.",
      inputSchema: searchPostsInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args, toolCtx) => {
      const actor = await resolveActorFromMcp(toolCtx, env, ctx);
      const sql = cached(env);
      try {
        const page = await searchPosts(sql, args);
        recordAgentEvent(env, ctx, {
          actor,
          tool: "search_posts",
          outcome: "ok",
          n: page.results.length,
        });
        return {
          content: [{ type: "text" as const, text: page.markdownTable }],
          structuredContent: { results: page.results, next_cursor: page.nextCursor },
        };
      } finally {
        release(ctx, sql);
      }
    },
  );
}
