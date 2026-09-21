# Verified facts (primary-source checked 2026-09-21)

Adversarially verified. AUTHORITATIVE over any research file or model memory.


## next16-proxy — PARTIALLY_CORRECT

The rename is real; the config block and the fail-open story are both wrong.

(1) Current stable Next.js as of 2026-09-21 is 16.3.5 (published 2026-09-11; npm dist-tags latest=16.3.5, canary=16.4.0-canary.37, beta=16.0.0-beta.0).

(2) proxy.ts exists and is correct. As of v16.0.0 the `middleware.js|ts` file convention is DEPRECATED and renamed to `proxy.js|ts`, and the exported function is renamed `middleware` -> `proxy` (default export also accepted, but the docs recommend naming it `proxy`). middleware.ts is deprecated, NOT removed — it still compiles and still runs in 16.3.5. Codemod: `npx @next/codemod@canary middleware-to-proxy .`

(3) REFUTED on the runtime config. `export const config = { runtime: 'nodejs' }` in proxy.ts is NOT how you force Node — it is illegal and Next THROWS. Proxy always runs on the Node.js runtime and the runtime is not configurable. Docs (proxy.mdx, "## Runtime"): "Proxy defaults to using the Node.js runtime. The runtime config option is not available in Proxy files. Setting the runtime config option in Proxy will throw an error." Source check in next@16.3.5: build/analysis/get-page-static-info.ts throws `Route segment config is not allowed in Proxy file at "<path>". Proxy always runs on Node.js runtime.` (hard throw on `next build`; `Log.errorOnce` in dev). So Node on proxy is STABLE and automatic — nothing to opt into, no experimental.nodeMiddleware flag (that flag was the Next 15.2 experimental path; Node middleware went stable in 15.5 via `config.runtime='nodejs'` in middleware.ts — that form is Next 15-and-earlier only). Corollary the claim misses: the `edge` runtime is NOT supported in proxy at all. If the paywall needs edge, you must stay on middleware.ts.

(4) REFUTED on "silently does nothing / fails open". Next 16 is loud in both cases. Wrong filename (middleware.ts alone): still fully wired into the build (`proxyFilePath || middlewareFilePath` feeds the same pipeline) and emits `Log.warnOnce("The \"middleware\" file convention is deprecated. Please use \"proxy\" instead.")` — it runs, the paywall is enforced. BOTH files present: hard `throw new Error('Both middleware file "./..." and proxy file "./..." are detected. Please use "./proxy.ts" only.')` in build/index.ts and in setup-dev-bundler.ts — the build fails, it does not silently pick one. A file that exports neither a default nor a correctly-named function also throws at build (`The file "..." must export a function, either as a default export or as a named "proxy" export.`) — this is the one that bites during migration: renaming the file but leaving `export function middleware()` inside proxy.ts is an ERROR, not a silent no-op.

The one real fail-open risk, which the claim misstates: `matcher`. With no `matcher`, proxy runs on EVERY request including `_next/static` and `public/`; with a matcher, the Next docs explicitly warn "A matcher change or a refactor that moves a Server Function to a different route can silently remove Proxy coverage. Always verify authentication and authorization inside each Server Function rather than relying on Proxy alone." Do not stake a paywall on proxy.ts alone — enforce entitlement in the route handler / Server Function / data layer too.

### Copy-paste snippet
```
// proxy.ts  (project root, or src/ — same level as app/ or pages/)
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export async function proxy(request: NextRequest) {
  // paywall check here; it already runs on the Node.js runtime
  return NextResponse.next()
}

// NO `runtime` key — setting it throws:
// "Route segment config is not allowed in Proxy file ... Proxy always runs on Node.js runtime."
export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
}

// Migration, if middleware.ts already exists (renames file AND function):
//   npx @next/codemod@canary middleware-to-proxy .
// Delete middleware.ts afterwards — keeping both is a hard build error.
```

### Caveats
- Version-dated 2026-09-21: stable next = 16.3.5 (2026-09-11). Behavior confirmed in the published 16.3.5 tarball, not just canary; doc text read from main @ 57eb2b3 (2026-09-21), which is 16.4.0-canary.
- middleware.ts is deprecated, not removed, in the whole 16.x line. Assume removal in 17 — but an agent writing middleware.ts today gets a working paywall plus a warning, not a broken one.
- Proxy cannot run on the edge runtime in 16. The upgrade guide says 'Edge middleware is not blindly renamed to proxy' and promises follow-up edge instructions in a later minor — if the paywall design assumed edge, that assumption is the thing to revisit.
- Third-party/Vercel docs still show `export const config = { runtime: 'nodejs' }`; that snippet is scoped to Next 15 and earlier and will throw if copied into proxy.ts.
- Related config renames in 16: skipMiddlewareUrlNormalize -> skipProxyUrlNormalize, experimental.middlewarePrefetch -> experimental.proxyPrefetch, experimental.middlewareClientMaxBodySize -> experimental.proxyClientMaxBodySize, experimental.externalMiddlewareRewritesResolve -> experimental.externalProxyRewritesResolve. Setting the old and new form of the same option together is an error.
- Security posture: Next's own docs tell you not to rely on proxy alone for authn/authz. Any plan that makes proxy.ts the single enforcement point is fragile regardless of filename.

### Evidence
- https://registry.npmjs.org/next (dist-tags: latest=16.3.5; 16.3.5 published 2026-09-11T17:26:46Z; canary 16.4.0-canary.37 2026-09-19)
- https://registry.npmjs.org/next/-/next-16.3.5.tgz — package/package.json version 16.3.5; dist/build/index.js contains the 'Both ${MIDDLEWARE_FILENAME} file ... and ${PROXY_FILENAME} file ... are detected' throw; dist/build/analysis/get-page-static-info.js contains 'Route segment config is not allowed in Proxy file at'
- vercel/next.js @ 57eb2b34f00fa7c93b0539dfe6759815b1b6e120 (2026-09-21) docs/01-app/03-api-reference/03-file-conventions/proxy.mdx — '## Runtime' section and version-history row 'v16.0.0 | Middleware is deprecated and renamed to Proxy. Proxy defaults to the Node.js runtime'
- vercel/next.js docs/01-app/03-api-reference/03-file-conventions/middleware.mdx — 'The middleware.js file convention has been deprecated in Next.js 16 and renamed to proxy.js'
- vercel/next.js docs/01-app/02-guides/upgrading/version-16.mdx lines 612-637 — 'The edge runtime is NOT supported in proxy. The proxy runtime is nodejs, and it cannot be configured. If you want to continue using the edge runtime, keep using middleware.'
- vercel/next.js packages/next/src/build/index.ts:1447-1462 (throw on both files; Log.warnOnce deprecation on middleware-only)
- vercel/next.js packages/next/src/build/analysis/get-page-static-info.ts:816-831 (throws when runtime config set in a proxy file) and :410-431 (throws when no valid proxy export)
- vercel/next.js packages/next/src/server/lib/router-utils/setup-dev-bundler.ts:565-572 (same two messages in dev)
- https://vercel.com/docs/platforms/multi-tenant-platforms/middleware-and-routing — labels `export const config = { runtime: 'nodejs' }` in middleware.ts as 'for Next.js 15 and earlier', and uses `export async function proxy(...)` in proxy.ts for current Next


## mcp-package — PARTIALLY_CORRECT

Researcher A is substantially CORRECT; Reviewer B is REFUTED. All three packages exist on the npm registry (verified 2026-09-21):

(1) @modelcontextprotocol/sdk — EXISTS. latest 1.30.0, published 2026-07-27. Package created 2024-11-11, 79 versions. This is the LEGACY v1 line, still published but superseded for new work.
(2) @modelcontextprotocol/server — EXISTS. latest 2.0.0, published 2026-07-27T23:55:22Z. Package created 2026-04-01, 10 versions (alphas/betas from 2026-06-25 through 2.0.0). Author "Anthropic, PBC", repo git+https://github.com/modelcontextprotocol/typescript-sdk.git. Reviewer B's claim that this "is not a real package" is FLATLY WRONG. In SDK v2 the TypeScript SDK was split into @modelcontextprotocol/core@2.0.0 (also real, published 2026-07-27T23:55:21Z) plus @modelcontextprotocol/server@2.0.0, which depends on core 2.0.0 and zod ^4.2.0.
(3) mcp-handler — EXISTS. latest 2.2.0, published 2026-09-18 (3 days ago). Repo git+https://github.com/vercel/mcp-handler.git, Apache-2.0. peerDependencies: {"next": ">=13.0.0", "@modelcontextprotocol/server": "^2.0.0"}. Described as "Framework-agnostic HTTP adapter for Model Context Protocol servers" — NOT Vercel-only; it returns a Web-standard (Request) => Promise<Response>.

So A's stack "mcp-handler@2 + @modelcontextprotocol/server@2 + zod@4, app/api/mcp/route.ts, withMcpAuth + protectedResourceHandler" is correct and matches the package's own README install line verbatim. Corrections to A's details: zod must be ^4.2.0 (not merely ^4); Node.js 20+ required; createMcpHandler's signature in 2.x is (initialize, options) — the 1.x third config arg with basePath/sseEndpoint/redisUrl/sessionIdGenerator is REMOVED; tools are registered with server.registerTool (variadic server.tool is removed) and inputSchema takes a full Standard Schema (z.object({...})) not a raw zod shape; auth info is ctx.http?.authInfo (was extra.authInfo); AuthInfo imports from "@modelcontextprotocol/server" (not @modelcontextprotocol/sdk/server/auth/types.js); export only GET and POST (the 1.x DELETE export is gone — GET/DELETE session ops now answer 405 because serving is stateless); /api/mcp is a convention, the handler does not inspect pathname. withMcpAuth is exported under both `withMcpAuth` and `experimental_withMcpAuth`.

SPEC VERIFICATION — the 2026-07-28 revision is REAL and CURRENT, and all five sub-claims are CONFIRMED. modelcontextprotocol.io is egress-blocked here, so I verified against the spec repo itself (github.com/modelcontextprotocol/modelcontextprotocol, shallow clone at /home/user/modelcontextprotocol/modelcontextprotocol):
- schema/ contains 2024-11-05, 2025-03-26, 2025-06-18, 2025-11-25, 2026-07-28, draft. schema/2026-07-28/schema.ts:30 has `export const LATEST_PROTOCOL_VERSION = "2026-07-28"`. schema/draft/schema.ts:30 ALSO reads "2026-07-28", so 2026-07-28 is the current ratified revision and nothing newer exists as of 2026-09-21.
- Sub-claim 1, removes the initialize handshake: CONFIRMED. Changelog major change #2 (SEP-2575): "Make MCP stateless: remove the `initialize`/`notifications/initialized` handshake." grep for "initialize" in schema/2026-07-28/schema.ts returns ZERO hits.
- Sub-claim 2, removes Mcp-Session-Id: CONFIRMED. Changelog major change #1 (SEP-2567): "Remove protocol-level sessions and the `Mcp-Session-Id` header from the Streamable HTTP transport." grep for mcp-session-id/sessionId in the schema returns zero hits.
- Sub-claim 3, adds server/discover: CONFIRMED. Changelog major change #3 (SEP-2575); schema.ts:666 `method: "server/discover"` on DiscoverRequest. Servers MUST implement it; clients MAY call it.
- Sub-claim 4, required _meta envelope: CONFIRMED with a nuance. schema.ts:179-181 `export interface RequestParams { _meta: RequestMetaObject; }` — non-optional on REQUESTS, carrying io.modelcontextprotocol/protocolVersion and /clientCapabilities. But NotificationParams._meta (line 197) and Result._meta (line 220) remain OPTIONAL. So "required" is true for requests, not universally.
- Sub-claim 5, required resultType: CONFIRMED. schema.ts:234 `resultType: ResultType;` non-optional on Result; type is "complete" | "input_required" | string. Changelog minor-list item: clients MUST treat an absent field from earlier-protocol servers as "complete".
- Sub-claim 6, MRTR (Multi Round-Trip Request) pattern: CONFIRMED. Changelog major change #7 (SEP-2322); spec page docs/specification/2026-07-28/basic/patterns/mrtr. Servers return InputRequiredResult (resultType: "input_required") with inputRequests; clients retry the original request with inputResponses (+ requestState). This REPLACES server-initiated roots/list, sampling/createMessage, elicitation/create.
- "Breaking redesign" is accurate and if anything understated: the revision also replaces the HTTP GET endpoint and resources/subscribe with subscriptions/listen, removes ping, logging/setLevel and notifications/roots/list_changed, removes SSE resumability/Last-Event-ID, moves tasks to an extension, and deprecates DCR in favor of CIMD (Client ID Metadata Documents).

WARNING FOR THE IMPLEMENTING AGENT: Vercel's public docs page https://vercel.com/docs/mcp/deploy-mcp-servers-to-vercel is STALE as of 2026-09-21 — it still shows the mcp-handler 1.x API (variadic server.tool, third-arg { basePath: '/api' }, `export { handler as GET, handler as POST, handler as DELETE }`, and AuthInfo imported from '@modelcontextprotocol/sdk/server/auth/types.js'). Do NOT copy that page. The authoritative source is the mcp-handler 2.2.0 README (in the published tarball) and https://github.com/vercel/mcp-handler/blob/main/docs/AUTHORIZATION.md.

### Copy-paste snippet
```
### 1. Install (verified against mcp-handler@2.2.0 README, 2026-09-21)

npm install mcp-handler@^2 @modelcontextprotocol/server@^2 zod@^4

# Requires Node.js 20+ and Next.js 13+. Do NOT install @modelcontextprotocol/sdk
# (that is the v1 line, paired with mcp-handler 1.x). Do NOT install redis —
# mcp-handler 2.x is stateless and no longer uses it.

### 2. Minimal working route handler — app/api/mcp/route.ts

import { createMcpHandler } from "mcp-handler";
import { z } from "zod";

const handler = createMcpHandler((server) => {
  server.registerTool(
    "roll_dice",
    {
      title: "Roll Dice",
      description: "Roll a dice with a specified number of sides.",
      inputSchema: z.object({
        sides: z.number().int().min(2),
      }),
    },
    async ({ sides }) => {
      const value = 1 + Math.floor(Math.random() * sides);
      return {
        content: [{ type: "text", text: `You rolled a ${value}!` }],
      };
    },
  );
});

export { handler as GET, handler as POST };

### 3. Optional OAuth — app/api/mcp/route.ts with withMcpAuth

import type { AuthInfo } from "@modelcontextprotocol/server";
import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { z } from "zod";

const handler = createMcpHandler((server) => {
  server.registerTool(
    "echo",
    {
      title: "Echo",
      description: "Echo a message",
      inputSchema: z.object({ message: z.string() }),
    },
    async ({ message }, ctx) => {
      const authInfo = ctx.http?.authInfo; // NOT extra.authInfo (that was 1.x)
      return {
        content: [
          {
            type: "text",
            text: `Echo: ${message}${authInfo?.token ? ` for ${authInfo.clientId}` : ""}`,
          },
        ],
      };
    },
  );
}, {});

const verifyToken = async (
  req: Request,
  bearerToken?: string,
): Promise<AuthInfo | undefined> => {
  if (!bearerToken) return undefined;
  const isValid = await myVerify(bearerToken); // your logic
  if (!isValid) return undefined;
  return {
    token: bearerToken,
    scopes: ["read:stuff"],
    clientId: "user123",
    extra: { userId: "123" },
  };
};

const authHandler = withMcpAuth(handler, verifyToken, {
  required: true,
  requiredScopes: ["read:stuff"],
  resourceMetadataPath: "/.well-known/oauth-protected-resource",
});

export { authHandler as GET, authHandler as POST };

### 4. RFC 9728 metadata — app/.well-known/oauth-protected-resource/route.ts

import {
  protectedResourceHandler,
  metadataCorsOptionsRequestHandler,
} from "mcp-handler";

const handler = protectedResourceHandler({
  authServerUrls: ["https://your-authorization-server.example.com"],
});

const corsHandler = metadataCorsOptionsRequestHandler();

export { handler as GET, corsHandler as OPTIONS };

### Exact exported signatures (from dist/index.d.mts, mcp-handler@2.2.0)

declare function withMcpAuth(
  handler: (req: Request) => Response | Promise<Response>,
  verifyToken: (req: Request, bearerToken?: string) => AuthInfo | undefined | Promise<AuthInfo | undefined>,
  opts?: { required?: boolean; resourceMetadataPath?: string; requiredScopes?: string[]; resourceUrl?: string }
): (req: Request) => Promise<Response>;

declare function protectedResourceHandler(
  args: { authServerUrls: string[]; resourceUrl?: string }
): (req: Request) => Response;

// Full export list:
// createMcpHandler (alias of createMcpRouteHandler), withMcpAuth,
// experimental_withMcpAuth, protectedResourceHandler,
// generateProtectedResourceMetadata, metadataCorsOptionsRequestHandler,
// getPublicOrigin, getPublicUrl, type McpHandlerOptions, type WebMcpOptions
```

### Caveats
- All npm data read from the registry on 2026-09-21. mcp-handler@2.2.0 shipped 2026-09-18 — only 3 days old; re-check `npm view mcp-handler dist-tags` before pinning, and pin exact versions in package.json since this line is moving weekly (2.0.0 -> 2.2.0 in under 8 weeks).
- Vercel's own docs page https://vercel.com/docs/mcp/deploy-mcp-servers-to-vercel is STALE as of 2026-09-21 and still shows the mcp-handler 1.x API (variadic server.tool, { basePath: '/api' }, a DELETE export, AuthInfo from '@modelcontextprotocol/sdk/server/auth/types.js'). An agent that follows that page will produce code that does not compile against 2.x. Use the package README + docs/AUTHORIZATION.md instead.
- @modelcontextprotocol/sdk 1.30.0 is NOT dead — it was published the same day as the v2 split (2026-07-27) and is the correct dependency if you are on mcp-handler 1.x. The two lines are mutually exclusive; do not mix them.
- '_meta is required' is true only for REQUESTS (RequestParams._meta is non-optional). Result._meta and NotificationParams._meta remain optional. Phrase this precisely in the plan or the agent may add _meta where it does not belong.
- The 2026-07-28 spec deprecates Dynamic Client Registration in favor of CIMD (Client ID Metadata Documents). CIMD is advertised/implemented by your AUTHORIZATION SERVER via client_id_metadata_document_supported in its RFC 8414 metadata — mcp-handler does not provide it. Do not plan for mcp-handler to supply CIMD.
- zod must be ^4.2.0 specifically (that is @modelcontextprotocol/server@2.0.0's own dependency range), not just any zod 4. Node.js 20+ is a hard requirement.
- mcp-handler 2.x removed the HTTP+SSE transport (2024-11-05) entirely and no longer uses Redis. Any plan step mentioning redisUrl, sseEndpoint, basePath, maxDuration or sessionIdGenerator is 1.x-era and will fail.
- The spec repo's schema/draft/schema.ts currently also reads LATEST_PROTOCOL_VERSION = "2026-07-28", i.e. no newer draft revision has diverged yet. That can change at any time — the draft directory is a moving target.
- modelcontextprotocol.io was blocked by this environment's egress proxy, so spec claims were verified against the canonical source repo (github.com/modelcontextprotocol/modelcontextprotocol, schema/ and docs/specification/) rather than the rendered website. The repo is the upstream of that website, so this is a primary source, but the clone is shallow (depth 1) and reflects main as of 2026-09-21.

### Evidence
- https://registry.npmjs.org/@modelcontextprotocol%2Fsdk — HTTP 200, dist-tags.latest = 1.30.0, time[1.30.0] = 2026-07-27T17:56:01.640Z, created 2024-11-11T15:53:15.703Z, 79 versions
- https://registry.npmjs.org/@modelcontextprotocol%2Fserver — HTTP 200, dist-tags.latest = 2.0.0, time[2.0.0] = 2026-07-27T23:55:22.239Z, created 2026-04-01T14:46:14.225Z, deps {zod: ^4.2.0, @modelcontextprotocol/core: 2.0.0}, repo modelcontextprotocol/typescript-sdk
- https://registry.npmjs.org/@modelcontextprotocol%2Fcore — HTTP 200, dist-tags.latest = 2.0.0, published 2026-07-27T23:55:21.808Z
- https://registry.npmjs.org/mcp-handler — HTTP 200, dist-tags.latest = 2.2.0, time[2.2.0] = 2026-09-18T19:13:33.818Z, peerDependencies {next: >=13.0.0, @modelcontextprotocol/server: ^2.0.0}, repo git+https://github.com/vercel/mcp-handler.git
- https://registry.npmjs.org/mcp-handler/-/mcp-handler-2.2.0.tgz — unpacked package/README.md (install line, Quick Start, Migrating from 1.x) and package/dist/index.d.mts (exported signatures for withMcpAuth, protectedResourceHandler, metadataCorsOptionsRequestHandler, createMcpRouteHandler aliased as createMcpHandler)
- https://raw.githubusercontent.com/vercel/mcp-handler/main/docs/AUTHORIZATION.md — HTTP 200, full withMcpAuth + registerTool + ctx.http?.authInfo example
- https://github.com/modelcontextprotocol/modelcontextprotocol (shallow clone) /home/user/modelcontextprotocol/modelcontextprotocol/schema/2026-07-28/schema.ts:30, :179-181, :234, :666
- /home/user/modelcontextprotocol/modelcontextprotocol/docs/specification/2026-07-28/changelog.mdx — major changes 1,2,3,7 and resultType item (SEP-2567, SEP-2575, SEP-2322)
- /home/user/modelcontextprotocol/modelcontextprotocol/schema/ directory listing: 2024-11-05, 2025-03-26, 2025-06-18, 2025-11-25, 2026-07-28, draft; schema/draft/schema.ts:30 LATEST_PROTOCOL_VERSION = "2026-07-28"
- /home/user/modelcontextprotocol/modelcontextprotocol/docs/specification/2026-07-28/basic/patterns/mrtr (+ tools.mdx:176, prompts.mdx:165, resources.mdx:177 referencing InputRequiredResult)
- https://vercel.com/docs/mcp/deploy-mcp-servers-to-vercel (via Vercel docs search tool) — confirmed STALE, still documents mcp-handler 1.x API


## x402-v2-mcp — PARTIALLY_CORRECT

x402 v2 EXISTS and is current. Canonical repo is now github.com/x402-foundation/x402 (coinbase/x402 is a development fork, per its README). specs/x402-specification-v2.md says "**Protocol Version**: 2", version history row "v2.0 | 2025-12-9". `@x402/core` exports `export const x402Version = 2;` and npm latest is 2.26.0 (published 2026-09-15). v1 still exists side by side (specs/x402-specification-v1.md, `x402Version: 1`, legacy npm package `x402`@1.2.0).

(1) x402Version field value in v2 = the number 2 (v1 = 1).

(2) REAL v2 HTTP headers (specs/transports-v2/http.md "Header Summary"): `PAYMENT-REQUIRED` (server→client, base64 PaymentRequired), `PAYMENT-SIGNATURE` (client→server, base64 PaymentPayload), `PAYMENT-RESPONSE` (server→client, base64 SettlementResponse). Also `EXTENSION-RESPONSES` (facilitator→resource server only, never forwarded to buyers). The claim's rename framing is WRONG in detail: v1 had only TWO headers — `X-PAYMENT` (client→server) and `X-PAYMENT-RESPONSE` (server→client). `X-PAYMENT` → `PAYMENT-SIGNATURE`; `X-PAYMENT-RESPONSE` → `PAYMENT-RESPONSE`. `PAYMENT-REQUIRED` is NOT a rename of `X-PAYMENT` — it is NEW in v2, replacing v1's practice of putting the payment-requirements JSON in the 402 response BODY. In v2 the 402 body is a server concern ("All x402 protocol information is communicated through headers").

(3) YES, a real specified MCP binding exists: specs/transports-v2/mcp.md. Every mechanism in the claim is confirmed verbatim. Quote: "Servers MUST return a tool result with `isError: true` containing the `PaymentRequired` data. **Mechanism**: Tool result with `isError: true`, `structuredContent`, and `content` fields". "Clients send payment data using the MCP `_meta` field with key `x402/payment`." "Servers communicate payment settlement results using the `_meta[\"x402/payment-response\"]` field." BUT the claim is wrong that this is a v2 invention: specs/transports-v1/mcp.md defines the IDENTICAL mechanism (isError:true, `_meta["x402/payment"]`, `_meta["x402/payment-response"]`) with `x402Version: 1`. Only the x402Version number and the PaymentRequired/PaymentPayload body shapes changed.
Two extra facts the claim omits and an implementer will trip on: (a) `content[0].text` is REQUIRED too, not optional — it must be `JSON.stringify(structuredContent)`; clients SHOULD prefer structuredContent and fall back to parsing content[0].text. (b) The reference impl `@x402/mcp` ALSO handles a JSON-RPC error path with code -32042 (SEP-1036 UrlElicitationRequired) carrying PaymentRequired in `error.data`, as a workaround for modelcontextprotocol/typescript-sdk#774 — that is implementation, not spec.

(4) PaymentRequirements (each element of `accepts[]`, and the `accepted` object in PaymentPayload) — v2 fields: `scheme` (req, string), `network` (req, CAIP-2 string e.g. "eip155:84532"), `amount` (req, string, atomic units), `asset` (req, string), `payTo` (req, string), `maxTimeoutSeconds` (req, number), `extra` (opt, object; reserved protocol keys `assetTransferMethod` and `paymentFlow`). NOTE the v1→v2 renames: v1 used `maxAmountRequired` (not `amount`), carried `resource`/`description`/`mimeType`/`outputSchema` inline, and used bare network names like "base-sepolia" (not CAIP-2).
PaymentRequired: `x402Version` (req, must be 2), `error` (opt, string), `resource` (req, ResourceInfo), `accepts` (req, array of PaymentRequirements), `extensions` (opt).
ResourceInfo: `url` (req), `description`, `mimeType`, `serviceName` (ASCII ≤32), `tags` (≤5, each ASCII ≤32), `iconUrl` (≤2048) — all optional but `url`.
PaymentPayload: `x402Version` (req), `resource` (opt, ResourceInfo), `accepted` (req, a PaymentRequirements object — the chosen one), `payload` (req, scheme-specific), `extensions` (opt). For exact/EVM, `payload` = `{signature, authorization:{from,to,value,validAfter,validBefore,nonce}}`.
SettleResponse: `success` (req bool), `errorReason` (opt), `payer` (opt), `transaction` (req, "" if none broadcast; MUST be non-empty when errorReason is `settlement_pending`), `network` (req CAIP-2), `amount` (opt), `extensions` (opt).
VerifyResponse: `isValid` (req), `invalidReason` (opt), `payer` (opt), `extensions` (opt), `extra` (opt).

(5) Facilitator endpoints (spec §7): POST /verify, POST /settle, GET /supported — all three real. Plus discovery: GET /discovery/resources (§8.1) and GET /discovery/search (Bazaar extension). /verify and /settle take `{x402Version, paymentPayload, paymentRequirements}`. /supported returns `{kinds:[{x402Version, scheme, network, extra?}], extensions:[], signers:{"eip155:*":[...], "solana:*":[...]}}`. Public URLs: `https://x402.org/facilitator` is the default in the x402 packages (`DEFAULT_FACILITATOR_URL` in typescript/packages/legacy/x402/src/verify/useFacilitator.ts), TESTNET ONLY — docs list its networks as `eip155:84532` (Base Sepolia), `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` (Solana devnet), `stellar:testnet`, `aptos:2`, `hedera:testnet`, `xrpl:1`; docs explicitly say it "is not intended to be the default production choice for mainnet routes". Coinbase CDP facilitator is real but is a docs pointer (docs.cdp.coinbase.com/x402), requires CDP API keys, and in the legacy Go client its base is `https://api.cdp.coinbase.com` + route `/platform/v2/x402` — that "v2" is the CDP platform API version, NOT x402 v2. Many other production facilitators are listed in docs/dev-tools/facilitators.md (Stellar, Celo `https://api.x402.celo.org`, Corbits, Dexter, Fireblocks, Polygon, T54 XRPL, etc.).

### Copy-paste snippet
```
// ---- INSTALL (npm, verified on registry 2026-09-21) ----
// npm install @x402/core @x402/mcp @x402/evm        // v2, latest 2.26.0
// npm install x402                                   // legacy v1 only, latest 1.2.0

// ---- MCP: server -> client, payment required (tools/call result) ----
{ "jsonrpc":"2.0", "id":1, "result": {
  "isError": true,
  "structuredContent": {
    "x402Version": 2,
    "error": "Payment required to access this resource",
    "resource": { "url":"mcp://tool/financial_analysis",
                  "description":"Advanced financial analysis tool",
                  "mimeType":"application/json" },
    "accepts": [ { "scheme":"exact", "network":"eip155:84532",
                   "amount":"10000",
                   "asset":"0x036CbD53842c5426634e7929541eC2318f3dCF7e",
                   "payTo":"0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
                   "maxTimeoutSeconds":60,
                   "extra": { "name":"USDC", "version":"2" } } ]
  },
  // REQUIRED, not optional: JSON.stringify(structuredContent)
  "content": [ { "type":"text", "text":"{\"x402Version\":2,...}" } ]
}}

// ---- MCP: client -> server retry with payment ----
{ "jsonrpc":"2.0", "id":1, "method":"tools/call", "params": {
  "name":"financial_analysis",
  "arguments": { "ticker":"AAPL" },
  "_meta": { "x402/payment": {
    "x402Version": 2,
    "resource": { "url":"mcp://tool/financial_analysis" },
    "accepted": { "scheme":"exact", "network":"eip155:84532", "amount":"10000",
                  "asset":"0x036CbD53842c5426634e7929541eC2318f3dCF7e",
                  "payTo":"0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
                  "maxTimeoutSeconds":60,
                  "extra":{"name":"USDC","version":"2"} },
    "payload": { "signature":"0x2d6a...1c",
                 "authorization": { "from":"0x857b...b66", "to":"0x2096...87C",
                   "value":"10000", "validAfter":"1740672089",
                   "validBefore":"1740672154", "nonce":"0xf374...480" } }
  } }
}}

// ---- MCP: server -> client, settlement ----
{ "jsonrpc":"2.0","id":1,"result": {
  "content":[{"type":"text","text":"..."}],
  "_meta": { "x402/payment-response": {
    "success": true,
    "transaction": "0x1234...cdef",
    "network": "eip155:84532",
    "payer": "0x857b06519E91e3A54538791bDbb0E22373e36b66" } }
}}

# ---- HTTP transport v2 headers (NOT X-PAYMENT) ----
HTTP/1.1 402 Payment Required
PAYMENT-REQUIRED: <base64(JSON PaymentRequired)>

POST /premium-data HTTP/1.1
PAYMENT-SIGNATURE: <base64(JSON PaymentPayload)>

HTTP/1.1 200 OK
PAYMENT-RESPONSE: <base64(JSON SettlementResponse)>

# ---- Facilitator (default testnet-only) ----
# POST https://x402.org/facilitator/verify
# POST https://x402.org/facilitator/settle
# GET  https://x402.org/facilitator/supported
# body for verify/settle:
# { "x402Version": 2, "paymentPayload": {...}, "paymentRequirements": {...} }
# /supported -> { "kinds":[{"x402Version":2,"scheme":"exact","network":"eip155:84532"}],
#                 "extensions":[], "signers":{"eip155:*":["0x.."],"solana:*":["CK.."]} }
```

### Caveats
- Checked 2026-09-21 against repo HEAD c9160a6 dated 2026-09-20. This ecosystem moves weekly (@x402/core shipped 2.22.0 -> 2.26.0 recently); re-verify before freezing a plan.
- The canonical repo MOVED: github.com/x402-foundation/x402 is canonical; coinbase/x402 is now described in its own README as 'a development fork'. Plans citing coinbase/x402 as the spec source should be updated.
- x402 v1 is NOT dead. Both specs/ trees ship side by side, legacy npm `x402`@1.2.0 exists, `@x402/core` still branches on `scheme.x402Version === 1`. Decide explicitly which version the implementation targets; a v1 server expects X-PAYMENT and will ignore PAYMENT-SIGNATURE.
- The MCP binding is NOT new in v2 — v1 already had the identical isError/_meta mechanism. Do not write 'v2 introduces MCP support' into the plan.
- 'PAYMENT-REQUIRED' is a NEW header, not a rename of X-PAYMENT. Only X-PAYMENT->PAYMENT-SIGNATURE and X-PAYMENT-RESPONSE->PAYMENT-RESPONSE are renames.
- v1->v2 field renames will silently break a port: `maxAmountRequired` -> `amount`; flat `resource`/`description`/`mimeType`/`outputSchema` -> a nested `resource` ResourceInfo object (outputSchema dropped from the core table); bare network names ('base-sepolia') -> CAIP-2 ('eip155:84532').
- I could NOT reach x402.org (the session egress proxy rejected CONNECT to x402.org:443), so the LIVE /supported response and the live facilitator's current network list are unverified — the network list above is from the repo's docs/core-concepts/network-and-token-support.mdx, not from the running service. Verify with `curl https://x402.org/facilitator/supported` from an unrestricted network.
- x402.org/facilitator is explicitly documented as testnet-only and 'not intended to be the default production choice for mainnet routes'. Do not plan mainnet on it.
- CDP facilitator: I verified only the repo's pointer to docs.cdp.coinbase.com/x402 and the LEGACY Go constant https://api.cdp.coinbase.com + /platform/v2/x402. I did NOT fetch Coinbase's own docs (not reachable here), so the CDP facilitator's current v2 base path and its supported-network list are UNVERIFIED. The '/platform/v2/' segment is CDP's platform API version, not x402Version 2.
- The -32042 (SEP-1036) JSON-RPC error path in @x402/mcp is an SDK workaround for modelcontextprotocol/typescript-sdk#774, not part of specs/transports-v2/mcp.md. It may disappear when that SDK bug is fixed — don't depend on it as the primary signal.
- specs/x402-specification-v2.md has a documentation gap: §5.4 VerifyResponse jumps from 5.4 straight to 5.4.2 with no JSON example.

### Evidence
- https://github.com/x402-foundation/x402 @ commit c9160a6cbf0fc831ac7036d400ef2d671493e392 (2026-09-20), shallow clone at /home/user/x402-foundation/x402
- /home/user/x402-foundation/x402/specs/x402-specification-v2.md (lines 1-3 'Protocol Version: 2'; §5.1.2 PaymentRequired/PaymentRequirements/ResourceInfo field tables; §5.2.2 PaymentPayload; §5.3.2 SettleResponse; §5.4.2 VerifyResponse; §7.1 /verify, §7.2 /settle, §7.2.1 EXTENSION-RESPONSES, §7.3 /supported; §8 discovery; §11.1 CAIP-2; Version History 'v2.0 | 2025-12-9')
- /home/user/x402-foundation/x402/specs/transports-v2/mcp.md (full file: isError:true + structuredContent + content[0].text, _meta['x402/payment'], _meta['x402/payment-response'])
- /home/user/x402-foundation/x402/specs/transports-v2/http.md ('Header Summary' table: PAYMENT-REQUIRED / PAYMENT-SIGNATURE / PAYMENT-RESPONSE)
- /home/user/x402-foundation/x402/specs/transports-v1/http.md lines 46-48, 87-89 (X-PAYMENT, X-PAYMENT-RESPONSE only)
- /home/user/x402-foundation/x402/specs/transports-v1/mcp.md lines 10-14, 80-82, 122-124 (identical MCP _meta binding already in v1, x402Version: 1)
- /home/user/x402-foundation/x402/specs/x402-specification-v1.md lines 81-122 (maxAmountRequired, outputSchema, network 'base-sepolia')
- /home/user/x402-foundation/x402/typescript/packages/core/src/index.ts:1 -> export const x402Version = 2;
- /home/user/x402-foundation/x402/typescript/packages/mcp/src/types/mcp.ts lines 29-39 (MCP_PAYMENT_META_KEY, MCP_PAYMENT_RESPONSE_META_KEY, JSONRPC_PAYMENT_REQUIRED_CODE = -32042)
- /home/user/x402-foundation/x402/typescript/packages/mcp/src/client/x402MCPClient.ts lines 914-940 (detection: isError -> structuredContent -> content[0].text)
- /home/user/x402-foundation/x402/typescript/packages/legacy/x402/src/verify/useFacilitator.ts:17 -> DEFAULT_FACILITATOR_URL = 'https://x402.org/facilitator'
- /home/user/x402-foundation/x402/docs/dev-tools/facilitators.md (facilitator table incl. CDP, Celo, Polygon, T54 XRPL)
- /home/user/x402-foundation/x402/docs/core-concepts/network-and-token-support.mdx lines 317-331 (x402.org facilitator networks, testnet only)
- /home/user/x402-foundation/x402/go/legacy/pkg/coinbasefacilitator/facilitator.go lines 11-12 (https://api.cdp.coinbase.com + /platform/v2/x402)
- npm registry https://registry.npmjs.org/@x402/core -> dist-tags.latest = 2.26.0, published 2026-09-15T18:25:46Z (checked 2026-09-21)
- npm registry https://registry.npmjs.org/@x402/mcp -> dist-tags.latest = 2.26.0, published 2026-09-15T18:28:05Z (checked 2026-09-21)
- npm registry https://registry.npmjs.org/x402 (legacy v1 package) -> dist-tags.latest = 1.2.0, published 2026-04-16


## vercel-botid — PARTIALLY_CORRECT

Both sides are partly wrong, and both miss the decisive fact.

(1) PACKAGE AND SHAPE — claim is right but incomplete. The package is `botid` (npm, maintained by Vercel; latest 1.5.11, published 2026-03-03). Server import is `checkBotId` from `botid/server`. The four named fields are real, but the actual return type (verbatim from dist/server/index.d.ts in 1.5.11) is larger: `{ isHuman: boolean; isBot: boolean; isVerifiedBot: boolean; verifiedBotName: string | undefined; verifiedBotCategory: string | undefined; bypassed: boolean; classificationReason: string | undefined /* @deprecated */; responseHeaders?: {...} /* only when advancedOptions.returnResponseHeaders */ }`. The claim omits `isHuman` and `bypassed`; `verifiedBotName`/`verifiedBotCategory` are optional strings, so an implementer must not assume they are populated. Options are `checkBotId({ developmentOptions: { bypass, isDevelopment }, advancedOptions: { checkLevel, extraAllowedHosts, headers, returnResponseHeaders, vercelOidcToken } })`.

(2) DOES IT NEED initBotId()? — reviewer is directionally right, factually wrong on the mechanism. `initBotId()` monkey-patches `window.fetch` and `XMLHttpRequest.prototype.open/send`; for matching protected paths it fetches a challenge from `api.vercel.com/bot-protection/v1/challenge` (via the rewritten `/149e9513-.../a-4-a/c.js` path) and attaches `x-is-human`, `x-path`, `x-method` headers. Server-side, `checkBotId()` reads `x-is-human`. If that header is ABSENT (a bare crawler that never ran JS), BotID does NOT fail open and does NOT throw — it logs "Possible misconfiguration of Vercel BotId…" and still POSTs the request headers to `api.vercel.com/bot-protection/v1/is-bot?v=3`, which classifies from headers/IP/rDNS. So the reviewer's "cannot classify a bare server-to-server request" is FALSE: it can, coarsely, via the network-level path. What it loses is the Deep Analysis ML signal. Separately, in local dev (`NODE_ENV !== 'production'`) with no `developmentOptions.bypass`, it returns `{ isHuman: true, isBot: false, bypassed: true }` — it DOES fail open to HUMAN locally.

(3) THE DECISIVE FACT BOTH SIDES MISS — BotID cannot gate a bare HTTP GET of a page at all. The client instrumentation only patches `fetch` and `XMLHttpRequest`. A top-level document navigation is neither, so no `x-is-human` header can ever be attached to it. Vercel's docs confirm the same limitation for native HTML `<form method=POST action=...>` submissions ("not supported by BotID" — you must switch to `fetch`). `checkBotId()` also requires a Vercel request context and `VERCEL_OIDC_TOKEN` (it throws without it) and cannot run in middleware. Therefore BotID is architecturally a protector of API routes and server actions invoked from an already-loaded, already-instrumented page — NOT a gate for article/page reads. The claim that it is "the single enabling primitive for a free-for-humans / paid-for-agent-crawl publishing mode" is REFUTED: for `GET /article`, BotID is the wrong layer entirely.

(4) TIERS AND PRICE — verified-bot detection and Deep Analysis are different mechanisms. `checkLevel: 'basic' | 'deepAnalysis'` must match between `initBotId()` and `checkBotId()`. Basic validates challenge integrity/correctness and is free on all plans. Deep Analysis is Kasada-powered ML over client-side signals, runs only after Basic passes, and is billed at $1 per 1,000 checks. "Verified bot" identification is a separate, network-level mechanism: Vercel's verified bot directory (bots.fyi), built on published IP ranges, forward-confirmed reverse DNS, user-agent validation, and (per Vercel's "bot verification now supports Web Bot Auth" changelog) Web Bot Auth signatures. CAVEAT: Vercel's changelog frames the enriched bot context (source IP range, reverse DNS, UA validation) as something "developers using Deep Analysis now get", so do NOT plan on `verifiedBotName`/`verifiedBotCategory` being populated on the free Basic tier without testing it.

(5) THE JS-FREE ANSWER ON VERCEL is the WAF, not BotID: managed rulesets `ai_bots` (known AI crawlers — GPTBot, ClaudeBot, PerplexityBot, Bytespider; inactive/"Allow" by default; set to `log` or `deny`), `bot_filter` (catches UA-spoofing and header-omitting bots), `bot_protection` (non-browser traffic; GA at no additional cost; log or challenge), and `owasp`. Set via `vercel.security.updateFirewallConfig({ action: "managedRules.update", id: "ai_bots", value: { active: true, action: "deny" } })` or `vercel firewall rules add`. These evaluate at the edge on every request including top-level GETs.

(6) WEB BOT AUTH is the more reliable primitive for this use case, but it is not a finished standard. It is RFC 9421 HTTP Message Signatures plus a `Signature-Agent` header naming a key directory served at `/.well-known/http-message-signatures-directory`; Ed25519 keys; signature tagged `tag="web-bot-auth"`; `signature-agent` must itself be in the `Signature-Input` component list. Status as of 2026-09-21: IETF Internet-Drafts, NOT RFCs — `draft-meunier-web-bot-auth-architecture-02` and `draft-meunier-http-message-signatures-directory-03` (a `draft-meunier-webbotauth-registry-03` also exists), under the webbotauth effort. Implemented today by Cloudflare (`cf.bot_management.signed_agent`, Enterprise + Bot Management; the separate "signed agent" class was retired 2026-07-01 and folded into verified bots as Direct vs Intermediary in BotBase), Vercel, Akamai, Cloudflare Browser Run, Fingerprint, Stytch, and agent-browser vendors (Browserbase, Anchor Browser). Reference implementation: npm `web-bot-auth` 0.2.0 and `http-message-sig` 0.3.0 (github.com/cloudflare/web-bot-auth, published 2026-08-31). Test against `https://crawltest.com/cdn-cgi/web-bot-auth` (200 = verified, 401 = well-formed but unknown/failed key, 400 = malformed).

CORRECT LAYERED STRATEGY for distinguishing human from agent on a bare HTTP GET, most to least reliable:
1. Web Bot Auth signature verification (cryptographic proof of identity; covers only agents that choose to sign).
2. Verified-bot directory match: published IP ranges + forward-confirmed reverse DNS + stable UA (bots.fyi, Cloudflare BotBase). UA string alone is worthless; the rDNS/IP confirmation is what makes it sound.
3. Edge WAF managed rulesets (`ai_bots`, `bot_filter`, `bot_protection`) — JS-free, runs on the first request.
4. TLS/HTTP fingerprinting (JA3/JA4 — Vercel exposes `ja4` as a rate-limit key) and header-order heuristics — probabilistic.
5. Per-IP/ASN rate and behavioral heuristics — probabilistic.
6. JS-instrumented challenge (BotID Deep Analysis/Kasada, Turnstile) — only available AFTER a page has loaded and run JS; it can gate the second request, never the first.

NOT RELIABLY DETECTABLE, state this plainly in the plan: an agent driving a real headless browser that executes JS, presents a genuine browser TLS fingerprint, exits via residential IPs, and declines to sign is not distinguishable from a human at any layer. Nor is "agent fetching on behalf of a live human" distinguishable from "agent crawling for training" — that is declared intent, not an observable property of the request. A free-for-humans/paid-for-agents mode must therefore be built as a declared, incentivized contract (402 + a signed-agent payment/identity path, robots.txt and llms.txt directives, layers 1-3 as enforcement) that captures the honest majority, not as a detection problem that can be closed.

### Copy-paste snippet
```
// Install (npm package name is `botid`)
npm i botid

// --- Real return shape, verbatim from botid@1.5.11 dist/server/index.d.ts ---
declare const checkBotId: (config?: {
  developmentOptions?: {
    bypass?: 'HUMAN' | 'BAD-BOT' | 'GOOD-BOT' | 'ALLOWED' | undefined;
    isDevelopment?: boolean; // defaults to process.env.NODE_ENV !== 'production'
  };
  advancedOptions?: {
    checkLevel?: 'deepAnalysis' | 'basic';
    extraAllowedHosts?: string[];
    headers?: IncomingHttpHeaders;   // required for Next.js Pages Router
    returnResponseHeaders?: boolean;
    vercelOidcToken?: string;
  };
}) => Promise<{
  isHuman: boolean;
  isBot: boolean;
  isVerifiedBot: boolean;
  verifiedBotName: string | undefined;      // NOTE: optional
  verifiedBotCategory: string | undefined;  // e.g. 'ai_assistant', 'webhook', 'advertising'
  bypassed: boolean;
  /** @deprecated Reach out to Vercel support to get access to the classificationReason */
  classificationReason: string | undefined;
  responseHeaders?: { addHeaders?: {key:string;value:string}[]; addValuesToHeaders?: ...; replaceHeaders?: ... };
}>;

// --- Usage: ONLY works on fetch/XHR-invoked routes, never a top-level page GET ---
// instrumentation-client.ts
import { initBotId } from 'botid/client/core';
initBotId({ protect: [{ path: '/api/checkout', method: 'POST' }] });

// app/api/checkout/route.ts
import { checkBotId } from 'botid/server';
const { isBot, isVerifiedBot, verifiedBotName, verifiedBotCategory } = await checkBotId();

// === For gating a BARE HTTP GET (no JS), use the WAF managed ruleset instead ===
import { Vercel } from '@vercel/sdk';
const vercel = new Vercel({ bearerToken: process.env.VERCEL_TOKEN });
await vercel.security.updateFirewallConfig({
  projectId: 'your-project-id',
  teamId: 'your-team-id',
  requestBody: {
    action: 'managedRules.update',
    id: 'ai_bots',                    // 'owasp' | 'bot_protection' | 'ai_bots' | 'bot_filter'
    value: { active: true, action: 'deny' },  // 'deny' | 'log' | 'challenge'
  },
});

// === Web Bot Auth: what a signing agent actually sends (RFC 9421 + Signature-Agent) ===
// Verify these server-side against the agent's /.well-known/http-message-signatures-directory
Signature-Agent: "https://signature-agent.test"
Signature-Input: sig2=("@authority" "signature-agent")
  ;created=1735689600
  ;keyid="poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U"
  ;alg="ed25519"
  ;expires=1735693200
  ;nonce="e8N7S2MFd/qrd6T2R3tdfAuuANngKI7LFtKYI/vowzk4lAZYadIX6wW25MwG7DCT9RUKAJ0qVkU0mEeLElW1qg=="
  ;tag="web-bot-auth"
Signature: sig2=:jdq0SqOwHdyHr9+r5jw3iYZH6aNGKijYp/EstF4RQTQdi5N5YYKrD+mCT1HA1nZDsi6nJKuHxUi/5Syp3rLWBA==:

// Verification libs (Cloudflare, published 2026-08-31):
npm i web-bot-auth@0.2.0 http-message-sig@0.3.0
// Test your signing against: https://crawltest.com/cdn-cgi/web-bot-auth  (200 verified / 401 unknown key / 400 malformed)
```

### Caveats
- Verified as of 2026-09-21. botid@1.5.11 was published 2026-03-03, so it is ~6.5 months old — re-check `npm view botid dist-tags` before pinning; a `snapshot` tag (0.0.0-f3ef33f2-20260416071625) also exists and should not be used.
- vercel.com, bots.fyi, datatracker.ietf.org and nullpt.rs are all egress-blocked in this session. Vercel facts came from the Vercel MCP documentation tool (which returns only code snippets, not prose) plus the npm tarball I extracted and read directly; a few Vercel prose details (Basic free / Deep Analysis $1-per-1,000, ai_bots ruleset defaults, bots.fyi verification methods) rest on web-search summaries of Vercel docs and changelog pages rather than a direct page fetch. Treat the $1/1,000 figure and plan gating as needing a confirming look at https://vercel.com/docs/botid and https://vercel.com/pricing before anything is billed against them.
- Whether `verifiedBotName`/`verifiedBotCategory` are populated on the FREE Basic tier is not confirmed. Vercel's changelog attributes the enriched bot context (IP range, reverse DNS, UA validation) to Deep Analysis, which is the paid tier. Both fields are typed `string | undefined`. An implementing agent must test this on a real deployment before designing a paid/free split around it.
- The TypeScript return type is a union of a narrow branch ({isHuman, isBot, isVerifiedBot, bypassed}) and the wide branch. In several dev/bypass code paths the runtime returns only the narrow four fields, so `verifiedBotName` may be absent at runtime and TS may require narrowing. Do not destructure the wide fields unguarded.
- `checkBotId()` throws (not returns) if VERCEL_OIDC_TOKEN is missing or if there is no Vercel request context — it requires the OIDC option enabled in project settings, and it cannot run in Next.js middleware. Wrap it in try/catch and decide the failure policy explicitly.
- Web Bot Auth is an IETF Internet-Draft, NOT an RFC: draft-meunier-web-bot-auth-architecture-02, draft-meunier-http-message-signatures-directory-03, draft-meunier-webbotauth-registry-03. Draft numbers roll and header/parameter details can change between revisions. RFC 9421 (HTTP Message Signatures) underneath it IS a published RFC and is stable.
- Cloudflare retired the separate 'signed agent' classification on 2026-07-01 and folded it into verified bots with a Direct vs Intermediary metadata field. Code or rules written against cf.bot_management.signed_agent still work but are on a legacy path, and that field requires Cloudflare Enterprise with Bot Management.
- The Vercel `ai_bots` managed ruleset is inactive ('Allow') by default — enabling it is an explicit action, and it blocks by known-crawler identity, which a spoofing scraper evades. Pair it with `bot_filter` for UA-spoofers.
- Vercel's BotID challenge paths (/149e9513-01fa-4fb0-aad4-566afd725d1b/...) are hardcoded internal constants read out of the package bundle; they are implementation details Vercel can change and should be configured only through withBotId()/the documented vercel.json rewrites, never hand-copied.

### Evidence
- https://registry.npmjs.org/botid — dist-tags.latest = 1.5.11, time['1.5.11'] = 2026-03-03T21:48:08.148Z; maintainers include rauchg, vercel-release-bot; exports ./server, ./client, ./client/core, ./next/config, ./nuxt
- botid-1.5.11.tgz → package/dist/server/index.d.ts (extracted locally) — full checkBotId signature and return union incl. isHuman, bypassed, classificationReason (@deprecated), responseHeaders; Config = { developmentOptions: { bypass, isDevelopment }, advancedOptions: { checkLevel, extraAllowedHosts, headers, returnResponseHeaders, vercelOidcToken } }
- botid-1.5.11.tgz → package/dist/server/index.js — reads t['x-is-human']; when absent logs 'Possible misconfiguration of Vercel BotId'; still POSTs to https://api.vercel.com/bot-protection/v1/is-bot?v=3; dev path returns {isHuman:!0,isBot:!1,isVerifiedBot:!1,bypassed:!0}; throws 'VERCEL_OIDC_TOKEN is not set' and 'Must be deployed on Vercel to access response headers'
- botid-1.5.11.tgz → package/dist/client/core/index.js — patches window.fetch and XMLHttpRequest.prototype.open/send only; sets x-is-human, x-path, x-method; loads Kasada KPSDK p.js for deepAnalysis; challenge path /149e9513-01fa-4fb0-aad4-566afd725d1b/2d206a39-8ed7-437e-a3be-862e0f06eea3/a-4-a/c.js
- https://vercel.com/docs/botid/verified-bots (via Vercel MCP search_vercel_documentation) — destructures { isBot, verifiedBotName, isVerifiedBot, verifiedBotCategory }; chatgpt-operator example
- https://vercel.com/docs/botid/get-started (via Vercel MCP) — install `npm i botid`, withBotId(nextConfig), initBotId in instrumentation-client.ts, vercel.json rewrites to api.vercel.com/bot-protection/v1/challenge and /proxy/
- https://vercel.com/docs/botid/form-submissions (via Vercel MCP) — 'Traditional HTML Form (Not Supported by BotID)'; must use fetch
- https://vercel.com/docs/botid/advanced-configuration (via Vercel MCP) — checkLevel 'deepAnalysis' | 'basic' must match client and server
- https://vercel.com/docs/botid — Basic free on all plans; Deep Analysis powered by Kasada, $1 per 1,000 checks, runs only after Basic passes
- https://vercel.com/docs/rest-api/sdk/examples/firewall-management (via Vercel MCP) — managedRules.update with id 'owasp' | 'bot_protection' | 'ai_bots' | 'bot_filter', action deny|log|challenge
- https://vercel.com/changelog/new-one-click-ai-bot-managed-ruleset and https://vercel.com/docs/vercel-firewall/vercel-waf/managed-rulesets — ai_bots ruleset, inactive by default, log or deny, list maintained by Vercel
- https://vercel.com/changelog/vercel-botid-now-leverages-vercels-verified-bot-directory — bots.fyi directory; Deep Analysis users get source IP range, reverse DNS, user-agent validation context
- https://vercel.com/changelog/vercels-bot-verification-now-supports-web-bot-auth
- https://developers.cloudflare.com/bots/reference/bot-verification/web-bot-auth/ (via Cloudflare MCP) — cites draft-meunier-http-message-signatures-directory-03 and draft-meunier-web-bot-auth-architecture-02; exact Signature-Agent/Signature-Input/Signature example; crawltest.com/cdn-cgi/web-bot-auth 200/401/400 semantics; dateModified 2026-07-01
- https://developers.cloudflare.com/bots/concepts/bot/verified-bots/ (via Cloudflare MCP) — verification via Web Bot Auth signature, published IP list with stable UA, or reverse DNS; Direct vs Intermediary in BotBase as of 2026-07-01
- https://developers.cloudflare.com/ruleset-engine/rules-language/fields/reference/cf.bot_management.signed_agent/ — Boolean, requires Enterprise + Bot Management
- https://developers.cloudflare.com/glossary/ — 'signed agent' classification retired July 1, 2026
- https://registry.npmjs.org/web-bot-auth — latest 0.2.0, published 2026-08-31, repo github.com/cloudflare/web-bot-auth
- https://registry.npmjs.org/http-message-sig — latest 0.3.0, published 2026-08-31, 'HTTP Message Signatures defined by RFC 9421'
- https://datatracker.ietf.org/doc/draft-meunier-webbotauth-registry/ — draft-meunier-webbotauth-registry-03 (Internet-Draft, not RFC)


## webmcp-api — PARTIALLY_CORRECT

WebMCP is real and the core of the claim is right, but two details are stale/overstated.

(1) SPEC — CONFIRMED. WebMCP is a Web Machine Learning Community Group draft. Primary evidence: the Bikeshed source at https://raw.githubusercontent.com/webmachinelearning/webmcp/main/index.bs declares verbatim `Title: WebMCP`, `Shortname: webmcp`, `Status: CG-DRAFT`, `Group: webml`, `URL: https://webmachinelearning.github.io/webmcp`, editors Brandon Walderman (Microsoft), Khushal Sagar and Dominic Farolino (Google). `w3c.json` in the repo root reads `{"group":[110166],"contacts":["anssiko"],"repo-type":"cg-report"}` — a CG report, i.e. NOT W3C standards track. Correct as claimed. (Repo HEAD checked: f5645e9, 2026-09-17.)

(2) API SURFACE — CONFIRMED, with a sharper history than the claim states. The spec IDL is:
  partial interface Document { [SecureContext, SameObject] readonly attribute ModelContext modelContext; };
  [Exposed=Window, SecureContext] interface ModelContext : EventTarget {
    Promise<undefined> registerTool(ModelContextTool tool, optional ModelContextRegisterToolOptions options = {});
    Promise<sequence<RegisteredTool>> getTools(optional ModelContextGetToolOptions options = {});
    Promise<DOMString> executeTool(RegisteredTool tool, optional any inputObject, optional ModelContextExecuteToolOptions options = {});
    attribute EventHandler ontoolchange; attribute EventHandler ontoolactivated; attribute EventHandler ontoolcancel;
  };
The strings "navigator" and "provideContext" appear ZERO times in the current index.bs and README.md. The claim that navigator.modelContext is the older surface is confirmed by repo git history: commit c7b5c70, 2026-05-27, "Move the `modelContext` getter to `Document` (#184)". Before that commit index.bs had `partial interface Navigator` and — importantly — `undefined registerTool(...)`, i.e. SYNCHRONOUS. After the move registerTool returns `Promise<undefined>`. So an implementer copying old navigator-era sample code gets both the wrong object AND a missing await.
Where the claim overstates: "an older surface some providers still expose" is now largely false in Chrome. Chrome's deprecation message ("navigator.modelContext is deprecated as of Chrome 150.0.7861.0") and multiple third-party migration PRs say it was deprecated at Chrome 150 and removed in the low 150s (sources conflict: 152 vs 153). Chrome stable on 2026-09-21 is 153.x, so a `document.modelContext || navigator.modelContext` fallback branch is dead code on current Chrome. Do not write the fallback.

(3) ORIGIN TRIAL — PARTIALLY CORRECT (stale framing). Primary source https://raw.githubusercontent.com/webmachinelearning/webmcp/main/implementation-status.md states: Chrome — "An Origin Trial is live in Chrome 149"; Edge — "An Origin Trial is live in Edge 150" (trial id 0b76fe60-b266-458e-a285-04e375c0c31a). Chromium's runtime_enabled_features.json5 (line ~7096) independently confirms a real trial: `name: "WebMCP"`, `origin_trial_feature_name: "WebMCP"`, `origin_trial_allows_third_party: true`, `status: "experimental"`, with sibling flags WebMCPTesting / WebMCPDeclarativeFileInput / WebMCPFormAssociatedCustomElements. Chromium use counters kModelContextRegisterTool/kModelContextGetTools/kModelContextExecuteTool exist. BUT 149/150 are the milestones the trials STARTED at, not "the current versions" — Chrome stable is 153 as of 2026-09-21 (Chrome moved to a two-week cadence at 153 on 2026-09-08). The trial's end (reported as through Chrome 156, expiring 2026-11-16/17) could NOT be verified from primary sources: chromestatus.com, developer.chrome.com, groups.google.com, developer.microsoft.com and developer.mozilla.org are all blocked by this environment's egress proxy. Treat the end date as unverified. The repo also documents the local-dev flag as `about:flags#enable-webmcp-testing`.
Also unverified: whether an MDN entry exists (developer.mozilla.org unreachable here; nothing surfaced in search). Assume no stable MDN compat data.

(4) FEATURE DETECTION — the explainer and spec contain NO feature-detection snippet (grepped both for "feature detect", "in document", "progressive", "fallback" — zero hits). Any pattern is derived, not quoted. The correct derivation from the IDL: the attribute is [SecureContext, Exposed=Window], so `'modelContext' in document` is false on http:// origins, in workers, and without the trial token — which is exactly the guard you want. registerTool is async and rejects with NotAllowedError when blocked by `Permissions-Policy: tools=()` or the iframe `allow` attribute, and also rejects on duplicate name / empty name or description / invalid inputSchema, so it must be awaited inside try/catch. Unregistration is by aborting the AbortSignal passed in options; `toolchange` fires on document.modelContext.

WHAT A PLAN MAY COMMIT TO: the CG-DRAFT status; document.modelContext as the only API surface; the three method signatures and their Promise return types; AbortSignal-based unregistration; the NotAllowedError/Permissions-Policy behavior; that Chrome and Edge origin trials exist and started at Chrome 149 / Edge 150. TREAT AS SPECULATIVE: any exact trial end date or end milestone; the exact Chrome milestone where navigator.modelContext was removed; MDN coverage; and anything about shipping-by-default. The plan should instruct the agent to feature-detect and degrade gracefully rather than pin a Chrome version.

### Copy-paste snippet
```
// Correct progressive enhancement for WebMCP (verified against index.bs @ f5645e9).
// document.modelContext is [SecureContext, SameObject] on Document; ModelContext is
// [Exposed=Window, SecureContext]. So this guard is false on http://, in workers,
// and when the origin-trial token is absent -- which is what you want.
// Do NOT add a `|| navigator.modelContext` fallback: that was the pre-2026-05-27
// spec surface (its registerTool was synchronous) and Chrome deprecated it at 150.
async function registerAgentTools() {
  if (!('modelContext' in document)) return; // no WebMCP: leave the normal UI alone
  const controller = new AbortController();
  try {
    await document.modelContext.registerTool({
      name: "add-todo",
      description: "Add a new item to the user's active todo list",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "The text content of the todo item" }
        },
        required: ["text"]
      },
      async execute({ text }) {
        // Reuse existing client-side application logic and update UI.
        await addTodoItemToCollection(text);
        return {
          content: [{ type: "text", text: `Added todo item: "${text}" successfully.` }]
        };
      }
    }, { signal: controller.signal });
  } catch (err) {
    // NotAllowedError => blocked by `Permissions-Policy: tools=()` or the iframe
    // `allow` attribute. Also rejects on duplicate name, empty name/description,
    // or invalid inputSchema. Never let this break the human-facing page.
    console.warn('WebMCP tool registration skipped:', err);
    return;
  }
  // controller.abort() unregisters the tool.
  return controller;
}
```

### Caveats
- Verified 2026-09-21 against webmcp repo HEAD f5645e9 (2026-09-17). This is a CG-DRAFT under active churn - the modelContext getter already moved from Navigator to Document on 2026-05-27, and ToolActivatedEvent/ToolCancelEvent landed four days before HEAD. Pin the plan to a commit, not to 'the spec'.
- CG-DRAFT means Community Group report, explicitly not W3C standards track and not a Recommendation. Firefox (mozilla/standards-positions#1412) and WebKit (WebKit/standards-positions#670) positions are open, not positive - assume Chromium-only for now.
- 'Chrome 149 / Edge 150' are the milestones where the origin trials STARTED, not current versions. Chrome stable is 153.x as of 2026-09-21 (two-week cadence began at 153 on 2026-09-08). Phrasing the plan as 'it is in Chrome 149' will mislead the implementing agent.
- The trial end (reported as Chrome 156 / 2026-11-16 or 17) is SECONDARY-SOURCE ONLY. chromestatus.com, developer.chrome.com, groups.google.com and developer.microsoft.com are all blocked by this environment's egress proxy, so no primary confirmation. The trial may expire during the implementation window - the code must degrade gracefully when document.modelContext vanishes.
- The exact Chrome milestone that REMOVED navigator.modelContext is unconfirmed - secondary sources disagree (152 vs 153). Irrelevant if you follow the advice above and never reference navigator.modelContext.
- Origin trial participation requires serving an Origin-Trial response header token obtained from the Chrome origin trials console; local development uses the about:flags#enable-webmcp-testing flag (per implementation-status.md). Neither is optional - without one the feature detect returns false.
- No MDN entry could be verified (developer.mozilla.org unreachable from this environment, nothing in search results). Do not plan around MDN compat data.
- registerTool/getTools/executeTool all return Promises in the current spec; the pre-move navigator-era registerTool returned undefined synchronously. Any sample code the agent finds online that does not await registerTool is from the old surface.
- The npm package webmcp-types exists (latest 0.1.9, published 2026-09-17) and is referenced from the README, but it is a community types package at 0.x - version-pin it if used.
- There is also a declarative HTML-form-based API (declarative-api-explainer.md) alongside the imperative one; the claim only covers the imperative surface.

### Evidence
- https://raw.githubusercontent.com/webmachinelearning/webmcp/main/index.bs (metadata block: Title: WebMCP / Shortname: webmcp / Status: CG-DRAFT / Group: webml / URL: https://webmachinelearning.github.io/webmcp; IDL at ~lines 597 and 616)
- https://raw.githubusercontent.com/webmachinelearning/webmcp/main/w3c.json ({"group":[110166],"contacts":["anssiko"],"repo-type":"cg-report"})
- https://raw.githubusercontent.com/webmachinelearning/webmcp/main/README.md (Detailed Design: 'WebMCP introduces an imperative API on the web platform under `document.modelContext`'; add-todo registerTool example; getTools/executeTool/toolchange sections)
- https://raw.githubusercontent.com/webmachinelearning/webmcp/main/implementation-status.md (Chrome: 'An Origin Trial is live in Chrome 149'; Edge: 'An Origin Trial is live in Edge 150', trial 0b76fe60-b266-458e-a285-04e375c0c31a; flag about:flags#enable-webmcp-testing; Firefox mozilla/standards-positions#1412; WebKit standards-positions#670)
- git clone https://github.com/webmachinelearning/webmcp — HEAD f5645e9 (2026-09-17); commit c7b5c70 (2026-05-27) 'Move the `modelContext` getter to `Document` (#184)'; `git show c7b5c70^:index.bs` shows the prior `partial interface Navigator` and a synchronous `undefined registerTool(...)`
- https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/platform/runtime_enabled_features.json5 (line ~7096: name: "WebMCP", origin_trial_feature_name: "WebMCP", origin_trial_allows_third_party: true, status: "experimental")
- https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/public/mojom/use_counter/metrics/web_feature.mojom (kModelContextRegisterTool=5791, kModelContextGetTools=5904, kModelContextExecuteTool=5943)
- https://registry.npmjs.org/webmcp-types (exists; dist-tags.latest = 0.1.9, 10 versions, created 2026-07-06, modified 2026-09-17)
- BLOCKED BY EGRESS PROXY, could not verify directly: chromestatus.com/feature/5117755740913664, developer.chrome.com/docs/ai/webmcp, developer.chrome.com/blog/ai-webmcp-origin-trial, groups.google.com blink-dev Intent to Experiment, developer.microsoft.com Edge origin trial page, developer.mozilla.org, webmachinelearning.github.io


## postiz-api — PARTIALLY_CORRECT

Verified against gitroomhq/postiz-app main @ 450f0b44865f609c595187d53ecffe75f9cc9960 ("fix(sentry): reduce tracesSampleRate…", 2026-09-21), freshly fetched today 2026-09-21. Clone lives at /tmp/claude-0/-home-user-mog/fd320bdb-4628-5b5d-a380-543979d8bc42/scratchpad/postiz-app. NOTE: the pre-existing clone was stale (7cef69c, 2026-09-20) and origin/main had been force-updated; I reset to the real current main before verifying.

== PER-CLAIM VERDICTS ==

(1) CONFIRMED (all parts).
  - version.txt = "v1.47.0" (single line).
  - pnpm workspace, NOT Nx: pnpm-workspace.yaml lists `apps/*` and `libraries/*`; package.json:12 `"packageManager": "pnpm@10.6.1"`. There is NO nx.json anywhere in the repo (`ls nx.json` -> not found) and no @nx/* dependency. jest.preset.js / eslint config are leftovers, not Nx wiring.
  - NestJS 11: package.json:74-75 `"@nestjs/common": "^11.1.21"`, `"@nestjs/core": "^11.1.21"`.
  - Next.js 16: package.json:193 `"next": "16.3.1"` (also pinned in pnpm overrides at package.json:329).
  - Temporal worker at apps/orchestrator: package.json:96-100 `@temporalio/{activity,client,common,worker,workflow}: ^1.14.0`; apps/orchestrator/src/{main.ts,app.module.ts,activities/,workflows/,signals/}. Workflows are VERSIONED FILES: apps/orchestrator/src/workflows/post-workflows/post.workflow.v1.0.1.ts … v1.0.5.ts (plus autopost, clipping, digest.email, generate.video, missing.post, process.media, refresh.token, send.email, streak).
  - BullMQ fully removed: zero case-insensitive matches for "bullmq" in any .ts/.tsx/.json outside node_modules.
  - Prisma 6.x on Postgres: package.json:84 `"@prisma/client": "6.5.0"`, :309 `"prisma": "6.5.0"`; scripts pin `prisma@6.5.0` against libraries/nestjs-libraries/src/database/prisma/schema.prisma.
  - Workspace packages: apps/{backend,commands,extension,frontend,orchestrator,sdk} + libraries/{helpers,nestjs-libraries,react-shared-libraries}. Node engine ">=22.12.0 <23.0.0" (package.json:10).

(2) CONFIRMED. package.json:6 `"license": "AGPL-3.0"`; LICENSE is the verbatim 661-line GNU AGPL v3 text. No /ee/ directory, no enterprise/commercial-license carve-out anywhere in LICENSE or README.md.

(3) CONFIRMED. apps/backend/src/public-api/routes/v1/public.integrations.controller.ts:57 `@Controller('/public/v1')`. Auth is apps/backend/src/services/auth/public.auth.middleware.ts, wired in apps/backend/src/public-api/public.api.module.ts:36 (`consumer.apply(PublicAuthMiddleware).forRoutes(PublicIntegrationsController)`). The middleware reads `req.headers.authorization` RAW (lines 24-25) and passes the WHOLE header value straight to `getOrgByApiKey(auth)` (line 48) -> organization.repository.ts:55-59 does `findFirst({ where: { apiKey: api } })`. There is NO "Bearer " strip anywhere, so a `Bearer ` prefix makes the lookup FAIL. Confirmed by the first-party SDK: apps/sdk/src/index.ts:27,40,68,80,91 all send `Authorization: this._apiKey`.
  Extra facts worth putting in the plan:
  - A token starting with `pos_` is routed to the OAuth-app path instead (public.auth.middleware.ts:32-46, `_oauthService.getOrgByOAuthToken`).
  - Optional headers: `x-postiz-org` (super-admin org override, 403 unless canUseSuperAdminApi and not an OAuth app; lines 72-100) and `x-postiz-include-deleted: true` (line 66).
  - If `STRIPE_SECRET_KEY` is set and the org has no subscription -> 401 "No subscription found" (lines 57-62).
  - `MCP_ONLY=true` unregisters the whole public REST controller (public.api.module.ts:18).

(4) *** REFUTED ***. The limit is 90 per hour, not 30 posts/hour, and there is NO named constant — it is an inline literal with an env override.
  apps/backend/src/app.module.ts:35-43:
      ThrottlerModule.forRoot({
        throttlers: [ { ttl: 3600000, limit: process.env.API_LIMIT ? Number(process.env.API_LIMIT) : 90 } ],
        storage: new ThrottlerStorageRedisService(ioRedis),
      })
  So: ttl = 3600000 ms (1 hour), default limit = 90, overridable by the env var `API_LIMIT`. Backed by Redis (@nest-lab/throttler-storage-redis), so the counter is shared across backend instances.
  Scope: libraries/nestjs-libraries/src/throttler/throttler.provider.ts:11 — ThrottlerBehindProxyGuard (registered as a global APP_GUARD at app.module.ts:49-51) returns true (NO throttling) for everything except `method === 'POST' && url.includes('/public/v1/posts')`. Tracker key = `${org.id}_posts` (throttler.provider.ts:21-23). There are NO `@Throttle()` decorators anywhere in public.integrations.controller.ts.
  The only place `30 / 3600000` appears in the repo is an unrelated auth route: apps/backend/src/api/routes/auth.controller.ts:294 `@Throttle({ default: { limit: 30, ttl: 3600000 } })` — that is almost certainly where the "30/hour" number came from. Do not use it for the public API.
  A second guard exists but is not the post limiter: ThrottlerRealIpGuard (throttler.provider.ts:29-37), keyed by the first x-forwarded-for hop, used route-level on public endpoints.

(5) PARTIALLY_CORRECT. Count is right; the method list is incomplete and mis-states which members are required.
  - Count: 36 *.provider.ts files in libraries/nestjs-libraries/src/integrations/social/, and exactly 35 ACTIVE registrations in `socialIntegrationList` at libraries/nestjs-libraries/src/integrations/integration.manager.ts:42-79 (MastodonCustomProvider is commented out at line 78). So "~35" is correct — say 35.
  - Interface file: libraries/nestjs-libraries/src/integrations/social/social.integrations.interface.ts. `SocialProvider extends IAuthenticator, ISocialMediaIntegration` (line 162).
  - REQUIRED and named in the claim: authenticate (:9), refreshToken (:17), generateAuthUrl (:23), post (:85), maxLength (:171, signature `(additionalSettings?: any, settings?: any) => number`), checkValidity (:172).
  - OPTIONAL, contrary to the claim: comment? (:99), analytics? (:26), postAnalytics? (:31). Also optional: reConnect?, changeNickname?, changeProfilePicture?, missing?, postPending?, mention?, mentionFormat?, fetchPageInformation?, customFields?, externalUrl?, stripLinks?, refreshCron?, refreshWait?, convertToJPEG?, isWeb3?, isChromeExtension?, extensionCookies?, oneTimeToken?, dto?, toolTip?.
  - REQUIRED but MISSING from the claim (a new provider must satisfy these or the build breaks): `identifier: string` (:165), `name: string` (:205), `isBetweenSteps: boolean` (:208), `scopes: string[]` (:209), `editor: 'none'|'normal'|'markdown'|'html'` (:194), `checkPostStatus` (:177), `finalizePost` (:186), `migrationMatch` (:182).
  - In practice you extend `SocialAbstract` (libraries/nestjs-libraries/src/integrations/social.abstract.ts), which supplies defaults for checkValidity (:163-169, returns true), checkPostStatus (:181-192, throws BadBody), finalizePost (:195+, throws) and migrationMatch (:145-150, matches on username === integration.profile). So the real minimum to write is: identifier, name, isBetweenSteps, scopes, editor, maxLength, authenticate, refreshToken, generateAuthUrl, post.
  - Async-post contract worth reading before writing anything video-ish: PostResponse.status === 'pending' means the Temporal workflow polls checkPostStatus until 'ready' then calls finalizePost; the idempotency contract is spelled out in social.integrations.interface.ts:117-131.

(6) CONFIRMED. libraries/nestjs-libraries/src/chat/start.mcp.ts: `app.use('/mcp', ...)` at :319 and `app.use('/mcp/:id', ...)` at :369 (the :id is the org API key — :382 `getOrgByApiKey(req.params.id)`, 400 "Invalid API Key" otherwise). OAuth surface: authorization_endpoint `${FRONTEND_URL}/oauth/authorize` (:168), token_endpoint `${backendUrl}/oauth/token` (:169), registration_endpoint `${backendUrl}/oauth/register` (DCR, :171); RFC 8414 metadata at /.well-known/oauth-authorization-server (:239), /.well-known/oauth-protected-resource (:225), /.well-known/openid-configuration (:259), plus /.well-known/openai-apps-challenge (:219). Separate resource servers per client family: /mcp-oauth-chatgpt (:208), /mcp-oauth (:210), /mcp-oauth-claude (:212), /mcp-oauth-dynamic (:215). Supporting files: libraries/nestjs-libraries/src/chat/oauth-middleware.ts, oauth-types.ts, auth.context.ts, load.tools.service.ts, tools/*.

(7) PARTIALLY_CORRECT. The file exists but is 200 lines, not ~130, and it is NOT a complete 1:1 model.
  libraries/nestjs-libraries/src/integrations/social/moltbook.provider.ts, 200 lines. `class MoltbookProvider extends SocialAbstract implements SocialProvider` (:14). It defines only: maxConcurrentJob=100 (:15), identifier='moltbook' (:16), name='Moltbook' (:17), isBetweenSteps=false (:18), scopes=[] (:19), isWeb3=true (:20), editor='normal' (:21), maxLength()=>300 (:23-25), refreshToken (no-op stub, :27-37), generateAuthUrl (returns a makeId(6) state, :39-46), registerAgent (:48), checkAgentStatus (:62), getAgentProfile (:73), authenticate (API key IS the `code`, :88-106), post (:108-153), comment (:155-199). It does NOT implement checkValidity, analytics, postAnalytics, checkPostStatus or finalizePost — it inherits SocialAbstract's defaults. It uses `this.getSsrfSafeAxios()` for all outbound calls and (unlike the Postiz public API itself) sends `Authorization: Bearer ${apiKey}` to moltbook.com.
  Copying the .ts file alone is NOT enough. A new provider must also be wired into these 8 further files, which is exactly what moltbook touches:
    libraries/nestjs-libraries/src/integrations/integration.manager.ts        (add `new MusebookProvider(),` to socialIntegrationList, ~line 73)
    libraries/nestjs-libraries/src/dtos/posts/providers-settings/moltbook.dto.ts        -> musebook.dto.ts
    libraries/nestjs-libraries/src/dtos/posts/providers-settings/all.providers.settings.ts (register the DTO)
    apps/backend/src/api/routes/integrations.controller.ts                    (moltbook has a bespoke API-key connect branch)
    apps/frontend/src/components/new-launch/providers/moltbook/moltbook.provider.tsx     (incl. `maximumCharacters: 300` at :34 — a SECOND copy of the limit)
    apps/frontend/src/components/new-launch/providers/show.all.providers.tsx
    apps/frontend/src/components/launches/web3/providers/moltbook.provider.tsx
    apps/frontend/src/components/launches/web3/web3.list.tsx

== REAL PER-PLATFORM CONTENT CONSTRAINTS ENFORCED BY THE CODE ==

How they are enforced: libraries/nestjs-libraries/src/database/prisma/posts/posts.service.ts `validatePosts()` (:779-872). It runs the provider's class-validator DTO (:822-831), then `provider.checkValidity(media, settings, additionalSettings)` (:836-840), then `provider.maxLength(additionalSettings, settings)` (:845) compared against `countLength(providerIdentifier, strippedHtml)` (:853-857). Empty = no text AND no media (:847-851).

CHARACTER COUNTING IS NOT uniform — libraries/helpers/src/utils/count.length.ts:41-51:
  - identifier 'x'       -> twitter-text `parseTweet().weightedLength` (URLs count as 23, CJK weight 2)
  - identifier 'threads' -> `new TextEncoder().encode(text).length` (UTF-8 BYTES, not chars)
  - everything else      -> plain JS `text.length` (UTF-16 code units). Note Bluesky is therefore counted in code units, not the 300 graphemes Bluesky itself uses.

Character limits — all from `maxLength()` in libraries/nestjs-libraries/src/integrations/social/:
  x/twitter   280 default; 4000 if the integration's additionalSettings has a truthy entry titled 'Verified'; 100000 when settings.post_type === 'article'  [x.provider.ts:93-105]
  linkedin    3000   [linkedin.provider.ts:77-79]  (linkedin.page.provider.ts defines no maxLength -> inherits/behaves as the page provider's own; it has no override)
  instagram   2200   [instagram.provider.ts:47-49; instagram.standalone.provider.ts:42-44]
  tiktok      2000   [tiktok.provider.ts:49-51]  / tiktok-business 2200 [tiktok.business.provider.ts:53-56, comment notes photos allow 4000]
  youtube     5000   [youtube.provider.ts:75-77]
  threads     500    [threads.provider.ts:37-39]  (counted in UTF-8 bytes)
  bluesky     300    [bluesky.provider.ts:244-246]
  mastodon    500    [mastodon.provider.ts:40-42]
  reddit      10000  [reddit.provider.ts:64-66]
  farcaster   800    [farcaster.provider.ts:52-54]  *** identifier is 'wrapcast', NOT 'farcaster' (farcaster.provider.ts:45); display name is 'Farcaster'; frontend folder is providers/warpcast/ ***
  discord     1980   [discord.provider.ts:21-23]  (editor = 'markdown')
  telegram    4096   [telegram.provider.ts:29-31]  (editor = 'html')
  pinterest   500    [pinterest.provider.ts:65-67]

Media / structural rules — from `checkValidity()`:
  x/twitter   Only checked when settings.post_type === 'article': no .mp4 allowed ("X articles only support images"); a draft article (article_status !== 'published') may not have thread replies. [x.provider.ts:120-143]. The 4-media cap is NOT validated up front — it only surfaces as a mapped API error ("maximum of 4 items", x.provider.ts:170-174).
  linkedin    carousel (post_as_images_carousel) requires >= 2 images and no video; with a video, max 1 media total; COMMENTS MUST BE TEXT-ONLY. [linkedin.provider.ts:81-105]
  instagram   >= 1 media required; carousel max 10 media; trial reel = exactly 1 video; settings.audio only on a single-video Reel, never on a story. [instagram.provider.ts:51-87]. instagram.standalone has no 10-media cap, just >=1 media + trial-reel rules [instagram.standalone.provider.ts:46-65].
  tiktok      >= 1 media; multiple items => images only; a video must be the single item; every image must have min(width,height) <= 1080px, enforced via sharp getImageDimensions ("TikTok allows a maximum of 1080px on the shorter side"). [tiktok.provider.ts:53-88]. tiktok-business: same, plus max 35 pictures [tiktok.business.provider.ts:71-93]. TikTokDto title @MaxLength(90) [dtos/posts/providers-settings/tiktok.dto.ts:73].
  youtube     exactly 1 media and it MUST be an .mp4. [youtube.provider.ts:79-90]. YoutubeSettingsDto: title MinLength(2)/MaxLength(100); tags combined <= YOUTUBE_TAGS_MAX_LENGTH = 500 chars, where a tag containing whitespace costs +2 (quoting) [dtos/posts/providers-settings/youtube.settings.dto.ts:22-29, 66-91].
  threads     NO checkValidity override (inherits SocialAbstract's `return true`). Carousel/child-container logic lives in post()/checkPostStatus (threads.provider.ts:257,301,450,515-560) but imposes no validated cap.
  bluesky     max 1 video per post; max 4 pictures per post; applies to the main post AND every comment. [bluesky.provider.ts:248-265]
  mastodon    NO checkValidity override — no media rules enforced.
  reddit      a subreddit entry of type 'media' requires exactly 1 media file; any .mp4 must carry a thumbnail. [reddit.provider.ts:68-89]. RedditSettingsDtoInner: subreddit MinLength(2), title MinLength(2) (no max), type in ['self','link','media'], url @IsUrl when type==='link' [dtos/posts/providers-settings/reddit.dto.ts:26-58].
  farcaster   IMAGES ONLY — any .mp4 in the post or any comment is rejected ("Can only accept images"). [farcaster.provider.ts:57-68]
  discord     NO checkValidity override — no media rules enforced.
  telegram    NO checkValidity override. post() branches: 0 media -> text message; 1 media -> photo/video/document with the text as caption; >1 -> media group. [telegram.provider.ts:141-206]
  pinterest   >= 1 media; max 5 media; a video REQUIRES exactly 2 items (video + cover image as the second); with a video you may not exceed 2 items; multiple images must ALL share identical width and height (sharp-measured). [pinterest.provider.ts:71-108]. PinterestSettingsDto: title @MaxLength(100), board required [dtos/posts/providers-settings/pinterest.dto.ts:6-33].

VIDEO LENGTH AND ASPECT RATIO: NOT ENFORCED ANYWHERE. social.abstract.ts:160-161 states it outright — "video-duration validations that used to run in the browser are not re-implemented here (no ffmpeg dependency). Image-dimension checks use sharp." The only aspect-ratio strings in the codebase are reactive error mappings of Meta's responses in instagram.provider.ts:292 and :329 ("Aspect ratio not supported, must be between 4:5 to 1.91:1") and :344 ("Invalid Instagram image resolution max: 1920x1080px") — inside handleErrors, i.e. after the post already failed. Do not describe these as pre-flight validation.

TRAP FOR THE IMPLEMENTING AGENT: every character limit exists TWICE — backend `maxLength()` and a frontend `maximumCharacters` in apps/frontend/src/components/new-launch/providers/<name>/<name>.provider.tsx (bluesky:19=300, discord:25=1980, linkedin:46=3000, mastodon:13=500, pinterest:37=500, reddit:217=10000, telegram:13=4096, threads:18=500, tiktok:390=2000, warpcast:66=800, youtube:90=5000, instagram at instagram.collaborators.tsx:120=2200, moltbook:34=300; x is a function at x/x.provider.tsx:142-147 returning 4000/280). A new provider must set both or the editor counter disagrees with server validation.

### Copy-paste snippet
```
// --- 1. Public API auth: RAW header, NO "Bearer " (apps/sdk/src/index.ts:27) ---
curl -X POST "$POSTIZ_URL/public/v1/posts" \
  -H "Authorization: $POSTIZ_API_KEY" \
  -H "Content-Type: application/json" -d '{...}'
// A "Bearer " prefix breaks it: public.auth.middleware.ts:48 feeds the whole
// header value into findFirst({ where: { apiKey: api } }) with no stripping.
// Tokens beginning with "pos_" are routed to the OAuth-app path instead.

// --- 2. The REAL rate limit (apps/backend/src/app.module.ts:35-43) ---
ThrottlerModule.forRoot({
  throttlers: [
    { ttl: 3600000, limit: process.env.API_LIMIT ? Number(process.env.API_LIMIT) : 90 },
  ],
  storage: new ThrottlerStorageRedisService(ioRedis),
})
// 90/hour (NOT 30), env var API_LIMIT, Redis-backed, and it only applies to
// POST /public/v1/posts (throttler.provider.ts:11), keyed `${org.id}_posts`.

// --- 3. Minimum viable new provider (model: moltbook.provider.ts) ---
// libraries/nestjs-libraries/src/integrations/social/musebook.provider.ts
import {
  AuthTokenDetails, PostDetails, PostResponse, SocialProvider,
} from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';
import { SocialAbstract } from '@gitroom/nestjs-libraries/integrations/social.abstract';
import { makeId } from '@gitroom/nestjs-libraries/services/make.is';
import { Integration } from '@prisma/client';
import dayjs from 'dayjs';

const MUSEBOOK_API_BASE = 'https://www.musebook.com/api/v1';

export class MusebookProvider extends SocialAbstract implements SocialProvider {
  override maxConcurrentJob = 100;
  identifier = 'musebook';          // REQUIRED
  name = 'Musebook';                // REQUIRED
  isBetweenSteps = false;           // REQUIRED
  scopes = [] as string[];          // REQUIRED
  isWeb3 = true;                    // API-key connect flow (no OAuth redirect)
  editor = 'normal' as const;       // REQUIRED: 'none'|'normal'|'markdown'|'html'

  maxLength() { return 300; }       // REQUIRED

  async refreshToken(refreshToken: string): Promise<AuthTokenDetails> {
    return { refreshToken: '', expiresIn: 0, accessToken: '', id: '', name: '', picture: '', username: '' };
  }
  async generateAuthUrl() {
    const state = makeId(6);
    return { url: state, codeVerifier: makeId(10), state };
  }
  async authenticate(params: { code: string; codeVerifier: string; refresh?: string }) {
    const apiKey = params.code;                       // the API key arrives as `code`
    const profile = await this.getAgentProfile(apiKey);
    return {
      id: profile.name || profile.id,
      name: profile.display_name || profile.name,
      accessToken: apiKey,
      refreshToken: '',
      expiresIn: dayjs().add(200, 'year').unix() - dayjs().unix(),
      picture: '',
      username: profile.name,
    };
  }
  async post(id: string, accessToken: string, postDetails: PostDetails[], integration: Integration): Promise<PostResponse[]> {
    // use this.getSsrfSafeAxios() for ALL outbound calls
    // return [{ id: post.id, postId, releaseURL, status: 'completed' }]
    // status: 'pending' obliges you to override checkPostStatus + finalizePost
  }
  // checkValidity / checkPostStatus / finalizePost / migrationMatch inherited
  // from SocialAbstract (checkValidity returns true; the other two throw BadBody).
}

// --- 4. Registration (libraries/.../integrations/integration.manager.ts:42-79) ---
export const socialIntegrationList: Array<SocialAbstract & SocialProvider> = [
  /* ...35 entries... */
  new MoltbookProvider(),
  new MusebookProvider(),   // <- add here
];

// --- 5. Frontend twin of the limit, must match maxLength() ---
// apps/frontend/src/components/new-launch/providers/musebook/musebook.provider.tsx
maximumCharacters: 300,
```

### Caveats
- Claim 4 is the dangerous one: the public-API throttle is 90/hour (env API_LIMIT), not 30/hour, and it is an inline literal in apps/backend/src/app.module.ts:39 — there is no named constant to import. The 30/3600000 that exists at apps/backend/src/api/routes/auth.controller.ts:294 belongs to an auth route and must not be cited for the public API.
- Claim 7's line count is wrong (200, not ~130) and moltbook is a MINIMAL model: it implements neither checkValidity nor analytics/postAnalytics/checkPostStatus/finalizePost. Copying only the .ts file leaves the provider invisible — 8 more files must be edited (integration.manager.ts, the settings DTO + all.providers.settings.ts, integrations.controller.ts, and 4 frontend files).
- Farcaster's identifier string is 'wrapcast' (farcaster.provider.ts:45) while the class is FarcasterProvider, name is 'Farcaster' and the frontend folder is providers/warpcast/. Anything keyed by identifier must use 'wrapcast'.
- The pre-existing clone was at a stale, force-replaced commit (7cef69c). Anyone re-running this must `git fetch` — origin/main history on this repo gets rewritten. All findings are pinned to 450f0b4 (2026-09-21); this repo moves daily and version.txt v1.47.0 may bump.
- Character counting is per-provider and non-obvious (count.length.ts:41-51): 'x' uses twitter-text weightedLength, 'threads' counts UTF-8 BYTES, everything else uses JS text.length. Bluesky's 300 is therefore UTF-16 code units, not the graphemes Bluesky itself counts — emoji-heavy posts can pass Postiz and be rejected by Bluesky.
- No video-duration or aspect-ratio validation exists anywhere (social.abstract.ts:160-161 says so explicitly). The Instagram 4:5–1.91:1 and 1920x1080 strings are post-hoc error mappings in handleErrors, not pre-flight checks — do not put them in the plan as enforced constraints.
- Every limit is duplicated in the frontend as `maximumCharacters`; backend and frontend can drift, and a new provider must set both.
- tiktok.dto.ts:61-70 warns that most TikTok settings are silently discarded when content_posting_method=UPLOAD, and music/location are TikTok-Business-only — the DTO documents the constraints without enforcing them.
- MCP_ONLY=true removes the entire /public/v1 REST controller (public.api.module.ts:18); a deployment in that mode exposes only the MCP surface.

### Evidence
- local clone @ /tmp/claude-0/-home-user-mog/fd320bdb-4628-5b5d-a380-543979d8bc42/scratchpad/postiz-app, git rev 450f0b44865f609c595187d53ecffe75f9cc9960 (origin/main, 2026-09-21 06:35:36 +0200), re-fetched 2026-09-21
- version.txt (v1.47.0); package.json:6,10,12,74-75,84,96-100,193,309,329; pnpm-workspace.yaml; absence of nx.json; zero 'bullmq' hits repo-wide
- LICENSE (661-line GNU AGPL v3 verbatim); package.json:6
- apps/backend/src/public-api/routes/v1/public.integrations.controller.ts:57,462-487
- apps/backend/src/services/auth/public.auth.middleware.ts:24-25,32-48,57-62,66,72-100
- apps/backend/src/public-api/public.api.module.ts:15-18,36
- libraries/nestjs-libraries/src/database/prisma/organizations/organization.repository.ts:55-63
- apps/sdk/src/index.ts:27,40,68,80,91
- apps/backend/src/app.module.ts:35-43,46-55
- libraries/nestjs-libraries/src/throttler/throttler.provider.ts:5-37
- apps/backend/src/api/routes/auth.controller.ts:294,306 (the unrelated 30/hour)
- libraries/nestjs-libraries/src/integrations/social/social.integrations.interface.ts:8-51,84-107,109-131,162-227
- libraries/nestjs-libraries/src/integrations/social.abstract.ts:145-150,152-169,171-205
- libraries/nestjs-libraries/src/integrations/integration.manager.ts:42-79
- libraries/nestjs-libraries/src/chat/start.mcp.ts:152-171,208-215,219-259,319,351,369-390
- libraries/nestjs-libraries/src/integrations/social/moltbook.provider.ts:1-200
- libraries/nestjs-libraries/src/database/prisma/posts/posts.service.ts:770-872
- libraries/helpers/src/utils/count.length.ts:4-51
- libraries/nestjs-libraries/src/integrations/social/x.provider.ts:90-143,170-174
- libraries/nestjs-libraries/src/integrations/social/linkedin.provider.ts:77-105
- libraries/nestjs-libraries/src/integrations/social/instagram.provider.ts:47-87,292,329,344
- libraries/nestjs-libraries/src/integrations/social/instagram.standalone.provider.ts:42-65
- libraries/nestjs-libraries/src/integrations/social/tiktok.provider.ts:49-88
- libraries/nestjs-libraries/src/integrations/social/tiktok.business.provider.ts:53-93
- libraries/nestjs-libraries/src/integrations/social/youtube.provider.ts:75-90
- libraries/nestjs-libraries/src/integrations/social/threads.provider.ts:33-39
- libraries/nestjs-libraries/src/integrations/social/bluesky.provider.ts:244-265
- libraries/nestjs-libraries/src/integrations/social/mastodon.provider.ts:40-42
- libraries/nestjs-libraries/src/integrations/social/reddit.provider.ts:64-89
- libraries/nestjs-libraries/src/integrations/social/farcaster.provider.ts:45-68
- libraries/nestjs-libraries/src/integrations/social/discord.provider.ts:15-24
- libraries/nestjs-libraries/src/integrations/social/telegram.provider.ts:24-31,141-206
- libraries/nestjs-libraries/src/integrations/social/pinterest.provider.ts:60-110
- libraries/nestjs-libraries/src/dtos/posts/providers-settings/youtube.settings.dto.ts:19-29,66-91
- libraries/nestjs-libraries/src/dtos/posts/providers-settings/tiktok.dto.ts:61-78
- libraries/nestjs-libraries/src/dtos/posts/providers-settings/pinterest.dto.ts:6-33
- libraries/nestjs-libraries/src/dtos/posts/providers-settings/reddit.dto.ts:26-58
- apps/frontend/src/components/new-launch/providers/*/*.provider.tsx (maximumCharacters), x/x.provider.tsx:142-147, moltbook/moltbook.provider.tsx:34


## typesafe-sdk — PARTIALLY_CORRECT

Verified against the published package itself (docs.typesafe.ai and typesafe.ai are BLOCKED by this environment's egress proxy, so the doc pages named in the claim could not be read; everything below comes from the npm registry, the published tarball, and the official typesafe-ai GitHub org).

(1) SDK NAME — CONFIRMED that an official JS/TS SDK exists, but the name must be written exactly: `@typesafe-ai/sdk`. Latest 0.6.0, published 2026-09-15 (dist-tags: latest=0.6.0, bootstrap=0.0.0-bootstrap.0; only versions ever published are 0.0.0-bootstrap.0, 0.5.7, 0.6.0). description "TypeScript SDK for the TypeSafe API", MIT, zero runtime dependencies, engines node>=20, homepage https://docs.typesafe.ai/sdk/javascript, repo github.com/typesafe-ai/typesafe-sdk-js. Ships ESM + CJS + both .d.mts/.d.cts. DO NOT use `typesafe-ai` (404), `@typesafe/sdk` (404), or `typesafe` (exists but is an unrelated 2015 package whose every version was unpublished in 2022 — effectively dead). An official Python SDK also exists: `typesafe-ai/typesafe-sdk-python`. Package-name corroboration beyond the registry: independent third-party packages (semantic-assert-typesafe, pi-typesafe, jev-mcp) all declare a dependency on "@typesafe-ai/sdk": "^0.6.0".

(2) CLIENT + AUTH + SIGNATURE — CONFIRMED. `new TypeSafeClient()` with no args; auth env var is TYPESAFE_API_KEY (constructor throws TypeSafeError if absent). Other env vars: TYPESAFE_BASE_URL (default https://api.typesafe.ai), TYPESAFE_DEFAULT_MODEL (default jev-latest), TYPESAFE_LOG_LEVEL (default warn). Wire auth is the `Authorization: Bearer <key>` header — NOT x-api-key (x-api-key appears in the SDK only as a redaction-list entry for logging). Call signature: `client.systemOne(request, options?)` returning an APIPromise<SystemOneResult<Q>> (a real Promise, plus .asResponse()/.withResponse()/.map()). Endpoint POST /v1/systemone; also GET /v1/models via `client.models.list()`. Defaults: timeout 10000ms per attempt, maxRetries 2, backoff 500ms doubling to 5000ms, jitter 0.25, retries on 408/429/500-599. Request id header is x-typesafe-request-id. Browser use is refused unless dangerouslyAllowBrowser: true.

(3) MODEL IDs — 'jev-latest' is REAL and CONFIRMED: it is the hard-coded DEFAULT_MODEL in both the JS SDK (src/client.ts) and the Python SDK (constants.py), and appears as the ModelMetadata example. No other concrete model ID could be verified: a GitHub-wide code search for "jev-preview", "jev-1", "jev-mini" and "jev-flash" returns ZERO hits, and /v1/models could not be called (no key + host blocked). Treat 'jev-preview' as UNVERIFIED — do not hard-code it. Enumerate real IDs at runtime with `await client.models.list()`, which returns ModelCard[] of {name, description, release_date}.

(4) REQUEST SHAPE — CONFIRMED. Body is {state, questions, model}. `state` is EntryType = string | JSON object | JSON array | null. `questions` is a non-empty record of NAME -> question; the answer keys mirror these names. `model` is injected by the SDK from defaultModel when omitted. The three question types (build them with the exported `noul` / `choice` / `score` helpers rather than by hand):
  - noul:   {type:"noul", instructions?: EntryType, criteria?: {true?: EntryType, false?: EntryType} | null}. Helper: noul(instructions?, criteria?). Both instructions and criteria are OPTIONAL for noul.
  - choice: {type:"choice", instructions?: EntryType, criteria: {[label]: Description|null}}. Helper: choice(instructions, criteria). criteria is REQUIRED; a null value means "label with no description".
  - score:  {type:"score", instructions?: EntryType, criteria: readonly [EntryType, EntryType, ...EntryType[]]} — an ORDERED ARRAY (rubric indexed from 0), NOT an object and NOT a {min,max}. Helper: score(instructions, criteria). At least TWO entries or the SDK throws client-side: `Score question "<name>" has N criteria; at least two scores are required.`
  Note the asymmetry the claim glosses over: choice criteria is a MAP, score criteria is an ARRAY, noul criteria is the optional {true,false} pair.

(5) RESPONSE SHAPE — CONFIRMED, and yes it returns per-option probabilities, but the key differs by type. Top level: {model: string, answers: {[name]: Answer}, usage: {input_tokens: number, output_tokens: number}}.
  - NoulResponse:   {type:"noul", noul: number}  <- probability of yes in [0,1]. IMPORTANT: noul has NO `confidence` and NO `probabilities` field; the single `noul` float IS the calibrated probability.
  - ChoiceResponse: {type:"choice", choice: string, confidence: number, probabilities: {[label]: number}} (probabilities sum to ~1).
  - ScoreResponse:  {type:"score", score: number, confidence: number, legend: {[score]: description}, probabilities: {[score]: number}} — `score` is a probability-weighted EXPECTED value, so it is fractional and falls BETWEEN integer rubric levels; legend/probabilities are keyed by the stringified rubric index.
  Real response (official Python SDK fixture, tests/test_clients.py): {"model":"jev-latest","usage":{"input_tokens":12,"output_tokens":3},"answers":{"spam":{"type":"noul","noul":0.98},"tone":{"type":"choice","choice":"friendly","confidence":0.9,"probabilities":{"friendly":0.9,"hostile":0.1}},"quality":{"type":"score","score":1.7,"confidence":0.8,"legend":{"0":"bad","1":"ok","2":"great"},"probabilities":{"0":0.1,"1":0.1,"2":0.8}}}}
  TS typing is fully inferred: systemOne<const Q> maps each question to ChoiceResponse<its criteria>/ScoreResponse<its rubric>/NoulResponse, so answers.category.choice is a literal union, not string.

(6) PRICING AND RATE LIMITS — UNVERIFIABLE. typesafe.ai and docs.typesafe.ai are both egress-blocked here, and the SDK ships no pricing data. A secondary web-search summary claims ~$42 per billion input tokens with output tokens free, but that is NOT a primary source and must not be written into the plan as fact. The only rate-limit fact confirmed from primary source is mechanical, not numeric: HTTP 429 raises RateLimitError carrying retryAfterMs, and the SDK honors Retry-After / retry-after-ms up to 60000ms by default.

CLASSIFYPOST — written, and VERIFIED three ways against the real 0.6.0 package: (a) `tsc --strict` compiles clean; (b) a type probe confirms the literal unions actually infer (category -> "technology"|"business"|"science"|"society"|"lifestyle"|"entertainment"|"other", language -> "en"|"es"|...|"other", tone -> "neutral"|...); (c) executed end-to-end against a mocked fetch, confirming ONE POST to https://api.typesafe.ai/v1/systemone carrying all 16 questions with model "jev-latest" and parsing back correctly. Design note the implementing agent needs: Jev has NO multi-label question type, so "topic tags" is modelled as one `noul` per candidate tag inside the same batched call (7 tags -> 7 nouls), which is why the batch is 16 questions rather than 10. Working file: /tmp/claude-0/-home-user-mog/fd320bdb-4628-5b5d-a380-543979d8bc42/scratchpad/proj/classifyPost.ts

### Copy-paste snippet
```
// Install: npm install @typesafe-ai/sdk     (Node >= 20)
// Auth:    export TYPESAFE_API_KEY=...
// Verified against @typesafe-ai/sdk@0.6.0 (published 2026-09-15): compiles under
// tsc --strict, and executes as ONE POST to https://api.typesafe.ai/v1/systemone.

import { choice, noul, score, TypeSafeClient } from "@typesafe-ai/sdk";

const client = new TypeSafeClient(); // reads TYPESAFE_API_KEY

export interface Post {
  title?: string;
  body: string;
  url?: string;
  author?: string;
}

/** Jev has no multi-label question type, so each candidate tag gets its own noul. */
const TOPIC_TAGS = [
  "ai_ml",
  "software_engineering",
  "business_finance",
  "science",
  "politics",
  "health",
  "entertainment",
] as const;

type TopicTag = (typeof TOPIC_TAGS)[number];

export async function classifyPost(post: Post) {
  const state = {
    title: post.title ?? null,
    body: post.body,
    url: post.url ?? null,
    author: post.author ?? null,
  };

  const { answers, usage, model } = await client.systemOne({
    state,
    questions: {
      // --- category: hierarchical, level 1 (top-level bucket only) ---
      category: choice("What is the top-level (level 1) category of this post?", {
        technology: "Computing, software, hardware, AI, the internet.",
        business: "Companies, markets, finance, economics, careers.",
        science: "Natural sciences, research, medicine, space, environment.",
        society: "Politics, law, culture, education, social issues.",
        lifestyle: "Health, food, travel, hobbies, personal life, sport.",
        entertainment: "Film, TV, music, games, celebrities, fiction.",
        other: "Does not fit any other level-1 category.",
      }),

      // --- medium / format ---
      medium: choice("What format is this content?", {
        news_article: "Reports current events as journalism.",
        opinion_essay: "Argues a position or reflects personally.",
        tutorial: "Teaches the reader how to do something step by step.",
        documentation: "Reference material for a product, API, or tool.",
        research_paper: "Academic or technical paper with methods and results.",
        product_announcement: "Launch, release notes, or marketing for a product.",
        discussion_thread: "Forum post, question, or conversational exchange.",
        listicle: "Ranked or enumerated list of items.",
        other: "None of the above formats.",
      }),

      // --- topic tags: one noul per candidate tag (multi-label) ---
      ...(Object.fromEntries(
        TOPIC_TAGS.map((tag) => [
          `tag_${tag}`,
          noul(`Is this post substantially about the topic "${tag}"?`, {
            true: "The post covers this topic in a meaningful way.",
            false: "The topic is absent or only mentioned in passing.",
          }),
        ]),
      ) as { [K in `tag_${TopicTag}`]: ReturnType<typeof noul> }),

      // --- tone ---
      tone: choice("What is the tone of the writing?", {
        neutral: "Detached and factual.",
        enthusiastic: "Positive, excited, promotional.",
        critical: "Negative, skeptical, or disapproving.",
        humorous: "Playful, ironic, or comedic.",
        alarmist: "Urgent, fearful, or sensational.",
      }),

      // --- audience level ---
      audience_level: choice("What level of prior knowledge does this assume?", {
        general: "Written for anyone, no background needed.",
        enthusiast: "Assumes casual familiarity with the subject.",
        practitioner: "Assumes the reader works in the field.",
        expert: "Assumes deep specialist knowledge.",
      }),

      // --- safety (noul) ---
      safety: noul("Is this content safe for a general audience?", {
        true: "No harmful, explicit, hateful, or dangerous material.",
        false: "Contains harmful, explicit, hateful, or dangerous material.",
      }),

      // --- ai_generated (noul) ---
      ai_generated: noul("Does this text read as machine-generated?", {
        true: "Formulaic phrasing, generic filler, uniform rhythm, no lived detail.",
        false: "Specific detail, idiosyncratic voice, genuine authorial perspective.",
      }),

      // --- quality (score): ordered rubric ARRAY, >= 2 entries ---
      quality: score("How well written and substantive is this post?", [
        "spam or content-free",
        "thin, padded, little information",
        "competent and useful",
        "well researched, original, genuinely valuable",
      ]),

      // --- agent_value (score) ---
      agent_value: score(
        "Is this worth an autonomous agent paying to crawl? Weigh durable, specific, hard-to-find information.",
        [
          "no value; boilerplate or duplicated elsewhere",
          "marginal; freely available in better form elsewhere",
          "useful; adds real information worth retrieving",
          "high value; unique primary information worth paying for",
        ],
      ),

      // --- language ---
      language: choice("What language is this post written in?", {
        en: null,
        es: null,
        fr: null,
        de: null,
        pt: null,
        zh: null,
        ja: null,
        ko: null,
        ru: null,
        ar: null,
        other: "Any language not listed.",
      }),
    },
  });

  return {
    model,
    usage,
    category: answers.category.choice,
    categoryConfidence: answers.category.confidence,
    categoryProbabilities: answers.category.probabilities,

    medium: answers.medium.choice,
    mediumConfidence: answers.medium.confidence,

    // Keep every tag above 0.5, strongest first, with its probability.
    topicTags: TOPIC_TAGS.map((tag) => ({
      tag,
      probability: answers[`tag_${tag}`].noul,
    }))
      .filter((t) => t.probability >= 0.5)
      .sort((a, b) => b.probability - a.probability),

    tone: answers.tone.choice,
    audienceLevel: answers.audience_level.choice,

    // noul IS the probability in [0,1] — there is no separate confidence field.
    safeProbability: answers.safety.noul,
    isSafe: answers.safety.noul >= 0.5,

    aiGeneratedProbability: answers.ai_generated.noul,

    // score is an expected value over the rubric, so it may be fractional.
    quality: answers.quality.score,
    qualityConfidence: answers.quality.confidence,
    qualityLegend: answers.quality.legend,

    agentValue: answers.agent_value.score,
    agentValueConfidence: answers.agent_value.confidence,
    worthCrawling: answers.agent_value.score >= 2,

    language: answers.language.choice,
    languageProbabilities: answers.language.probabilities,
  };
}
```

### Caveats
- Verified 2026-09-21. @typesafe-ai/sdk is at 0.6.0 (published 2026-09-15, i.e. six days old) and is pre-1.0 with only three versions ever published — breaking changes between 0.x minors are likely. Pin the version ("@typesafe-ai/sdk": "0.6.0") rather than using a caret range.
- The doc pages the claim asked me to check (https://docs.typesafe.ai/llms.txt, https://docs.typesafe.ai/introduction/quickstart, the SDK reference) and https://typesafe.ai are BLOCKED by this environment's egress proxy. All findings come from the published npm tarball and the official typesafe-ai GitHub org instead. Those are primary artifacts, but if the live docs contradict them the docs win.
- PRICING AND RATE LIMITS ARE UNVERIFIED. Do not put a number in the plan. The ~$42-per-billion-input-tokens / free-output figure comes only from a secondary web-search summary of third-party blogs, not from typesafe.ai.
- 'jev-preview' and every other model ID besides 'jev-latest' are UNVERIFIED — a GitHub-wide search returns zero hits. Only 'jev-latest' is confirmed (it is the hard-coded SDK default). Call client.models.list() at runtime to discover real IDs rather than hard-coding a second one.
- 'jev-latest' is a moving alias, not a pinned model version, so classification outputs can drift under you without a code change. Record the `model` field returned in each response (the response echoes the concrete model used) if you need reproducibility.
- noul answers carry NO `confidence` field — only the `noul` float. Code that reads answers.<noul>.confidence will be undefined at runtime (and will not compile in TS). Likewise choice uses `probabilities` keyed by label while score uses `probabilities` + `legend` keyed by stringified rubric index.
- score `criteria` must be an ordered ARRAY of at least two entries; the SDK throws client-side otherwise. choice `criteria` is a MAP and is required. These two are easy to swap by mistake.
- The returned `score` is a probability-weighted expected value, so it is fractional (e.g. 1.7 on a 0-3 rubric) and is NOT an index into the rubric. Threshold it (as worthCrawling does) rather than using it as a key.
- Topic tagging is implemented as 7 separate noul questions because Jev has no multi-label type. This makes the batch 16 questions, not 10, which raises per-call input token cost. Trim TOPIC_TAGS if cost matters.
- classifyPost creates a module-scope client, so importing the module throws TypeSafeError immediately if TYPESAFE_API_KEY is unset. If you need lazy construction or want to inject a custom fetch for tests, move the `new TypeSafeClient()` inside the function or accept it as a parameter.
- SDK default timeout is 10s per attempt with 2 retries and NO total retry budget, so a worst case can exceed 30s. A 16-question batch may need a higher `timeout`; pass it per call via the second argument to systemOne.
- Requires Node >= 20 (package engines). Browser use is refused unless dangerouslyAllowBrowser is set, which would expose the API key — keep this server-side.
- Client-side logging at logLevel 'debug' prints request and response BODIES; only credential headers are redacted. Do not enable debug on posts containing sensitive content.

### Evidence
- https://registry.npmjs.org/@typesafe-ai/sdk — dist-tags {latest: 0.6.0, bootstrap: 0.0.0-bootstrap.0}; time[0.6.0]=2026-09-15T18:17:19.263Z; description 'TypeScript SDK for the TypeSafe API'; dependencies {}; homepage https://docs.typesafe.ai/sdk/javascript; repo git+https://github.com/typesafe-ai/typesafe-sdk-js.git
- https://registry.npmjs.org/@typesafe-ai/sdk/-/sdk-0.6.0.tgz — downloaded and extracted; read README.md, package.json, dist/index.d.mts (full type surface) and dist/index.mjs (compiled source)
- dist/index.mjs (in tarball): mergeHeaders(req.headers, { Authorization: `Bearer ${this.#apiKey}`, Accept: 'application/json', 'User-Agent': `typesafe-sdk/${VERSION}`, 'X-TypeSafe-SDK': ..., 'X-TypeSafe-Runtime': RUNTIME, 'Content-Type': 'application/json' }) — proves Bearer auth, not x-api-key
- dist/index.mjs + index.mjs.map sourcesContent: DEFAULT_BASE_URL='https://api.typesafe.ai', DEFAULT_MODEL='jev-latest', paths '/v1/systemone' and '/v1/models', ENV={apiKey:'TYPESAFE_API_KEY',baseURL:'TYPESAFE_BASE_URL',defaultModel:'TYPESAFE_DEFAULT_MODEL',logLevel:'TYPESAFE_LOG_LEVEL'}
- https://registry.npmjs.org/typesafe-ai — HTTP 404 (does not exist)
- https://registry.npmjs.org/@typesafe/sdk — HTTP 404 (does not exist)
- https://registry.npmjs.org/typesafe — exists but every version (0.9.5-0.9.8, 2015) unpublished 2022-02-18; unrelated to TypeSafe.ai
- https://registry.npmjs.org/-/v1/search?text=typesafe%20jev — third-party packages semantic-assert-typesafe@0.2.1, pi-typesafe@0.6.1 and jev-mcp@0.5.0 each declare dependency '@typesafe-ai/sdk': '^0.6.0' (independent corroboration of the package name)
- GitHub code search `"jev-" org:typesafe-ai` — 11 hits, all 'jev-latest', across typesafe-sdk-js/src/client.ts (export const DEFAULT_MODEL = "jev-latest"), typesafe-sdk-python/src/typesafe_sdk/constants.py (DEFAULT_MODEL = "jev-latest") and _schemas/models.py (ModelMetadata examples=["jev-latest"])
- GitHub code search `"jev-preview" OR "jev-1" OR "jev-mini" OR "jev-flash"` — total_count: 0 across all of GitHub (jev-preview could NOT be corroborated)
- https://raw.githubusercontent.com/typesafe-ai/typesafe-sdk-js/main/examples/demo.ts — official example: client.models.list(), client.systemOne({state, questions:{isBilling: noul(...), sentiment: choice(...), urgency: score('How urgent is this ticket?', ['can wait','this week','today','right now'])}}), reads isBilling.noul, sentiment.probabilities, urgency.legend, refundRisk.confidence, usage.input_tokens
- https://raw.githubusercontent.com/typesafe-ai/typesafe-sdk-python/main/src/typesafe_sdk/_schemas/models.py — wire schema: NoulAnswer{type,noul}, ChoiceAnswer{type,choice,confidence,probabilities}, ScoreAnswer{type,score,confidence,legend,probabilities}, Usage{input_tokens,output_tokens}
- https://raw.githubusercontent.com/typesafe-ai/typesafe-sdk-python/main/tests/test_clients.py — RESULT fixture (the real response example quoted above) and CARD = {'name':'jev-latest','description':'Fast model','release_date':'2026-08-01'}
- GitHub code search `"probabilities" org:typesafe-ai` — typesafe-sdk-js/test/types.test-d.ts asserts r.answers.b.probabilities is {readonly yes:number; readonly no:number} and r.answers.c.legend is {readonly 0:'bad'; readonly 1:'ok'}, confirming per-option probability typing
- Local verification: tsc 5.7.3 --strict --module nodenext on classifyPost.ts against the real @typesafe-ai/sdk@0.6.0 → exit 0; type probe printed the inferred literal unions; node run against mocked fetch produced one POST https://api.typesafe.ai/v1/systemone with 16 questions and model 'jev-latest', parsed back to typed answers
- BLOCKED (could not be consulted): https://docs.typesafe.ai/llms.txt, https://docs.typesafe.ai/introduction/quickstart, https://typesafe.ai/pricing, https://api.typesafe.ai/v1/models — all returned EGRESS_BLOCKED / connect_rejected from this environment's proxy


## usdc-eip712 — PARTIALLY_CORRECT

HALF 1 — CONFIRMED, verbatim. Base mainnet USDC (0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913) signs EIP-712 under domain name "USD Coin"; Base Sepolia USDC (0x036CbD53842c5426634e7929541eC2318f3dCF7e) signs under "USDC". Both are version "2", 6 decimals, and both support EIP-3009 (transferWithAuthorization AND receiveWithAuthorization). Three independently published packages agree: (a) legacy `x402` v1.2.0 `src/types/shared/evm/config.ts` -> {"8453": {usdcName: "USD Coin"}, "84532": {usdcName: "USDC"}}; (b) current `@x402/evm` v2.26.0 `src/defaultAssets.ts` -> eip155:8453 {name:"USD Coin",version:"2"}, eip155:84532 {name:"USDC",version:"2"}; (c) x402's own middleware line `name: network === "base" ? "USD Coin" : ... : "USDC"`. Root cause, from Circle's source: FiatTokenV2_2._domainSeparator() returns EIP712.makeDomainSeparator(name, "2", _chainId()) — the domain name IS the mutable ERC-20 name(), and the version is hardcoded "2". Circle deployed the mainnet token as "USD Coin" and the Sepolia token as "USDC" (same asymmetry appears for Avalanche Fuji "USD Coin" vs Polygon Amoy "USDC", so it is per-deployment, not per-environment). The failure mode is confirmed and is exactly as opaque as claimed: every x402 EVM client (x402 v1 signAuthorization, @x402/evm v2 signERC3009, thirdweb signERC3009Authorization) copies `paymentRequirements.extra.name` into the EIP-712 domain with NO on-chain cross-check, so a wrong name yields a signature that recovers a random address and the facilitator returns `invalid_exact_evm_payload_signature`.

HALF 2 — DIRECTIONALLY RIGHT, PREMISE OUTDATED. The conclusion (native $APE is structurally unusable as an x402 asset) is CONFIRMED: `paymentRequirements.asset` is always an ERC-20 contract address, settlement is always a contract call, and no x402 scheme moves native value. Legacy x402 v1.2.0 ships exactly one scheme (`var schemes = ["exact"]`) and only an EIP-3009 path. BUT "exact requires EIP-3009" is no longer true as of @x402/evm v2.26.0 (2026-09-15): the asset config carries `assetTransferMethod: "eip3009" | "permit2"` (default "eip3009") plus `supportsEip2612`, and v2 ships Permit2 proxies (x402ExactPermit2Proxy 0x402085c248EeA27D92E8b30b2C58ed07f9E20001, x402UptoPermit2Proxy 0x4020A4f3b7b90ccA423B9fabCc0CE57C6C240002) so non-3009 tokens settle via PermitWitnessTransferFrom. Shipped examples of non-3009 assets: MegaUSD (eip155:4326), Mezo mUSD, Radius SBC, Igra USDC. thirdweb v5 independently auto-detects and supports EIP-2612 `Permit` as well as `TransferWithAuthorization`. v2 also adds a second scheme, `upto`. So: the correct statement is "x402's exact scheme settles an ERC-20 via a signed authorization (EIP-3009 by default, Permit2/EIP-2612 as an alternative), therefore a native gas coin cannot be the x402 asset" — the EIP-3009 clause is too narrow.

APECHAIN SPECIFICALLY: no x402 package supports it at all today. Chain 33139 (mainnet) and 33111 (Curtis) appear in NEITHER x402 v1 SupportedEVMNetworks/config NOR @x402/evm v2.26.0 EVM_NETWORK_CHAIN_ID_MAP/DEFAULT_ASSETS. To use ApeChain you would need (1) an ERC-20, never native APE, (2) a facilitator that actually settles on 33139, and (3) the x402 Permit2 proxy deployed there if the token lacks EIP-3009. WAPE (0x48b62137edfa95a428d35c09e44256a739f6b557) is a WETH9-style wrapper: no EIP-3009 and no EIP-2612, so it would need the Permit2 route only. The better target is ApeChain's USDC — ApeChain reportedly migrated its canonical stablecoin from apeUSD to Circle USDC effective 2026-07-31 (secondary source only, address NOT verified by me); if it is Circle's Bridged USDC Standard it will have EIP-3009 and version "2", but the name may be "Bridged USDC" or "USDC.e", NOT "USD Coin", and MUST be read on-chain before use.

FACILITATORS TODAY (2026-09-21): (1) Coinbase CDP, https://api.cdp.coinbase.com/platform/v2/x402 — Base, Polygon, Arbitrum, World (EVM) + Solana; supports any ERC-20 via EIP-3009 or Permit2; authoritative list is dynamic at GET /platform/v2/x402/supported. (2) x402.org public facilitator, https://x402.org/facilitator — the DEFAULT_FACILITATOR_URL baked into @x402/core v2.26.0; testnet-oriented (base-sepolia), do not use in production. (3) thirdweb facilitator (what this repo already wires up via gateway/lib/thirdweb.js) — advertises 170+ EVM chains and 4000+ tokens; its per-chain list is server-side, so query its /supported endpoint rather than trusting the marketing number. RECOMMENDATION: support base + base-sepolia only, with the exact blocks below.

REPO BUG FOUND WHILE VERIFYING: /home/user/mog/gateway/lib/thirdweb.js line 28 defaults `X402_CHAIN_ID` to 3313939, which is not a real chain id (ApeChain mainnet is 33139, Curtis testnet 33111).

### Copy-paste snippet
```
// VERIFIED asset config — x402 v2 (CAIP-2 network ids), from @x402/evm@2.26.0 src/defaultAssets.ts
// Support these two only. Do NOT add ApeChain: no x402 package or public facilitator covers 33139/33111.

export const X402_ASSETS = {
  // Base mainnet — chainId 8453
  "eip155:8453": {
    asset:    "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    name:     "USD Coin",   // <-- EIP-712 domain name. NOT "USDC". Wrong value => invalid_exact_evm_payload_signature
    version:  "2",
    decimals: 6,
    symbol:   "USDC",
    // assetTransferMethod omitted => "eip3009" (transferWithAuthorization). Correct for USDC.
  },

  // Base Sepolia — chainId 84532
  "eip155:84532": {
    asset:    "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    name:     "USDC",       // <-- genuinely "USDC" on Sepolia. Do not "fix" this to "USD Coin".
    version:  "2",
    decimals: 6,
    symbol:   "USDC",
  },
};

// The 402 response must put these in `extra`, because every client copies them straight
// into the EIP-712 domain with no on-chain check:
//   accepts: [{
//     scheme: "exact",
//     network: "eip155:8453",
//     asset: X402_ASSETS["eip155:8453"].asset,
//     payTo: "0x...",
//     maxAmountRequired: "10000",            // 0.01 USDC, 6 decimals
//     maxTimeoutSeconds: 300,
//     extra: { name: "USD Coin", version: "2" }
//   }]

// ---- legacy x402 v1 (`x402`, `x402-express`, `x402-hono`) uses slug network ids instead:
//   network: "base"          -> chainId 8453,  extra: { name: "USD Coin", version: "2" }
//   network: "base-sepolia"  -> chainId 84532, extra: { name: "USDC",     version: "2" }
// Mixing v1 slugs with v2 CAIP-2 ids is a second, separate footgun.

// ---- If you later widen to CDP-facilitator networks, the verified blocks are:
//   "eip155:137"   Polygon      0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359  "USD Coin" / "2" / 6
//   "eip155:42161" Arbitrum One 0xaf88d065e77c8cC2239327C5EDb3A432268e5831  "USD Coin" / "2" / 6
//   "eip155:1"     Ethereum     0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48  "USD Coin" / "2" / 6
//   "eip155:421614" Arb Sepolia 0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d  "USD Coin" / "2" / 6

// ---- MANDATORY pre-ship check per (chain, token), since a wrong name fails silently:
//   cast call 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 "name()(string)"    --rpc-url https://mainnet.base.org
//   cast call 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 "version()(string)" --rpc-url https://mainnet.base.org
//   # expect: "USD Coin"  /  "2"
//   cast call 0x036CbD53842c5426634e7929541eC2318f3dCF7e "name()(string)"    --rpc-url https://sepolia.base.org
//   # expect: "USDC"
// Stronger check (catches any domain drift at once):
//   cast call <token> "DOMAIN_SEPARATOR()(bytes32)" --rpc-url <rpc>
//   # must equal keccak256(abi.encode(
//   #   keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
//   #   keccak256(bytes(name)), keccak256(bytes(version)), chainId, token))
```

### Caveats
- I could NOT perform a live eth_call. This session's egress proxy 403s every RPC and explorer host (mainnet.base.org, base.llamarpc.com, base-rpc.publicnode.com, basescan.org, api.basescan.org, base.blockscout.com) and blocks docs.x402.org and docs.cdp.coinbase.com. The name/version values are verified from three independently published package configs plus Circle's contract source, not from a direct on-chain read. The implementing agent should run the `cast call` checks in the snippet before shipping.
- Versions are dated: x402@1.2.0 published 2026-04-16; @x402/core + @x402/evm @2.26.0 published 2026-09-15 (six days before today, 2026-09-21); @coinbase/x402@2.1.0 published 2025-12-23; thirdweb@5.121.4; @circle-fin/x402-batching@3.5.0 published 2026-09-16. The @x402/* line is moving weekly — re-read defaultAssets.ts at implementation time.
- The x402 package line migrated from `x402`/`x402-express`/`x402-hono` (v1.x, slug network ids like "base") to `@x402/core`/`@x402/evm`/`@x402/express` (v2.x, CAIP-2 ids like "eip155:8453"). The repo currently pins thirdweb ^5.115.3, which speaks both. Decide which protocol version you are on before copying any config.
- The CDP facilitator's network list is dynamic (GET https://api.cdp.coinbase.com/platform/v2/x402/supported). My list (Base, Polygon, Arbitrum, World, Solana) comes from a web-search summary of docs.cdp.coinbase.com dated Sept 2026, not a fetched primary response — the doc page itself was egress-blocked. Same for thirdweb's '170+ chains' claim.
- The ApeChain USDC migration (apeUSD -> Circle USDC, effective 2026-07-31) is from a secondary source only. I did not verify the ApeChain USDC contract address, its name(), its version(), or whether it implements EIP-3009. Verify on apescan.io before assuming any of it.
- The WAPE address 0x48b62137edfa95a428d35c09e44256a739f6b557 comes from an apescan page title surfaced by search, not from a contract read I performed.
- version "2" is hardcoded in FiatTokenV2_2._domainSeparator() for Circle-issued USDC, but NOT universal: bridged and third-party tokens in @x402/evm ship version "1" (USDT0, mUSD, SBC, Igra USDC, Celo USDT). Never assume "2" for a non-Circle asset.
- Base mainnet USDC is upgradeable and `name` is a mutable storage variable, so a future Circle upgrade could in principle change the EIP-712 domain. Reading name()/version() at startup and caching is safer than hardcoding, and is what x402 v1's getVersion() already does for version.

### Evidence
- https://registry.npmjs.org/x402 -> x402@1.2.0 (published 2026-04-16), dist/cjs/shared/evm/index.js lines 33-41: config = { "84532": { usdcAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", usdcName: "USDC" }, "8453": { usdcAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", usdcName: "USD Coin" } }
- https://registry.npmjs.org/@x402/evm -> @x402/evm@2.26.0 (published 2026-09-15), dist/esm/chunk-2UXXNYPA.mjs src/defaultAssets.ts: eip155:8453 {name:'USD Coin',version:'2',decimals:6}, eip155:84532 {name:'USDC',version:'2',decimals:6}; also assetTransferMethod:'permit2' + supportsEip2612 entries for MegaUSD/mUSD/SBC/Igra
- https://registry.npmjs.org/@x402/evm -> dist/esm/chunk-7JHAAJUW.mjs line 149-155 signERC3009: domain = { name: extra.name, version: extra.version, chainId, verifyingContract: getAddress2(tokenAddress) } — no on-chain validation
- https://registry.npmjs.org/@x402/evm -> dist/esm/chunk-SGFNIWGK.mjs lines 2-26 EVM_NETWORK_CHAIN_ID_MAP (no 33139/33111 ApeChain) and lines 191-192 x402ExactPermit2ProxyAddress 0x402085c248EeA27D92E8b30b2C58ed07f9E20001 / x402UptoPermit2ProxyAddress 0x4020A4f3b7b90ccA423B9fabCc0CE57C6C240002
- https://registry.npmjs.org/@x402/core -> @x402/core@2.26.0 dist/esm/chunk-UF6R7D6H.mjs line 305: DEFAULT_FACILITATOR_URL = "https://x402.org/facilitator"
- https://registry.npmjs.org/x402 -> x402@1.2.0 dist/cjs/types/index.js line 1223: var schemes = ["exact"]; and dist/cjs/schemes/index.js line 1521 invalidReason: "invalid_exact_evm_payload_signature"; line 1629/1647 functionName: "transferWithAuthorization"
- https://raw.githubusercontent.com/circlefin/stablecoin-evm/master/contracts/v2/FiatTokenV2_2.sol lines 82-83: function _domainSeparator() internal override view returns (bytes32) { return EIP712.makeDomainSeparator(name, "2", _chainId()); }
- https://raw.githubusercontent.com/circlefin/stablecoin-evm/master/contracts/v2/EIP3009.sol: TRANSFER_WITH_AUTHORIZATION_TYPEHASH 0x7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267 and RECEIVE_WITH_AUTHORIZATION_TYPEHASH 0xd099cc98ef71107a616c4f0f941f04c322d8e254fe26b3c6668db87aae413de8
- https://github.com/coinbase/x402/commit/5aec174ae8323149a5e9d01be4f1839a243084fb.patch — x402 middleware: name: network === "base" ? "USD Coin" : network === "iotex" ? "Bridged USDC" : "USDC"
- https://github.com/awslabs/agentcore-samples/issues/2002 — AgentCore signed Base USDC EIP-3009 under "USDC" while the contract domain is "USD Coin"; result is invalid_exact_evm_payload_signature; '"USD Coin" recovers an unrelated address; "USDC" recovers the instrument's wallet'
- https://registry.npmjs.org/thirdweb -> thirdweb@5.121.4 dist/esm/x402/sign.js lines 219-238 (domain name/version taken from extra) and dist/esm/x402/common.js getSupportedSignatureType() — detects transferWithAuthorization vs permit from the ABI, prefers transferWithAuthorization
- https://registry.npmjs.org/@circle-fin/x402-batching -> @circle-fin/x402-batching@3.5.0 (published 2026-09-16) dist/server/index.mjs: baseSepolia usdc 0x036CbD53842c5426634e7929541eC2318f3dCF7e, base usdc 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
- https://docs.cdp.coinbase.com/x402/network-support (retrieved via web search summary, page itself EGRESS_BLOCKED) — CDP facilitator: Base, Polygon, Arbitrum, World + Solana; all ERC-20 via EIP-3009 or Permit2
- https://www.coinbase.com/en-fr/developer-platform/discover/launches/x402facilitator-polygon — CDP x402 facilitator launched on Polygon
- https://apescan.io/token/0x48b62137EdfA95a428D35C09E44256a739F6B557 — Wrapped ApeCoin (WAPE) ERC-20 on ApeChain (33139)
- local: /home/user/mog/gateway/lib/thirdweb.js:28 — const chainId = Number(process.env.X402_CHAIN_ID || 3313939) (invalid chain id)


## thirdweb-v5 — PARTIALLY_CORRECT

Directionally right, but three details are wrong and one is a hard bug risk.

(1) VERSION — CONFIRMED that v5 is current; no v6 exists. npm dist-tags for `thirdweb` as of 2026-09-21: latest = **5.121.4**, published 2026-09-11. Registry has zero `6.x` versions; `beta`/`alpha`/`next`/`dev` tags are all stale 2024 artifacts. mog pins `^5.115.3` (published 2025-12-06) — that is ~9 months / 6 minor versions behind. Note `nightly` is 5.120.2-nightly.

(2) CLIENT API — CONFIRMED, all import paths correct.
  - `createThirdwebClient` from `"thirdweb"`. Takes EITHER `{clientId}` OR `{secretKey}` (union type; throws "clientId or secretKey must be provided" if neither; a JWT secretKey REQUIRES clientId too).
  - `ConnectButton` from `"thirdweb/react"`.
  - `inAppWallet`, `createWallet`, `smartWallet` from `"thirdweb/wallets"`.
  - `useActiveAccount`, `useActiveWallet`, `useActiveWalletChain`, `useConnect`, `useSendTransaction`, `ThirdwebProvider` from `"thirdweb/react"`.
  - `inAppWallet({ auth: { options: [...] } })` is correct. Valid `AuthOption` values (src/wallets/types.ts): google, apple, facebook, discord, line, x, tiktok, epic, coinbase, farcaster, telegram, github, twitch, steam, guest, backend, email, phone, passkey, wallet. mog's `["google","apple","email","passkey"]` is all valid.
  - Smart accounts / sponsorGas: `sponsorGas` is NOT a top-level option. It lives under `smartAccount` for in-app wallets — `inAppWallet({ smartAccount: { chain, sponsorGas: true } })` — or as `smartWallet({ chain, sponsorGas: true })`. The bare `gasless` key is deprecated in favor of `sponsorGas`.

(3) SERVER-SIDE SIWE — CONFIRMED. `createAuth` from `"thirdweb/auth"` (NOT "thirdweb"). It returns exactly four methods: `generatePayload`, `verifyPayload`, `generateJWT`, `verifyJWT`. `generatePayload({address, chainId?})`; `verifyPayload({payload, signature})` returns a discriminated union `{valid:true, payload}` | `{valid:false, error}` — you MUST branch on `.valid`, the verified payload carries a hidden Symbol tag. Client-side counterpart is `signLoginPayload` from `"thirdweb/auth"`; `ConnectButton` also takes an `auth?: SiweAuthOptions` prop with `{getLoginPayload, doLogin, doLogout, isLoggedIn}`. `AuthOptions.domain` is the only required field.
  IMPORTANT for mog: `supabase/functions/_shared/wallet-proof.ts` does NOT use thirdweb auth at all — it uses `verifyMessage` from `npm:ethers@6`. So there is currently no thirdweb SIWE in this repo; adopting `createAuth` is net-new work, not a refactor.

(4) x402 — CONFIRMED REAL, and mog already uses it. Real exports from `"thirdweb/x402"`: `settlePayment`, `verifyPayment`, `facilitator`, `wrapFetchWithPayment`, `encodePayment`, `decodePayment`. Server wallets are real too, from `"thirdweb/engine"`: `serverWallet`, `createServerWallet`, `getServerWallets`, `searchTransactions`, `getTransactionStatus`, `waitForTransactionHash`. Facilitator hits `https://api.thirdweb.com/v1/payments/x402`.
  Where mog uses it: `/home/user/mog/gateway/index.js:6` imports `settlePayment`, calls it at line 44; `/home/user/mog/gateway/lib/thirdweb.js:2` imports and calls `facilitator({client, serverWalletAddress})`; `/home/user/mog/src/lib/x402.ts:1` imports `wrapFetchWithPayment`. It comes from the `thirdweb` package itself (subpath `thirdweb/x402`), which in turn depends on the standalone `x402@0.7.0` package for types only.
  ** THE V1/V2 TRAP — this is the important correction.** The protocol version is pinned by the thirdweb minor version:
    - thirdweb 5.115.3 (the pinned floor): `src/x402/types.ts` → `export const x402Version = 1;`
    - thirdweb 5.118.0 (what `gateway/package-lock.json` actually resolves): `export const x402Version: X402Version = 2;`
    - thirdweb 5.119.0 / 5.120.0 / 5.121.0 / 5.121.4: all `= 2`.
  So `^5.115.3` spans a silent v1→v2 protocol flip. v2 changed the 402 wire format: `PaymentRequiredResultV1` puts `{x402Version, error, accepts[...]}` in the response BODY; `PaymentRequiredResultV2` returns an EMPTY body (`Record<string, never>`) and base64-encodes payment requirements into the response HEADERS. Any gateway/client code that reads `result.responseBody.accepts` breaks under v2. Current versions accept both inbound (`z.union([z.literal(1), z.literal(2)])`) and default to emitting 2. An agent MUST pin an exact version and MUST NOT assume the body-based v1 shape.
  Also real but unmentioned: `scheme: "upto"` for usage-based settlement, and `waitUntil: "simulated" | "submitted" | "confirmed"` (default confirmed).

(5) CHAINS — PARTIALLY WRONG, and this is the hard bug risk. `base` IS a first-class export: `import { base } from "thirdweb/chains"` (id 8453), alongside `baseSepolia`. **`apeChain` is NOT exported from `thirdweb/chains`.** I enumerated the entire `src/exports/chains.ts` barrel in 5.121.4 — there is no ApeChain entry of any name (nearest neighbors alphabetically are `anvil`, `arbitrum`, `arbitrumNova`, `arbitrumSepolia`, `arcTestnet`). ApeChain MUST be constructed with `defineChain` from `"thirdweb/chains"` (or from `"thirdweb"`). mog already does this correctly in `/home/user/mog/src/lib/thirdweb.ts` and `/home/user/mog/gateway/lib/thirdweb.js`. If the plan tells an agent to `import { apeChain } from "thirdweb/chains"` it will fail to compile.

ENV VARS — the SDK reads NO environment variables automatically. `createThirdwebClient` takes `clientId`/`secretKey` as explicit arguments; there is no implicit env lookup anywhere in the client path. The names are a convention set by thirdweb's own templates (verified against the thirdweb-dev/js monorepo `.env.example`): `NEXT_PUBLIC_THIRDWEB_CLIENT_ID`, `NEXT_PUBLIC_THIRDWEB_AUTH_DOMAIN`, `THIRDWEB_SECRET_KEY`, `THIRDWEB_ADMIN_PRIVATE_KEY`. The SDK's own x402 docstrings consistently use `process.env.THIRDWEB_SECRET_KEY`. mog is on Vite, not Next, so its client var is `VITE_THIRDWEB_CLIENT_ID` (with a Supabase edge-function fallback reading the `THIRDWEB_CLIENT_ID` secret — see `/home/user/mog/supabase/functions/get-thirdweb-config/index.ts`). Gateway server vars in mog are `THIRDWEB_SECRET_KEY`, `THIRDWEB_SERVER_WALLET_ADDRESS`, `X402_CHAIN_ID`, `X402_RPC_URL`.

UNVERIFIABLE: the ApeChain chain IDs themselves (33139 mainnet in src/lib/thirdweb.ts, 3313939 default in gateway/lib/thirdweb.js). portal.thirdweb.com, chainid.network and the ApeChain RPC endpoints are all blocked by this environment's egress proxy, so I could not confirm either number against a primary source. Note 3313939 is an unusual value and does not match the commonly cited Curtis testnet id — an implementer should verify it before relying on it.

### Copy-paste snippet
```
// ---- install (pin exact: ^5.115.3 spans a silent x402 v1 -> v2 flip)
// npm i thirdweb@5.121.4

// ---- client (src/lib/thirdweb.ts) ----
import { createThirdwebClient, defineChain } from "thirdweb";
import { inAppWallet, createWallet } from "thirdweb/wallets";
import { base } from "thirdweb/chains";          // OK: first-class
// NOT AVAILABLE: import { apeChain } from "thirdweb/chains"  <-- does not exist
export const apeChain = defineChain({
  id: 33139,
  name: "ApeChain",
  rpc: "https://rpc.apechain.com",
  nativeCurrency: { name: "ApeCoin", symbol: "APE", decimals: 18 },
});

export const client = createThirdwebClient({
  clientId: import.meta.env.VITE_THIRDWEB_CLIENT_ID,   // Vite
  // Next.js: process.env.NEXT_PUBLIC_THIRDWEB_CLIENT_ID
});

export const wallets = [
  inAppWallet({
    auth: { options: ["google", "apple", "email", "passkey"] },
    smartAccount: { chain: apeChain, sponsorGas: true },  // sponsorGas lives HERE
  }),
  createWallet("io.metamask"),
  createWallet("com.coinbase.wallet"),
  createWallet("walletConnect"),
];

// ---- React ----
import { ConnectButton } from "thirdweb/react";
import { useActiveAccount } from "thirdweb/react";
const account = useActiveAccount();               // Account | undefined
<ConnectButton client={client} chain={apeChain} wallets={wallets} />

// ---- server SIWE: app/api/auth/login/route.ts (Next.js App Router) ----
import { createAuth } from "thirdweb/auth";        // NOT from "thirdweb"
import { createThirdwebClient } from "thirdweb";
import { cookies } from "next/headers";

const thirdwebAuth = createAuth({
  domain: process.env.NEXT_PUBLIC_THIRDWEB_AUTH_DOMAIN!,
  client: createThirdwebClient({ secretKey: process.env.THIRDWEB_SECRET_KEY! }),
});

// GET /api/auth/login?address=0x...&chainId=33139  -> issue payload
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const address = searchParams.get("address");
  if (!address) return Response.json({ error: "address required" }, { status: 400 });
  const payload = await thirdwebAuth.generatePayload({
    address,
    chainId: Number(searchParams.get("chainId") ?? 33139),
  });
  return Response.json(payload);
}

// POST /api/auth/login  body: { payload, signature }  -> verify + set JWT
export async function POST(req: Request) {
  const { payload, signature } = await req.json();
  const verified = await thirdwebAuth.verifyPayload({ payload, signature });
  if (!verified.valid) {
    return Response.json({ error: verified.error }, { status: 401 }); // MUST branch on .valid
  }
  const jwt = await thirdwebAuth.generateJWT({ payload: verified.payload });
  (await cookies()).set("jwt", jwt, { httpOnly: true, secure: true, sameSite: "strict" });
  return Response.json({ ok: true });
}

// ---- x402 server settlement (thirdweb 5.121.4 => emits x402 v2) ----
import { settlePayment, facilitator } from "thirdweb/x402";
const server = createThirdwebClient({ secretKey: process.env.THIRDWEB_SECRET_KEY! });
const tw402 = facilitator({
  client: server,
  serverWalletAddress: process.env.THIRDWEB_SERVER_WALLET_ADDRESS!,
  waitUntil: "confirmed",          // "simulated" | "submitted" | "confirmed"
});

const result = await settlePayment({
  resourceUrl: "https://api.example.com/premium",
  method: "GET",
  paymentData: req.headers.get("PAYMENT-SIGNATURE") ?? req.headers.get("X-PAYMENT"),
  payTo: "0x...",
  network: base,                   // or the defineChain'd apeChain
  price: "$0.10",
  facilitator: tw402,
  routeConfig: { description: "Premium API", mimeType: "application/json" },
});
if (result.status === 200) { /* settled */ }
// 402 branch: under x402 v2 responseBody is EMPTY ({}) and the requirements are
// base64 in result.responseHeaders. Do NOT read result.responseBody.accepts (v1-only shape).
return Response.json(result.responseBody, {
  status: result.status,
  headers: result.responseHeaders,
});

// ---- server wallets ----
import { serverWallet, createServerWallet, getServerWallets } from "thirdweb/engine";
```

### Caveats
- Verified 2026-09-21. thirdweb latest = 5.121.4, published 2026-09-11 — only 10 days old, so a newer 5.12x could land any day. Re-check dist-tags before pinning.
- HIGH RISK: `^5.115.3` in /home/user/mog/package.json and /home/user/mog/gateway/package.json spans a silent x402 protocol change. 5.115.3 emits x402Version 1 (requirements in the response BODY); 5.118.0+ emits x402Version 2 (empty body, requirements base64 in HEADERS). gateway/package-lock.json already resolves 5.118.0, so the running gateway is ALREADY on v2 while the manifest floor says v1. Pin an exact version and audit any code reading result.responseBody.accepts.
- The exact 5.11x release that flipped x402 v1->v2 sits between 5.115.3 and 5.118.0; I did not bisect 5.116/5.117. Only the endpoints of that interval are confirmed.
- `apeChain` is NOT a thirdweb/chains export — I enumerated the full export barrel in 5.121.4 to confirm. Any plan step saying `import { apeChain } from "thirdweb/chains"` is a compile error. Use defineChain. `base` and `baseSepolia` ARE first-class.
- UNVERIFIED: ApeChain chain IDs. portal.thirdweb.com, chainid.network, api.thirdweb.com and the ApeChain/Caldera RPCs are all blocked by this environment's egress proxy. 33139 (mainnet, src/lib/thirdweb.ts) and 3313939 (gateway default, gateway/lib/thirdweb.js) could not be confirmed against any primary source. 3313939 is anomalous and should be independently checked.
- The mog repo has TWO independent thirdweb installs with separate lockfiles (root and gateway/). They can drift to different x402 protocol versions. Bump both together.
- supabase/functions/_shared/wallet-proof.ts uses ethers@6 verifyMessage, NOT thirdweb createAuth. Any plan describing the SIWE work as a 'refactor' of existing thirdweb auth is wrong — it is new integration. Also note ethers is a thirdweb peerDependency (^5 || ^6), not a direct dep.
- createThirdwebClient does NOT read env vars implicitly. NEXT_PUBLIC_THIRDWEB_CLIENT_ID / THIRDWEB_SECRET_KEY are template conventions from thirdweb-dev/js, not SDK-enforced names. mog is Vite, so VITE_THIRDWEB_CLIENT_ID applies client-side; the NEXT_PUBLIC_ prefix would be inert there.
- The stale `beta` (5.0.0-beta, Mar 2024), `alpha` (1.0.0-alpha), `next` (0.13.0) and `dev` dist-tags are 2024 leftovers and resolve to ancient/unrelated code. Never install thirdweb@beta or thirdweb@next expecting a v6 preview — no 6.x exists.
- portal.thirdweb.com could not be fetched directly (EGRESS_BLOCKED); claims (2)-(5) rest on the published npm tarball source, which is the stronger primary source anyway. The x402 docs pages were only corroborated via search-result snippets.

### Evidence
- https://registry.npmjs.org/-/package/thirdweb/dist-tags -> {"latest":"5.121.4", ...}; no 6.x key in registry 'versions'
- https://registry.npmjs.org/thirdweb 'time' field: 5.121.4 = 2026-09-11T20:53:19.311Z; 5.115.3 = 2025-12-06T07:13:44.208Z
- tarball https://registry.npmjs.org/thirdweb/-/thirdweb-5.121.4.tgz -> package/package.json exports: ['.','./adapters/*','./ai','./auth','./bridge','./chains','./contract','./deploys','./engine','./event','./extensions/*','./insight','./modules','./package.json','./pay','./react','./react-native','./rpc','./social','./storage','./tokens','./transaction','./utils','./wallets','./wallets/*','./wallets/in-app','./x402']
- 5.121.4 package/src/exports/x402.ts -> exports settlePayment, verifyPayment, facilitator, wrapFetchWithPayment, encodePayment, decodePayment
- 5.121.4 package/src/exports/auth.ts -> exports createAuth, signLoginPayload, verifySignature, verifyEOASignature, verifyContractWalletSignature, parseErc6492Signature
- 5.121.4 package/src/auth/auth.ts -> createAuth(options: AuthOptions) returns {generateJWT, generatePayload, verifyJWT, verifyPayload}
- 5.121.4 package/src/auth/core/verify-login-payload.ts -> VerifyLoginPayloadResult = {valid:true,payload} | {valid:false,error}
- 5.121.4 package/src/x402/types.ts:16 -> export const x402Version: X402Version = 2; plus PaymentRequiredResultV1 (body) / PaymentRequiredResultV2 (empty body, headers)
- 5.115.3 package/src/x402/types.ts:14 -> export const x402Version = 1;  (v1 only, no V1/V2 union)
- 5.118.0 package/src/x402/types.ts:16 -> export const x402Version: X402Version = 2;  (v2 already active at the version gateway/package-lock.json resolves)
- 5.121.4 package/src/exports/chains.ts -> full barrel enumerated; contains 'base' (8453) and 'baseSepolia'; contains NO apeChain export
- 5.121.4 package/src/wallets/types.ts:22-50 -> socialAuthOptions[] and authOptions[] literal unions
- 5.121.4 package/src/wallets/in-app/core/wallet/types.ts:72-122 -> InAppWalletCreationOptions { auth: { options: InAppWalletAuth[] }, smartAccount?: SmartWalletOptions }
- 5.121.4 package/src/wallets/smart/types.ts:76-90 -> sponsorGas: boolean; 'gasless' marked @deprecated use 'sponsorGas' instead
- 5.121.4 package/src/exports/react.ts:81,83,84,167 -> useActiveAccount, useActiveWallet, useActiveWalletChain, ConnectButton
- 5.121.4 package/src/engine/index.ts -> serverWallet, createServerWallet, getServerWallets, searchTransactions, getTransactionStatus, waitForTransactionHash
- 5.121.4 package/src/x402/facilitator.ts -> DEFAULT_BASE_URL = 'https://api.thirdweb.com/v1/payments/x402'; ThirdwebX402FacilitatorConfig {client, serverWalletAddress, waitUntil?, vaultAccessToken?, baseUrl?}
- 5.121.4 package/src/client/client.ts:60-136 -> CreateThirdwebClientOptions union of {clientId} | {secretKey}
- https://raw.githubusercontent.com/thirdweb-dev/js/main/apps/playground-web/.env.example -> NEXT_PUBLIC_THIRDWEB_CLIENT_ID, NEXT_PUBLIC_THIRDWEB_AUTH_DOMAIN, THIRDWEB_SECRET_KEY, THIRDWEB_ADMIN_PRIVATE_KEY
- /home/user/mog/package.json -> "thirdweb": "^5.115.3"
- /home/user/mog/gateway/package-lock.json:9588 -> node_modules/thirdweb version 5.118.0; :10424 -> node_modules/x402 version 0.7.0
- /home/user/mog/gateway/index.js:6,44 -> import { settlePayment } from "thirdweb/x402"
- /home/user/mog/gateway/lib/thirdweb.js:2,21 -> import { facilitator } from "thirdweb/x402"
- /home/user/mog/src/lib/x402.ts:1 -> import { wrapFetchWithPayment } from "thirdweb/x402"
- /home/user/mog/src/lib/thirdweb.ts -> apeChain built via defineChain({id: 33139}), NOT imported from thirdweb/chains
- /home/user/mog/supabase/functions/_shared/wallet-proof.ts:1-2 -> uses npm:ethers@6 verifyMessage, no thirdweb auth
- /home/user/mog/supabase/functions/get-thirdweb-config/index.ts -> Deno.env.get("THIRDWEB_CLIENT_ID")
- portal.thirdweb.com and chainid.network blocked by egress proxy (EGRESS_BLOCKED) - chain IDs unverified


## supabase-project — CONFIRMED

All four claims are confirmed against the live Supabase Management API on 2026-09-21, with minor precision corrections.

(1) CONFIRMED. The account has exactly one organization: id AND slug both `lskgtzehnlfzimkxhwre`, display name "gratitude5dee's Org". get_organization returns "plan":"pro". Allowed release channels: ga, preview. Precision note: `lskgtzehnlfzimkxhwre` is the org ID/slug, not the org's name.

(2) CONFIRMED (and understated). Project `ixkkrousepsiorwlaycp`, name `wzrdstudio`, region us-west-1, status ACTIVE_HEALTHY, Postgres 17.6.1.084 (engine 17, ga). It is verifiably MogBook's project: /home/user/mog/supabase/config.toml contains `project_id = "ixkkrousepsiorwlaycp"` and .env points at https://ixkkrousepsiorwlaycp.supabase.co. Table count is 248 base tables in `public` (not "230+" — 248), i.e. 295 base tables across all non-system schemas (public 248, auth 27, realtime 8, storage 8, cron 2, net 2, vault 1, supabase_migrations 1, pgsodium 1). It is unambiguously a shared kitchen-sink DB.

(3) CONFIRMED. get_cost(type=project, organization_id=lskgtzehnlfzimkxhwre) returns {"type":"project","recurrence":"monthly","amount":10} = $10/mo. For contrast get_cost(type=branch) returns $0.01344/hour (~$9.81/mo if left running continuously), so a preview branch is not a cheaper alternative.

(4) CONFIRMED for this project (see caveats re "fleet"). On ixkkrousepsiorwlaycp (PG 17.6.1.084), list_extensions shows default_version and installed_version=null for: vector 0.8.0, pg_partman 5.3.1, pgmq 1.5.1 — i.e. available but NOT enabled, exactly as claimed.

TABLE CENSUS (exact): 248 public base tables. Tables the Mog/Musebook codebase actually queries (grep of .from() across src/, supabase/functions/, gateway/) AND that exist: 21-22 — mog_posts, mog_likes, mog_comments, mog_follows, mog_bookmarks, mog_agent_profiles, mog_rate_limits, music_tracks, music_albums, music_videos, music_streams, music_video_streams, music_transactions, music_video_transactions, music_entitlements, articles, content_likes, content_comments, content_bookmarks, engagement_payouts, token_config, user_karma. That is ~9% of the database. Foreign clusters: mrkt_* 20 (adtech/media buying), wzrd*/wzrdos_* 19 (studio app), af_* 12 (artist analytics), compute/workflow engine 11 (compute_graphs, compute_nodes, execution_runs, workflows...), design/print-on-demand 9, postz_* 9 (social scheduler), canvas/kanvas 8, plus 122 unbucketed singletons (venues, tour_contacts, gigs, tech_packs, merchandise_orders, podcasts, crawl_jobs, manus_tasks, screen_recordings, voice_clones, zaps, ticket_sales, press_quotes, ...). Roughly 226 of 248 tables are foreign to Musebook.

ADDITIONAL FINDING NOT IN THE CLAIM SET: 15 tables the Mog code references DO NOT EXIST in this project — stream_sessions, bot_job_configs, bot_job_runs, ops_event_logs, moltbook_profiles, wallet_nonces, api_idempotency_keys, agent_follows, agent_reports, agent_mog_likes, agent_mog_comments, agent_mog_bookmarks, agent_content_likes, agent_content_comments, agent_content_bookmarks. The repo's migrations through 20260305200000_phase4_ops_observability.sql are unapplied against ixkkrousepsiorwlaycp. So "reuse" is not even a working baseline today.

EXTENSIONS RELEVANT TO US (available vs enabled on ixkkrousepsiorwlaycp):
- vector 0.8.0 — available, NOT installed
- pg_partman 5.3.1 — available, NOT installed
- pgmq 1.5.1 — available, NOT installed
- pg_trgm 1.6 — available, NOT installed
- btree_gin 1.3 — available, NOT installed
- pg_cron — default_version 1.6.4, INSTALLED at 1.6, schema pg_catalog
- pgcrypto 1.3 — INSTALLED, schema extensions
Also already installed: pg_net 0.20.0 (in schema `public` — itself an advisor finding), pg_stat_statements 1.11, uuid-ossp 1.1, pgsodium 3.1.8, supabase_vault 0.3.1, pg_graphql 1.5.11, plpgsql 1.0.

SECURITY ADVISORS FIRING (8 lint types, get_advisors type=security, observed_at 2026-09-21T04:55:08Z):
- WARN pg_graphql_anon_table_exposed — 230 findings: 230 tables SELECTable by the `anon` role and therefore visible in the GraphQL/REST schema pre-signin.
- WARN pg_graphql_authenticated_table_exposed — 231 findings.
- WARN anon_security_definer_function_executable — 55 findings: SECURITY DEFINER functions callable by `anon` via /rest/v1/rpc/, including add_credits, deduct_credits, use_credits, credits_commit, credits_reserve, credits_release, grant_free_credits, get_available_credits, get_user_email, get_recent_signups_admin, get_dashboard_stats, update_user_wallet. This is an unauthenticated credit-mutation surface.
- WARN authenticated_security_definer_function_executable — 55 findings (same functions).
- INFO rls_enabled_no_policy — 17 tables with RLS ON but zero policies: gmi_generation_settlements, wallet_auth_nonces, wzrd_fanpic_history_claims, wzrd_fanpic_runs, wzrd_generation_events, wzrd_generation_runs, wzrd_inbound_events, wzrd_ol_context, wzrd_studio_asset_casts, wzrd_studio_assets, wzrd_studio_boards, wzrd_studio_casts, wzrd_studio_delete_outbox, wzrd_studio_operation_casts, wzrd_studio_operations, wzrd_studio_panels, wzrd_studio_sheets.
- WARN extension_in_public — pg_net installed in `public`.
- WARN auth_otp_long_expiry — email OTP expiry > 1 hour.
- WARN auth_leaked_password_protection — HaveIBeenPwned checking disabled.

PERFORMANCE ADVISORS FIRING (get_advisors type=performance):
- WARN auth_rls_initplan — 495 findings across 174 tables (unwrapped auth.uid()/current_setting re-evaluated per row). Includes every mog_* and music_* table: audio_tracks, mog_agent_profiles, mog_bookmarks, mog_comments, mog_follows, mog_likes, mog_posts, mog_rate_limits, music_entitlements, music_items, music_streams, music_transactions, music_video_streams, music_video_transactions, song_likes, track_items, tracks.
- WARN multiple_permissive_policies — 208 findings across 27 tables (incl. mog_agent_profiles, mog_comments).
- INFO unused_index — 344 findings across 153 tables.
- INFO unindexed_foreign_keys — 108 findings across 81 tables (incl. mog_comments, mog_posts, music_entitlements, music_video_transactions, track_items, tracks).
- WARN duplicate_index — 4 findings across 3 tables (incl. mog_posts).
- INFO table_bloat — 1 finding.
- INFO auth_db_connections_absolute — 1 finding.

RECOMMENDATION: FRESH PROJECT. Create a new project in org lskgtzehnlfzimkxhwre at $10/mo. Reasons compound: (a) ~91% of the public schema belongs to a dozen unrelated applications; (b) Musebook would silently inherit 55 anon-callable SECURITY DEFINER functions that mutate credit balances and a 230-table anon-readable GraphQL surface it did not author and cannot safely lock down without breaking other apps; (c) fixing RLS on a shared public schema means auditing 174 tables owned by other products; (d) the 495 auth_rls_initplan findings are a rewrite-every-policy job on someone else's policies.

MIGRATION IMPLICATION (the decisive fact): there is effectively nothing to migrate. Live row counts (pg_stat_user_tables.n_live_tup) across every Mog/music/content table total roughly 200 rows: music_video_streams 22, music_video_transactions 22, articles 21, music_streams 21, music_transactions 21, music_tracks 15, music_videos 12, engagement_payouts 10, mog_posts 8, token_config 5, music_albums 5, content_likes 5, mog_likes 3, user_karma 3, mog_bookmarks 2, mog_agent_profiles 1, mog_comments 1, and 0 rows in mog_follows, mog_rate_limits, music_items, music_entitlements, content_bookmarks, content_comments. This is seed/dev data, not production. So the migration is a schema replay, not a data migration: apply supabase/migrations/ cleanly against the new project (which also lands the 15 currently-missing tables), enable vector/pg_partman/pgmq/pg_trgm/btree_gin into a dedicated `extensions` schema, and author RLS once using (select auth.uid()) so the initplan class of findings never appears. Only Storage objects and edge-function secrets need manual carry-over. Reuse costs more engineering hours in advisor remediation than $10/mo saves.

### Copy-paste snippet
```
-- Target: NEW project in org lskgtzehnlfzimkxhwre ($10/mo, confirmed via get_cost).
-- Do NOT reuse ixkkrousepsiorwlaycp (248 public tables, ~226 foreign).

-- 1) Keep extensions out of `public` (the existing project's pg_net-in-public is a firing advisor).
create schema if not exists extensions;

-- 2) Enable exactly what Musebook needs. Versions verified available on PG 17.6.x, 2026-09-21.
create extension if not exists vector      with schema extensions;  -- 0.8.0
create extension if not exists pg_partman  with schema extensions;  -- 5.3.1
create extension if not exists pgmq        with schema extensions;  -- 1.5.1
create extension if not exists pg_trgm     with schema extensions;  -- 1.6
create extension if not exists btree_gin   with schema extensions;  -- 1.3
-- pgcrypto (1.3) and pg_cron (1.6) are already enabled by Supabase by default;
-- pgcrypto lands in `extensions`, pg_cron in `pg_catalog`. Do not re-create them.

-- 3) Write every RLS policy this way from day one. The bare form auth.uid() is what
--    produces the 495 `auth_rls_initplan` findings on the old project: wrapping it in a
--    scalar subquery makes Postgres evaluate it once per statement, not once per row.
alter table public.mog_posts enable row level security;

create policy "mog_posts_select_own"
  on public.mog_posts
  for select
  to authenticated
  using ( user_id = (select auth.uid()) );   -- NOT: user_id = auth.uid()

-- 4) Close the surface the old project leaves open by default: revoke blanket SELECT
--    from anon on anything not meant to be discoverable pre-signin, and never leave a
--    credit-mutating SECURITY DEFINER function executable by anon.
revoke execute on function public.add_credits(integer, text, jsonb) from anon, authenticated;
```

### Caveats
- Claim (4) says 'the Postgres 17 fleet'. I verified these versions on ONE project, ixkkrousepsiorwlaycp (PG 17.6.1.084), via list_extensions. Other PG17 projects in the org run different patch levels (17.4.1.054, 17.6.1.003, 17.6.1.127, 17.6.1.147, 17.6.1.155), and a project created today could be provisioned on a newer image with different extension default_versions. The implementing agent should re-run list_extensions on the NEW project before pinning any version in code.
- get_cost returns amount:10 with no currency field. USD is the reasonable reading for Supabase Pro compute add-ons but the API does not state it. Also, $10/mo is the standard Pro-plan compute cost for an additional Micro-size project; larger compute sizes cost more, and the org's included compute credit may offset the first project only.
- Advisor counts are a snapshot: security lints observed_at 2026-09-21T04:55:08.983Z, performance lints from the same run. Supabase re-runs the linter periodically and counts will drift as other apps in wzrdstudio change.
- The 'plausibly Musebook-related vs foreign' split is my classification from prefix analysis plus a grep of .from() calls in /home/user/mog. The 122-table 'other' bucket contains genuinely ambiguous shared tables (profiles, users, transactions, jobs, media_assets, creator_balances, revenue_distributions, wallet_*) that several apps in this DB appear to share. If the real answer matters for a reuse decision, note that this ambiguity is itself an argument for a fresh project — nobody can currently say who owns `profiles` or `transactions`.
- Row counts come from pg_stat_user_tables.n_live_tup, which is a planner estimate refreshed by autovacuum, not an exact count(*). At these magnitudes (0-22 rows) the conclusion 'nothing to migrate' is safe, but do not quote these as exact figures.
- I did not enumerate Storage buckets/objects or edge-function secrets for the existing project, so the 'only manual carry-over' claim in the migration plan is scoped to what the database tools can see. Per instruction, no secret values, service-role keys, or connection strings were retrieved or printed.
- list_organizations returned exactly one org, so there is no second org to confuse this with — but that also means a fresh project inherits the same Pro-plan billing account and the same org-level opt-in tags (AI_SQL_GENERATOR_OPT_IN, AI_LOG_GENERATOR_OPT_IN, AI_DATA_GENERATOR_OPT_IN).

### Evidence
- mcp__Supabase__list_organizations -> {"organizations":[{"id":"lskgtzehnlfzimkxhwre","slug":"lskgtzehnlfzimkxhwre","name":"gratitude5dee's Org"}]}
- mcp__Supabase__get_organization(id=lskgtzehnlfzimkxhwre) -> {"id":"lskgtzehnlfzimkxhwre","name":"gratitude5dee's Org","plan":"pro","allowed_release_channels":["ga","preview"]}
- mcp__Supabase__get_cost(type=project, organization_id=lskgtzehnlfzimkxhwre) -> {"type":"project","recurrence":"monthly","amount":10}
- mcp__Supabase__get_cost(type=branch, organization_id=lskgtzehnlfzimkxhwre) -> {"type":"branch","recurrence":"hourly","amount":0.01344}
- mcp__Supabase__list_projects -> ixkkrousepsiorwlaycp / name 'wzrdstudio' / us-west-1 / ACTIVE_HEALTHY / database.version 17.6.1.084 / postgres_engine 17 / created_at 2025-02-23T17:42:07Z (30 projects total in org; only 4 ACTIVE_HEALTHY: wzrdstudio, rmxstudio, livewzrd, airv2)
- mcp__Supabase__list_extensions(project_id=ixkkrousepsiorwlaycp) -> vector default_version 0.8.0 installed_version null; pg_partman 5.3.1 installed null; pgmq 1.5.1 installed null; pg_trgm 1.6 installed null; btree_gin 1.3 installed null; pg_cron default 1.6.4 installed 1.6 schema pg_catalog; pgcrypto 1.3 installed 1.3 schema extensions; pg_net 0.20.0 installed schema public
- mcp__Supabase__execute_sql(ixkkrousepsiorwlaycp): select table_schema,count(*) from information_schema.tables where table_type='BASE TABLE' -> public 248, auth 27, realtime 8, storage 8, cron 2, net 2, vault 1, supabase_migrations 1, pgsodium 1
- mcp__Supabase__execute_sql(ixkkrousepsiorwlaycp): full public table name list (248 names, incl. mrkt_* x20, wzrd*/wzrdos_* x19, af_* x12, postz_* x9, canvas/kanvas x8, mog_* x7, music_* x9)
- mcp__Supabase__execute_sql(ixkkrousepsiorwlaycp): prefix bucket counts -> other 122, mrkt_ 20, wzrd*/wzrdos 19, af_ 12, compute/workflow 11, music_ 9, design/print-on-demand 9, postz_ 9, content_ 8, canvas/kanvas 8, mog_ 7, wallet_ 7, billing/credits 7
- mcp__Supabase__execute_sql(ixkkrousepsiorwlaycp): existence check of 36 code-referenced tables -> 21 exist, 15 missing (stream_sessions, bot_job_configs, bot_job_runs, ops_event_logs, moltbook_profiles, wallet_nonces, api_idempotency_keys, agent_follows, agent_reports, agent_mog_{likes,comments,bookmarks}, agent_content_{likes,comments,bookmarks})
- mcp__Supabase__execute_sql(ixkkrousepsiorwlaycp): select relname,n_live_tup from pg_stat_user_tables -> music_video_streams 22, music_video_transactions 22, articles 21, music_streams 21, music_transactions 21, music_tracks 15, music_videos 12, engagement_payouts 10, mog_posts 8, token_config 5, music_albums 5, content_likes 5, mog_likes 3, user_karma 3, mog_bookmarks 2, mog_agent_profiles 1, mog_comments 1, rest 0
- mcp__Supabase__get_advisors(project_id=ixkkrousepsiorwlaycp, type=security) -> 8 lint types; raw saved at /root/.claude/projects/-home-user-mog/fd320bdb-4628-5b5d-a380-543979d8bc42/tool-results/mcp-Supabase-get_advisors-1789966511165.txt (208188 chars): pg_graphql_anon_table_exposed 230 findings, pg_graphql_authenticated_table_exposed 231, anon_security_definer_function_executable 55, authenticated_security_definer_function_executable 55, rls_enabled_no_policy 17, extension_in_public 1 (pg_net), auth_otp_long_expiry 1, auth_leaked_password_protection 1
- mcp__Supabase__get_advisors(project_id=ixkkrousepsiorwlaycp, type=performance) -> raw saved at /root/.claude/projects/-home-user-mog/fd320bdb-4628-5b5d-a380-543979d8bc42/tool-results/mcp-Supabase-get_advisors-1789966553790.txt (474064 chars): auth_rls_initplan 495 findings/174 tables, unused_index 344, multiple_permissive_policies 208, unindexed_foreign_keys 108, duplicate_index 4, table_bloat 1, auth_db_connections_absolute 1
- /home/user/mog/supabase/config.toml -> project_id = "ixkkrousepsiorwlaycp"
- /home/user/mog/.env and /home/user/mog/src/integrations/supabase/client.ts -> https://ixkkrousepsiorwlaycp.supabase.co
- /home/user/mog/supabase/migrations/ -> latest migration 20260305200000_phase4_ops_observability.sql (unapplied against ixkkrousepsiorwlaycp)
- https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy
- https://supabase.com/docs/guides/database/database-linter?lint=0014_extension_in_public
- https://supabase.com/docs/guides/database/database-linter?lint=0026_pg_graphql_anon_table_exposed
- https://supabase.com/docs/guides/database/database-linter?lint=0028_anon_security_definer_function_executable
- https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection
