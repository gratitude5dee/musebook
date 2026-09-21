# MUSEBOOK ARCHITECTURAL SPINE — binding decisions

Every plan.md section MUST conform to this. It is the output of a scored 3-way architecture
bake-off plus a 10-claim primary-source verification pass. Do not re-litigate these decisions;
do not rename these identifiers. If a section needs something this spine does not define,
define it in that section and flag it in "Open questions".

## 0. The product, in one paragraph
Musebook is an agentic media platform at musebook.dev. A creator (human or their agent) composes
once; Musebook classifies it, ranks it into personalized feeds, fans it out to every social
platform reformatted per-platform, serves it to humans as a page and to agents as MCP tools and
`.md`/`.json` twins, and prices agent access with x402. Every post carries a publishing mode that
decides who pays. MogBook is the reference implementation being superseded.

## 1. THE STACK CALL (final)
- **Vercel** — team `team_PYXAVq4jrHw8k0bNffmhc2jE` (5-Dee Studios), owns `musebook.dev`
  (verified zone, ns1/ns2.vercel-dns.com, expires 2027-08, `renew:false` — MILESTONE 0 is to turn
  renewal on). Owns: Next.js 16.3.5 App Router serving, `proxy.ts`, all route handlers, the remote
  MCP server, Vercel Blob, Cron, WAF/BotID.
- **Supabase** — org `lskgtzehnlfzimkxhwre`. A **NEW project** (`musebook-prod`), Postgres 17.
  Single system of record: identity, content, social graph, events, pgvector embeddings, ledger, RLS.
  NOT `ixkkrousepsiorwlaycp` ("wzrdstudio"). Measured 2026-09-21: that project holds **248 base
  tables in `public`** (295 across all schemas) and only **21-22 of them (~9%) are Mog's**. The rest
  are foreign clusters: `mrkt_*` adtech (20), `wzrd*`/`wzrdos_*` (19), `af_*` artist analytics (12),
  a compute/workflow engine (11), print-on-demand (9), `postz_*` (9), canvas (8), plus 122
  unbucketed singletons. Its migration chain is also unreplayable (16 migration-created tables
  absent from the live DB; the first migration indexes columns on tables that no longer exist).
  Org plan is **Pro**; a new project costs **$10/mo** (`get_cost` verified). A preview branch is
  $0.01344/hr (~$9.81/mo if left running) so branching is not a cheaper substitute.
  `vector 0.8.0`, `pg_partman 5.3.1`, `pgmq 1.5.1` are AVAILABLE BUT NOT ENABLED — enable explicitly.
- **Neon — DROPPED.** Supabase Branching covers per-PR branches. A second Postgres buys two
  migration chains and application-level joins for zero capability gain.
- **Convex — DROPPED for v1.** Ranking is CPU-bound (does not fit a 1s query budget); the
  per-impression event firehose is billed per function call. Revisit only for live co-editing.
- **Postiz** — self-hosted v1.47.0 sidecar at `postiz.musebook.dev`, driven over `/public/v1`.
  AGPL-3.0 with no carve-out: process separation only. NEVER vendor `libraries/nestjs-libraries/
  src/integrations` into our bundle — that would force all of Musebook to AGPL. CI must enforce it.

## 2. THE TWO FUNCTIONS NO SURFACE MAY BYPASS
```ts
resolveAccess(resource: Resource, actor: Actor): Promise<AccessDecision>
renderResource(resource: Resource, as: Representation, decision: AccessDecision): Promise<Rendered>
```
`Representation = 'html' | 'markdown' | 'json' | 'jsonld' | 'mcp' | 'feed'`.
Built at milestone 4/5 with NO route attached, proven by 24 golden fixtures
(3 publish modes x 2 actor classes x 4 representations). An ESLint rule bans reading
`publish_mode` anywhere outside `packages/kernel`. One function means a human and an agent can
never be sold different bytes.

## 3. INVARIANTS (violating any of these is a build failure, not a bug)
1. **content_hash** = `sha256(canonical markdown)` is the universal join key: ETag, x402 grant
   binding key, classification cache key, score cache key, C2PA assertion. An edit after purchase
   is therefore automatically a new purchase and a new classification.
2. **Candidate isolation.** No scorer may read a cross-candidate feature. Enforced by
   `packages/muse-mixer/test/isolation.test.ts`: score one candidate alone, then inside a batch of
   200, assert bit-identical output. Merge gate. This is what makes score caching and page-2
   pagination stability correct.
3. **Log position from slate one.** `action_events` carries `slate_id`, `position`,
   `weights_version`, `model_version` from the FIRST slate ever served — literal values
   `'reverse_chron'` / `'none'` before a ranker exists. Omitting them is irreversible data loss:
   every later model trained on that window learns "the previous ranker was right".
4. **Hot/cold split.** Counters NEVER live on the post row. `post_counters` is a separate table.
5. **Runtime weights.** Ranking weights load per-request from a `ranking_weights` row keyed by
   `weights_version`. Never hardcoded, never compiled in.
6. **Zero platform imports** in `packages/muse-mixer/src/` — `adapters/` is the only place `pg` or
   `@vercel/*` may appear. The identical pipeline runs in a route, a worker, and an offline replay.
7. **Three distinct scores, never conflated.** `actionScores` (per-action probabilities, pure per
   viewer-post, cacheable) -> `weightedScore` (runtime-weighted linear combination, still pure) ->
   `score` (after creator-diversity attenuation; slate-dependent, NOT cacheable). Conflating them
   produces duplicate or vanishing posts across pages.
8. **Parallel sources and hydrators, sequential filters and scorers.** Preserve x-algorithm's
   asymmetry. Filters see survivors; scorers read prior scorers' fields.
9. **Never fail closed on the feed, never fail open on the paywall.** A failed source returns 0
   candidates and the pipeline continues. A failed access check denies.

## 4. VERIFIED TECHNICAL FACTS (primary-source checked 2026-09-21; override any conflicting memory)
- **Next.js 16.3.5.** `middleware.ts` is DEPRECATED and renamed `proxy.ts`; exported fn renamed
  `middleware` -> `proxy`. Codemod `npx @next/codemod@canary middleware-to-proxy .`.
  `export const config = { runtime: 'nodejs' }` in proxy.ts **THROWS** — proxy is ALWAYS Node and
  the runtime is NOT configurable. Edge runtime is unsupported in proxy. Both files present = hard
  build throw. Wrong filename does NOT fail open — it warns and still runs.
- **MCP PROTOCOL REVISION 2026-07-28 IS CURRENT AND IS A BREAKING REDESIGN.** Verified against the
  spec repo (`schema/2026-07-28/schema.ts:30` `LATEST_PROTOCOL_VERSION = "2026-07-28"`; `schema/draft`
  reads the same, so nothing newer exists). What changed, and it is load-bearing for `apps/mcp`:
  MCP is now **STATELESS** — the `initialize`/`notifications/initialized` handshake is REMOVED
  (SEP-2575; zero hits for "initialize" in the schema) and the `Mcp-Session-Id` header is REMOVED
  from Streamable HTTP (SEP-2567). New `server/discover` RPC (`schema.ts:666`) which servers MUST
  implement. `RequestParams._meta` is now NON-OPTIONAL on requests (`schema.ts:179-181`) carrying
  `io.modelcontextprotocol/protocolVersion` + `/clientCapabilities` — but `_meta` stays OPTIONAL on
  notifications and results. `Result.resultType` is NON-OPTIONAL (`schema.ts:234`,
  `"complete" | "input_required" | string`). **MRTR** (Multi Round-Trip Request, SEP-2322) REPLACES
  all server-initiated requests: no more `roots/list`, `sampling/createMessage`, or
  `elicitation/create` — a server returns `InputRequiredResult` and the client retries with
  `inputResponses` + `requestState`. Also gone: the HTTP GET endpoint, `resources/subscribe` (now
  `subscriptions/listen`), `ping`, `logging/setLevel`, SSE resumability/`Last-Event-ID`. DCR is
  deprecated in favor of CIMD (Client ID Metadata Documents).
- **MCP packages.** SDK v2 split the TypeScript SDK: `@modelcontextprotocol/core@2.0.0` +
  `@modelcontextprotocol/server@2.0.0` (both real, published 2026-07-27, by Anthropic PBC).
  `@modelcontextprotocol/sdk@1.30.0` is the LEGACY v1 line. Vercel's adapter is
  `mcp-handler@2.2.0` (peer-deps `@modelcontextprotocol/server@^2.0.0`, `next>=13`). Requires
  `zod@^4.2.0`, Node 20+. Use `server.registerTool` (variadic `server.tool` REMOVED);
  `inputSchema` takes a full `z.object({...})`, not a raw shape; auth is `ctx.http?.authInfo`;
  export only GET and POST. Vercel's own docs still show the dead 1.x API — ignore them.
- **x402.** Canonical repo is now `x402-foundation/x402` (coinbase/x402 is a dev fork).
  Current protocol version = **2** (`@x402/core` exports `x402Version = 2`; npm latest 2.26.0).
  v2 headers: `PAYMENT-REQUIRED` (server->client, NEW in v2, replaces v1's JSON body),
  `PAYMENT-SIGNATURE` (client->server, was `X-PAYMENT`), `PAYMENT-RESPONSE` (was
  `X-PAYMENT-RESPONSE`). A real MCP binding is specified in `specs/transports-v2/mcp.md`:
  payment-required = tool result with `isError:true` + `structuredContent`; client retries with
  `_meta["x402/payment"]`; settlement returns in `_meta["x402/payment-response"]`.
  MogBook implements v1 — migrate.
- **USDC EIP-712 domain.** Base MAINNET (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`) domain name
  is **"USD Coin"**. Base SEPOLIA (`0x036CbD53842c5426634e7929541eC2318f3dCF7e`) is **"USDC"**.
  Both version `"2"`, 6 decimals, both support EIP-3009. Copying the sepolia example to mainnet
  makes every gated route unpayable with an opaque `invalid_exact_evm_payload_signature`.
  Native $APE is structurally unusable as an x402 asset (`asset` is always an ERC-20 address).
- **Bot detection — THE DECISIVE CONSTRAINT.** `botid@1.5.11` (`checkBotId` from `botid/server`)
  **cannot gate a bare page GET**. It only classifies fetch/XHR routes registered via
  `initBotId({protect:[...]})` client-side, and in local dev it returns
  `{isHuman:true, bypassed:true}` — it fails open to HUMAN. Therefore Mode 2 is built as a
  **declared, incentivized contract**, layered by reliability:
    1. Web Bot Auth (RFC 9421 HTTP Message Signatures + `Signature-Agent`, verified against the
       agent's `/.well-known/http-message-signatures-directory`) — cryptographic, reliable.
    2. Verified-crawler reverse DNS (GPTBot, ClaudeBot, PerplexityBot...).
    3. Vercel WAF managed ruleset `ai_bots` (JS-free, first request).
    4. JA4/TLS fingerprint + header-order heuristics — probabilistic.
    5. BotID Deep Analysis — second request only, never the first.
  STATE PLAINLY IN THE PLAN: an agent driving a real headless browser from residential IPs that
  declines to sign is NOT distinguishable from a human at any layer. "Agent fetching for a live
  human" vs "agent crawling for training" is declared intent, not an observable property.
- **WebMCP.** Real: W3C Web Machine Learning CG draft, `Status: CG-DRAFT` (a CG report, NOT
  standards track). API is **`document.modelContext`** (moved off `navigator` in commit c7b5c70,
  2026-05-27) with `registerTool()` returning a **Promise** (it was synchronous pre-move).
  Chrome/Edge origin trial. Ship it as progressive enhancement behind a feature check; never a
  dependency.
- **Postiz v1.47.0.** pnpm workspace (NOT Nx — no nx.json), NestJS 11 backend, Next.js 16.3.1
  frontend, **Temporal** worker at `apps/orchestrator` with versioned workflow files, BullMQ fully
  removed, Prisma 6.5.0, Node `>=22.12.0 <23`. AGPL-3.0, 661-line verbatim license, no `/ee/`.
  `/public/v1` REST API authenticated with a RAW `Authorization: <apiKey>` header — **no `Bearer`
  prefix**. Batch ALL per-platform variants into ONE `POST /public/v1/posts` call (rate limit is
  per-post, not per-channel). A `moltbook.provider.ts` (~130 lines) exists as a 1:1 model for a
  new `musebook.provider.ts` to contribute upstream.
- **Typesafe / Jev.** SDK is **`@typesafe-ai/sdk`** v0.6.0 (NOT `typesafe-ai`, NOT `@typesafe/sdk`
  — both 404). `new TypeSafeClient()` no args; env `TYPESAFE_API_KEY` (throws if absent),
  `TYPESAFE_BASE_URL` (default `https://api.typesafe.ai`), `TYPESAFE_DEFAULT_MODEL` (default
  `jev-latest`). Wire auth is `Authorization: Bearer <key>`. Call is
  `client.systemOne(request, options?)` -> `POST /v1/systemone`. Timeout 10s, maxRetries 2.
  NOTE: docs.typesafe.ai is blocked by this environment's egress proxy; all of the above comes
  from the published npm tarball and the typesafe-ai GitHub org.
- **thirdweb v5.121.4** (mog pins ^5.115.3, ~6 minors behind; no v6 exists).
  `createThirdwebClient` from `"thirdweb"`; `ConnectButton` from `"thirdweb/react"`;
  `inAppWallet`/`createWallet`/`smartWallet` from `"thirdweb/wallets"`; **`createAuth` from
  `"thirdweb/auth"`** returning exactly `generatePayload`/`verifyPayload`/`generateJWT`/`verifyJWT`
  (`verifyPayload` returns a discriminated union — you MUST branch on `.valid`).
  `sponsorGas` is NOT top-level: `inAppWallet({ smartAccount: { chain, sponsorGas: true } })`.
- **x-algorithm has DRIFTED from the installed skill.** The live repo has SimClusters back as a
  first-class component (the skill says it is gone); there is no `author_diversity_scorer.rs` —
  diversity is now a DPP in `vm_ranker.rs`; there are ~34 runtime weight params, not 22.
  Cite the live repo, and note the skill's staleness where it matters.

## 5. WHAT ALL THREE ARCHITECTURES MISSED — every section must close these
- No `follows` / `blocks` / `mutes` / `likes` / `comments` / `bookmarks` / `reposts` tables existed,
  yet follow-graph was ranking source #1 in all three. Define the social graph.
- No `article`/blog entity, though the brief says "blogs are automatically crawl-optimized".
- The **per-platform reformatting engine** — a headline requirement — was an empty filename in all
  three. Specify it fully: constraint table, LLM pass, deterministic validator, preview, fallback.
- **WebMCP** got one sentence in all three. Specify it as a real subsystem.
- Named connectors (muse/air/codex/claude/hermes/pi/openclaw) were deferred to a user question.
  Ship an open manifest-driven registry with 4 transports + named adapters for the 4 verifiable
  ones, and say honestly which 3 are ambiguous.
- No cost model, no observability/alerting/runbook, no privacy/consent/deletion surface, no seed
  or fixture strategy, and no MVP cut line. All required.

## 6. NAMING (fixed — do not vary)
Packages: `@musebook/kernel` (resolveAccess/renderResource), `@musebook/muse-mixer` (ranking),
`@musebook/content` (canonicalization, content_hash, representations), `@musebook/distributor`
(Postiz + reformat), `@musebook/connectors` (agent registry), `@musebook/x402`,
`@musebook/schema` (shared types + zod), `@musebook/ui`.
Apps: `apps/web` (Next.js), `apps/mcp` (remote MCP), `apps/worker` (ranking + jobs).
Tables: snake_case, plural. Events: `action_events` (partitioned). Slates: `slates`.
