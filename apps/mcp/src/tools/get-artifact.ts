// apps/mcp/src/tools/get-artifact.ts — §7.4 tool 5: artifact metadata for
// free; the source bundle is a resource_link through the paid gate when the
// parent post is priced.
import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { cached, release } from "../db/client.js";
import { recordAgentEvent } from "../telemetry.js";
import { resolveActorFromMcp } from "../auth/resolve-actor.js";
import { notFound } from "./shared.js";
import { getArtifactInput } from "./schemas.js";

interface ArtifactRow {
  artifact_id: string;
  post_id: string;
  title: string | null;
  kind: string;
  description: string | null;
  run_url: string | null;
  source_asset_id: string | null;
  poster_asset_id: string | null;
  created_at: string;
  parent_published: boolean;
}

export function registerGetArtifact(server: McpServer, env: Env, ctx: ExecutionContext): void {
  server.registerTool(
    "get_artifact",
    {
      title: "Read a Musebook artifact",
      description:
        "Returns a shippable 2D/3D artifact's metadata and run URL. With include_source:true, " +
        "returns the source bundle as a resource_link — entitlement is enforced on the link by the " +
        "media Worker when the parent post is priced.",
      inputSchema: getArtifactInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args, toolCtx) => {
      const actor = await resolveActorFromMcp(toolCtx, env, ctx);
      const sql = cached(env);
      try {
        const rows = (await sql.unsafe(
          `select * from app.artifact_for_read($1::uuid, $2::text)`,
          [args.artifact_id ?? null, args.post_slug ?? null],
        )) as ArtifactRow[];
        const a = rows[0];
        if (a === undefined || !a.parent_published) return notFound("artifact");

        const structured: Record<string, unknown> = {
          artifact_id: a.artifact_id,
          post_id: a.post_id,
          title: a.title,
          kind: a.kind,
          description: a.description,
          run_url: a.run_url,
          created_at: a.created_at,
        };
        const content: CallToolResult["content"] = [
          {
            type: "text",
            text: `${a.title ?? "artifact"} (${a.kind})${a.run_url !== null ? ` — run: ${a.run_url}` : ""}`,
          },
        ];

        if (args.include_source && a.source_asset_id !== null) {
          const assets = (await sql.unsafe(
            `select * from app.asset_for_download($1::uuid)`,
            [a.source_asset_id],
          )) as {
            asset_id: string;
            url: string;
            storage: string;
            content_type: string;
            byte_len: number;
            parent_content_hash: string;
          }[];
          const asset = assets[0];
          if (asset !== undefined) {
            const uri =
              asset.storage === "r2_paid" && args.grant_id !== undefined
                ? `${asset.url}?g=${args.grant_id}`
                : asset.url;
            content.push({
              type: "resource_link",
              uri,
              name: `source-${a.artifact_id}`,
              description: `Source bundle (${asset.byte_len} bytes). Entitlement re-checked on every byte.`,
              mimeType: asset.content_type,
            });
            structured.source = { asset_id: asset.asset_id, byte_len: asset.byte_len };
          }
        }

        recordAgentEvent(env, ctx, { actor, tool: "get_artifact", outcome: "ok" });
        return { content, structuredContent: structured };
      } finally {
        release(ctx, sql);
      }
    },
  );
}
