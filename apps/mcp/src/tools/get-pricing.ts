// apps/mcp/src/tools/get-pricing.ts — §7.4 tool 7: the pricing answer, always
// free. reusable is mintsDurableGrant(resource); the mode is never inspected.
import type { McpServer } from "@modelcontextprotocol/server";
import { asDb, cached, release } from "../db/client.js";
import { loadPostByPostId, loadPostBySlug } from "../db/posts.js";
import { loadResource, mintsDurableGrant, toAccessBadge } from "@musebook/kernel";
import { resolveActorFromMcp } from "../auth/resolve-actor.js";
import { recordAgentEvent } from "../telemetry.js";
import { errorResult } from "./shared.js";
import { getPricingInput } from "./schemas.js";

export function registerGetPricing(server: McpServer, env: Env, ctx: ExecutionContext): void {
  server.registerTool(
    "get_pricing",
    {
      title: "Get Musebook pricing",
      description:
        "Returns how a post is priced for agents (amount, asset, network, grant reuse), or an " +
        "author's default terms when you pass author instead of a post.",
      inputSchema: getPricingInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args, toolCtx) => {
      const actor = await resolveActorFromMcp(toolCtx, env, ctx);
      const sql = cached(env);
      try {
        if (
          args.author !== undefined &&
          args.post_slug === undefined &&
          args.post_id === undefined
        ) {
          const rows = (await sql.unsafe(`select * from app.author_pricing_defaults($1::text)`, [
            args.author,
          ])) as {
            handle: string;
            license_spdx: string;
            price_cents: number | null;
            train_ai: boolean;
            ai_use: boolean;
          }[];
          const d = rows[0];
          if (d === undefined) return errorResult("not_found", "No such author.");
          return {
            content: [
              {
                type: "text" as const,
                text: `@${d.handle}: license ${d.license_spdx}, default price ${d.price_cents ?? "platform default"} cents.`,
              },
            ],
            structuredContent: { author: d.handle, ...d },
          };
        }
        const db = asDb(sql);
        const row =
          args.post_id !== undefined
            ? await loadPostByPostId(db, args.post_id, actor.userId)
            : await loadPostBySlug(db, args.post_slug ?? "", actor.userId);
        const resource = row === null ? null : loadResource(row);
        if (resource === null) return errorResult("not_found", "No such post.");
        const badge = toAccessBadge(resource);
        recordAgentEvent(env, ctx, { actor, tool: "get_pricing", outcome: "ok" });
        return {
          content: [
            {
              type: "text" as const,
              text: `${badge.kind}: ${resource.priceAtomic} atomic ${resource.priceAsset ?? ""} on ${resource.priceNetwork ?? ""}. ${badge.rule}`,
            },
          ],
          structuredContent: {
            post_id: resource.postId,
            slug: resource.slug,
            content_hash: resource.contentHash,
            access: badge.kind,
            price_atomic: resource.priceAtomic,
            price_asset: resource.priceAsset,
            price_network: resource.priceNetwork,
            reusable: mintsDurableGrant(resource),
            license_spdx: resource.licenseSpdx,
            rule: badge.rule,
          },
        };
      } finally {
        release(ctx, sql);
      }
    },
  );
}
