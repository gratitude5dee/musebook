// apps/mcp/src/tools/download-asset.ts — §7.4 tool 6 / §7.5.1: returns a
// resource_link, NEVER bytes. The URI is assets.url — cdn.musebook.dev for a
// free asset, media.musebook.dev for a paid one (the gate re-checks the
// grant on every byte). ?g={grant_id} is a bearer capability: revocable,
// auditable, and scoped to one content_hash — it stops working on edit.
import type { McpServer } from "@modelcontextprotocol/server";
import { fresh, release } from "../db/client.js";
import { recordAgentEvent } from "../telemetry.js";
import { resolveActorFromMcp } from "../auth/resolve-actor.js";
import { notFound } from "./shared.js";
import { downloadAssetInput } from "./schemas.js";

interface AssetRow {
  asset_id: string;
  url: string;
  storage: string;
  content_type: string;
  byte_len: number;
  sha256: string;
  parent_post_id: string;
  parent_content_hash: string;
  parent_slug: string;
  parent_published: boolean;
}

export function registerDownloadAsset(server: McpServer, env: Env, ctx: ExecutionContext): void {
  server.registerTool(
    "download_asset",
    {
      title: "Get a Musebook asset link",
      description:
        "Returns a resource_link for one asset — never bytes. Free assets resolve on " +
        "cdn.musebook.dev; paid ones on media.musebook.dev where the grant is re-checked on " +
        "every request. Pass grant_id from a prior purchase_access call for a paid asset.",
      inputSchema: downloadAssetInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args, toolCtx) => {
      const actor = await resolveActorFromMcp(toolCtx, env, ctx);
      const sql = fresh(env);
      try {
        const rows = (await sql.unsafe(`select * from app.asset_for_download($1::uuid)`, [
          args.asset_id,
        ])) as AssetRow[];
        const a = rows[0];
        if (a === undefined || !a.parent_published) return notFound("asset");

        const uri =
          a.storage === "r2_paid" && args.grant_id !== undefined
            ? `${a.url}?g=${args.grant_id}`
            : a.url;
        recordAgentEvent(env, ctx, {
          actor,
          tool: "download_asset",
          outcome: "ok",
          postId: a.parent_post_id,
          contentHash: a.parent_content_hash,
        });
        return {
          content: [
            {
              type: "resource_link" as const,
              uri,
              name: a.parent_slug,
              description: `${a.content_type}, ${a.byte_len} bytes. Entitlement is re-checked on every byte served; Range supported.`,
              mimeType: a.content_type,
            },
          ],
          structuredContent: {
            asset_id: a.asset_id,
            byte_len: a.byte_len,
            sha256: a.sha256,
            storage: a.storage,
            ...(args.grant_id !== undefined ? { grant_id: args.grant_id } : {}),
            range_supported: true,
          },
        };
      } finally {
        release(ctx, sql);
      }
    },
  );
}
