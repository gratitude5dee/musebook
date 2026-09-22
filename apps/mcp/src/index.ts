// apps/mcp/src/index.ts — §7.2 entrypoint. Two surfaces in one Worker:
//   1. apiHandler — the MCP endpoint (stateless handler from server.ts)
//   2. defaultHandler — ConsentHandler: /authorize consent + PRM + healthz
// The scheduled-agent drafting cron lives on musebook-worker (§4.7 single
// cron owner); this Worker runs fetch-time only.
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { ConsentHandler } from "./auth/oauth.js";
import { buildMcpHandler } from "./server.js";

export default new OAuthProvider<Env>({
  apiRoute: ["/mcp", "/mcp/"],
  apiHandler: {
    fetch: (request: Request, env: Env, ctx: ExecutionContext) =>
      buildMcpHandler(env, ctx)(request),
  },
  defaultHandler: ConsentHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  scopesSupported: [
    "mcp",
    "feed:read",
    "graph:write",
    "post:write",
    "post:publish",
    "analytics:read",
    "wallet:spend",
  ],
  accessTokenTTL: 3_600,
});
