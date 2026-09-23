// apps/mcp/src/index.ts — §7.2 entrypoint. Two surfaces in one Worker:
//   1. apiHandler — the MCP endpoint (stateless handler from server.ts)
//   2. defaultHandler — ConsentHandler: /authorize consent + PRM + healthz
// The scheduled-agent drafting cron lives on musebook-worker (§4.7 single
// cron owner); this Worker runs fetch-time only.
//
// §7.6.4's anonymous-read contract: the provider 401s any apiRoute request
// without a Bearer header (oauth-provider.ts handleApiRequest), but anonymous
// reads are the point — "an anonymous agent with a wallet can buy and read".
// Requests to /mcp that present no Bearer therefore bypass the OAuth wrap
// entirely and reach the same apiHandler; a presented Bearer gets the full
// provider path (grant lookup → ctx.props → the same handler). Identity stays
// orthogonal to entitlement on both arms.
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { ConsentHandler } from "./auth/oauth.js";
import { buildMcpHandler } from "./server.js";

const apiHandler = {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => buildMcpHandler(env, ctx)(request),
};

const provider = new OAuthProvider<Env>({
  apiRoute: ["/mcp", "/mcp/"],
  apiHandler,
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
  // RFC 9728 — the provider serves /.well-known/oauth-protected-resource*
  // itself, so the PRM fields live here rather than on a manual route.
  resourceMetadata: {
    resource: "https://mcp.musebook.dev/mcp",
    authorization_servers: ["https://mcp.musebook.dev"],
    scopes_supported: [
      "mcp",
      "feed:read",
      "graph:write",
      "post:write",
      "post:publish",
      "analytics:read",
      "wallet:spend",
    ],
    bearer_methods_supported: ["header"],
    resource_name: "musebook-mcp",
  },
});

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> | Response {
    const path = new URL(request.url).pathname;
    if (
      (path === "/mcp" || path === "/mcp/") &&
      !request.headers.get("authorization")?.toLowerCase().startsWith("bearer ")
    ) {
      return apiHandler.fetch(request, env, ctx);
    }
    return provider.fetch(request, env, ctx);
  },
};
