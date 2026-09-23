// apps/mcp/src/tools/index.ts — §7.4 deterministic registration order.
import type { McpServer } from "@modelcontextprotocol/server";
import { registerSearchPosts } from "./search-posts.js";
import { registerGetPost } from "./get-post.js";
import { registerGetFeed } from "./get-feed.js";
import { registerListAuthors } from "./list-authors.js";
import { registerGetArtifact } from "./get-artifact.js";
import { registerDownloadAsset } from "./download-asset.js";
import { registerGetPricing } from "./get-pricing.js";
import { registerPurchaseAccess } from "./purchase-access.js";
import { registerSubscribeAuthor } from "./subscribe-author.js";
import { registerSubmitPost } from "./submit-post.js";
import { registerGetAnalytics } from "./get-analytics.js";

export function registerAllTools(server: McpServer, env: Env, ctx: ExecutionContext): void {
  // Order is fixed: test/contract asserts this array verbatim.
  registerSearchPosts(server, env, ctx);
  registerGetPost(server, env, ctx);
  registerGetFeed(server, env, ctx);
  registerListAuthors(server, env, ctx);
  registerGetArtifact(server, env, ctx);
  registerDownloadAsset(server, env, ctx);
  registerGetPricing(server, env, ctx);
  registerPurchaseAccess(server, env, ctx);
  registerSubscribeAuthor(server, env, ctx);
  registerSubmitPost(server, env, ctx);
  registerGetAnalytics(server, env, ctx);
}
