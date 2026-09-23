// apps/mcp/src/tools/list-authors.ts — §7.4 tool 4: public author directory.
import type { McpServer } from "@modelcontextprotocol/server";
import { listAuthors } from "../db/search.js";
import { cached, release } from "../db/client.js";
import { recordAgentEvent } from "../telemetry.js";
import { resolveActorFromMcp } from "../auth/resolve-actor.js";
import { listAuthorsInput } from "./schemas.js";

export function registerListAuthors(server: McpServer, env: Env, ctx: ExecutionContext): void {
  server.registerTool(
    "list_authors",
    {
      title: "List Musebook authors",
      description:
        "Search the author directory by handle or display name. Optionally restricts to authors " +
        "who publish at least one post priced for agents.",
      inputSchema: listAuthorsInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args, toolCtx) => {
      const actor = await resolveActorFromMcp(toolCtx, env, ctx);
      const sql = cached(env);
      try {
        const page = await listAuthors(sql, args);
        recordAgentEvent(env, ctx, {
          actor,
          tool: "list_authors",
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
