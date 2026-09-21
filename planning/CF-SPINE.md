# MUSEBOOK CLOUDFLARE SPINE — binding decisions for the v2 architecture

This SUPERSEDES the Vercel-everywhere decisions in the original SPINE.md wherever they conflict.
Everything in SPINE.md not contradicted here still stands — especially the nine invariants, the
two-function kernel, content_hash as universal key, and candidate isolation.

Every fact below was verified against a primary source on 2026-09-21. Full evidence:
`scratchpad/cf/CF-VERIFIED.md` and the ten per-topic files beside it.

## 0. THE TOPOLOGY
```
registrar:    Vercel (unchanged)
nameservers:  Cloudflare  ← the one change; already proven on wzrd.tech in this same account

musebook.dev            CF proxied → musebook-edge Worker → Vercel origin (Next.js 16 frontend)
mcp.musebook.dev        musebook-mcp Worker (remote MCP, agents@0.24.0)
media.musebook.dev      musebook-edge Worker route → R2 binding (PAID media, after grant check)
cdn.musebook.dev        R2 custom domain on musebook-public (FREE media; no Worker in path)
artifacts.musebook.dev  musebook-edge Worker route → R2 binding (sandboxed 2D/3D)
postiz.musebook.dev     Postiz sidecar (unchanged)
```
Vercel hosts the frontend. Cloudflare owns the edge, the money path, storage and async work.
Supabase remains the system of record.

## 1. DNS AND THE VERCEL SEAM — four non-negotiables
1. **SSL/TLS mode = Full (strict).** Vercel's CDN unconditionally 308-redirects HTTP→HTTPS, so
   Flexible is a guaranteed `ERR_TOO_MANY_REDIRECTS` loop. Set this BEFORE pointing the record.
2. **Apex is a proxied CNAME to the value on the Vercel project's domain card** — Vercel now issues
   per-project targets (e.g. `xyz.vercel-dns-016.com`); do not hardcode `cname.vercel-dns.com` from
   memory. Cloudflare flattens the apex CNAME automatically.
3. **Do NOT enable `global_fetch_strictly_public`.** The default same-zone routing sends
   `fetch(request)` straight to the Vercel origin with no 1019 loop. Corollary: that subrequest
   bypasses Cloudflare's own security settings, so **all gating must complete in Worker code before
   the fetch**.
4. **The Vercel origin stays publicly reachable at `<project>.vercel.app`, so the paywall is
   bypassable.** This is not fixable with DNS. The Worker MUST set a shared secret header
   `x-musebook-edge: <MUSEBOOK_EDGE_SECRET>`; Next.js `proxy.ts` MUST reject any request lacking it
   with 404. `proxy.ts` no longer gates content — origin authentication is its only remaining job.

**Vercel's IP-dependent features are DEAD in this topology** (real client IP is Enterprise-only
behind a proxy). `x-vercel-ip-country`, `geolocation()`, `ipAddress()`, Vercel WAF IP rules and
IP-keyed rate limiting all stop working. The Worker reads `request.cf.country` and the true client IP
and forwards them as signed `x-mb-*` headers. §15.10's geo read moves to the Worker.
Also expect Vercel's domain card to read "Invalid Configuration" permanently — cosmetic; document it
so nobody "fixes" it by grey-clouding the record and silently removing the Worker from the path.
Wildcard certs need DNS-01 and will not auto-renew off Vercel NS — avoid wildcards; enumerate hosts.

## 2. DATA ACCESS — Hyperdrive, and a REAL security finding
- Driver: **`pg` (node-postgres) ≥ 8.16.3** (latest 8.23.0). Cloudflare's recommended driver; best
  Hyperdrive cache compatibility. `postgres` (postgres.js) ≥ 3.4.5 is the supported alternative.
- Connection string: Supabase **Direct connection `db.<ref>.supabase.co:5432`** — Hyperdrive is
  itself a transaction pooler, so do NOT stack it on Supavisor. **Never** use transaction mode 6543:
  it has no prepared statements, which is exactly what Hyperdrive's cache relies on.
  Caveat: the direct endpoint is **IPv6-only** unless the IPv4 add-on is purchased (and the add-on
  SWAPS the record, it is not dual-stack). If Hyperdrive cannot dial it, fall back to Supavisor
  **session mode** `aws-<region>.pooler.supabase.com:5432` (IPv4, prepared statements OK).
- **TWO Hyperdrive configs bound to the same Worker**, with separate driver clients:
  - `HYPERDRIVE_CACHED` — default caching (max_age 60s, swr 15s). Content reads only.
  - `HYPERDRIVE_FRESH` — created with `--caching-disabled`. **Every access decision, x402 grant
    check, settlement, spend reservation and approval read goes here.** Hyperdrive does NOT
    invalidate on write, so a cached grant read could hand over paid content or double-charge.
    SQL comments are NOT a cache-control API — they share a cache key.
- **SECURITY FINDING, verified against the live project:** the Supabase `postgres` role has
  `rolbypassrls = true`. A Worker connecting with the default connection string **bypasses every RLS
  policy** — there is no PostgREST, no JWT, no `request.jwt.claims`. RLS is not the safety net it was
  in the Vercel plan. Required response, both layers:
  1. Provision a dedicated login role `musebook_worker` that is **NOBYPASSRLS** and not the owner;
     add `ALTER TABLE ... FORCE ROW LEVEL SECURITY` on every RLS-protected table; set the actor per
     transaction with `SET LOCAL ROLE` / `SET LOCAL app.actor_id`.
  2. The kernel still enforces authorization in code. Defense in depth — neither layer alone.
- Unsupported through Hyperdrive: `LISTEN`/`NOTIFY`, advisory locks, SQL-level `PREPARE`.
  60-second statement cap, ~100 origin connections. Included in Workers Paid, unlimited queries.

## 3. ASYNC — Cloudflare Queues + a transactional outbox
Move to Queues: classification, media generation, distribution/Postiz fan-out, embeddings, and
R2-object-created derivative work. Keep in Postgres: the outbox table and the rollups (pg_cron).
**Never** put anything in the x402 settlement path on a queue.

- **Transactional enqueue does not exist on Queues.** The pattern is:
  1. Write the domain row and its `outbox` row in **ONE statement** — a data-modifying CTE or a
     single plpgsql function call. **Not** an explicit `BEGIN/COMMIT`: Hyperdrive explicitly warns
     that pinning a pooled connection across round trips degrades the pool.
  2. Best-effort `env.QUEUE.send()` after commit inside `ctx.waitUntil()`.
  3. A `* * * * *` Cron Worker sweeps unsent outbox rows over a partial index. Bounded ~60s recovery
     on a path that essentially never fires.
- **Every consumer must be idempotent.** Queues is at-least-once with no exactly-once mode and one
  active consumer per queue. This is not configurable away.
- Limits: **128 KB per message** (pass R2 keys and row ids, never inline payloads), 5,000 msg/s per
  queue, 25 GB backlog, **15 min wall clock per consumer invocation**, 250 concurrent consumers.
  Media generation that can exceed 15 min MUST split into submit-and-record-handle, then collect via
  the vendor webhook or a second job.
- **Ship a DLQ consumer with the first queue** — an unconsumed DLQ discards messages after 4 days.
- Pricing: ~$0.40 per million 64 KB operations, 1M ops/month included. ~$2/mo at 2M jobs.

## 4. THE RANKING PASS RUNS OFFLINE
The Muse-Mixer runs in a **Queue consumer / Cron Worker that writes a `slates` row**; the request
path performs exactly ONE read of that slate. FIRM.
Reject the obvious reason: **CPU is not the constraint and is not close** — scoring 200 candidates is
~307k multiply-adds, roughly 1 ms against a 30,000 ms default budget (raisable to 300,000 ms). The
three real reasons: (a) Workers cap **6 SIMULTANEOUS OPEN CONNECTIONS** per request, which serializes
a multi-source fan-out into `ceil(N/6)` latency waves regardless of the 10,000-subrequest headroom;
(b) the **128 MB limit is PER ISOLATE, shared across all in-flight requests**, so 1.2 MB of
per-request embeddings is harmless at 1 concurrent request and recycles the isolate at 100; (c) a
pgvector kNN over Hyperdrive would add a database round trip to every page view.

## 5. R2 — the bucket split is forced, not a preference
An R2 custom domain is **bucket-wide and unconditionally public**. Paid media can therefore never
live in a bucket that has `cdn.musebook.dev` or an `r2.dev` URL attached.

| Bucket | Exposure | Holds |
|---|---|---|
| `musebook-public` | `cdn.musebook.dev` custom domain, no Worker | free media, teasers, posters, thumbnails, OG images, X402_ALWAYS teaser assets |
| `musebook-paid` | **binding only** — no custom domain, no dev URL | all paid media, served via `media.musebook.dev` Worker route after the grant check |
| `musebook-artifacts` | binding only, via `artifacts.musebook.dev` Worker route | 2D app bundles and 3D glTF |
| `musebook-logs` | binding only | Logpush 30-day archive |

- A CDN cache hit on `musebook-public` costs **$0** — no Worker request, no R2 Class B. Add a Cache
  Everything rule (default caching skips `.m3u8`/`.ts`/`.json`) and enable Smart Tiered Cache. This
  is the cheapest byte path Cloudflare offers and where the bulk of traffic should land.
- **Presigned URLs are for UPLOADS ONLY, never for gating.** Cloudflare states they do not work with
  custom domains; they leak `<ACCOUNT_ID>.r2.cloudflarestorage.com`, bypass the zone entirely (no
  cache, no bot gate, no analytics) and are shareable bearer tokens for up to 7 days.
- Range requests work natively through the binding — pass `request.headers` into `R2GetOptions.range`.
  Each range GET is one Class B op at $0.36/M. For 1,000 min of HLS-segmented video that is ~$0.0036
  of R2 ops versus $1.00 on Cloudflare Stream — ~150× cheaper, but with no encoding and no ABR
  ladder. **v1 uses R2 + client-side HLS; Stream is a documented upgrade path, not a launch item.**

## 6. x402 ON WORKERS — import by subpath, no key at the edge
- Depend on `@x402/core@2.26.0` and `@x402/evm@2.26.0` but **import only the subpaths**
  `@x402/evm/exact/server`, `@x402/core/server`, `@x402/core/http`. That graph has **zero external
  packages — no viem, no Node built-ins** — and reaches the facilitator through global `fetch`.
- **Add a bundle guard** (esbuild `external`/alias that throws on `viem`, `node:fs`, `node:path`) so
  nobody later imports the root barrel and silently pulls in viem plus fs-backed batch settlement.
- **No settlement private key ever lives in a Worker, and no EIP-712 recovery happens at the edge.**
  All `hashTypedData` / `recoverTypedDataAddress` / `createPublicClient` usage lives in the
  *facilitator* subpaths, which we do not import. Settlement is delegated to the facilitator.
- Cloudflare ships **no** x402 HTTP Worker template. `cloudflare/x402-proxy` is a 404, and
  `cloudflare/mpp-proxy` is MPP, not x402. Cloudflare's own `agents/x402` (`withX402`, `paidTool`) is
  v2 but **MCP-only** — it covers §7's MCP server and does nothing for the HTTP page gate.
- **Dependency note:** `@x402/core@2.26.0` depends on `zod ^3.24.2` while
  `@modelcontextprotocol/server@2.0.0` needs `zod ^4.2.0`. Fine under pnpm's isolated resolution, but
  §3 must NOT put a single `zod` in the catalog and assume one version satisfies both.
- Grant lookup: Postgres via `HYPERDRIVE_FRESH` is the source of truth. **KV may be a read-through
  cache only for POSITIVE grants** (a stale positive at worst serves content the agent already paid
  for). A KV miss must fall through to Postgres — never treat a miss as "no grant", and never cache
  a negative.

## 7. BOT CLASSIFICATION — the Worker verifies, Cloudflare does not
- Use **`web-bot-auth@0.2.0`** — Cloudflare's own package, Apache-2.0, pure WebCrypto, zero Node
  imports, whose reference implementation is itself a Worker. Deps: `http-message-sig@0.3.0`,
  `jsonwebkey-thumbprint@0.1.0`, `structured-headers@2.0.3`. Do not hand-roll RFC 9421 — the `;key=`
  dictionary-member and `;req` component serializations are where hand-rolled implementations go
  quietly wrong.
- Override the library's loose defaults: `algorithms: ["ed25519"]`, `maxAge: 300`, `clockSkew: 30`.
- workerd implements Ed25519 in `crypto.subtle` with **no compatibility flag and no `nodejs_compat`**.
- **Do NOT design around `request.cf.botManagement`** — it is Enterprise Bot Management only. Plan
  for it to be null. `request.cf` does surface `verifiedBot` / `verifiedBotCategory` / `score` on
  lower tiers; treat those as the weaker second layer.
- **Coverage is thin.** As of Sept 2026 only a handful of agents sign (OpenAI ChatGPT agent, Google-
  Agent — not Googlebot, AWS Bedrock AgentCore Browser, Cloudflare Browser Run), and the IETF WG has
  adopted zero documents. An agent that omits the headers is indistinguishable from a human. This
  REINFORCES the original spine's honest framing: mode 2 is a declared, incentivized contract, not a
  detection guarantee. Say so in the creator-facing copy.

## 8. PAY-PER-CRAWL — do not use it; use our own x402
- It is **CLOSED (private) BETA as of 2026-09-21**. Musebook cannot switch it on.
- It does **not** pre-empt the Worker. Documented order: WAF custom rules → Bot Solutions →
  Pay Per Crawl, and PPC annotates the request with `cf-pay-per-crawl` **before** the Worker runs,
  then acts on the Worker's response. So our own x402 always gets to run.
- The conflict is **economic, not technical**: with PPC on, Cloudflare is Merchant of Record, sets the
  rail, receives the money in USD via Stripe, and charges on **every 200** — which cannot express
  HUMAN_FREE_AGENT_PAID's one-charge-per-agent-per-`content_hash` grant. It also only charges
  *verified* crawlers, so an x402-capable agent with a wallet but no Cloudflare registration simply
  gets a 402 it cannot satisfy.
- **Decision: run Musebook's own x402 v2 in the Worker for all three modes. Keep PPC off** (fence it
  with a Configuration Rule "Disable Pay Per Crawl" if it ever auto-enables). Use AI Crawl Control
  purely for observability, managed robots.txt and Content Signals.
- Two settings that will silently break the money path if wrong: **Bot Fight Mode must be OFF** (no
  rule can skip it, and it overrides everything), and the **Agent preset must be explicitly set to
  allow** — the 2026-09-15 default blocks Training/Agent-classified bots on ad-displaying pages for
  NEW zones, and musebook.dev is a new zone.
- X402_ALWAYS pages must serve a genuinely crawlable teaser at 200 on a sibling path: a bare 402 is
  fatal to conventional indexing (Cloudflare's own AI Search records `blocked_by_payment` and drops
  the page permanently).

## 9. THE MCP SERVER — drop mcp-handler, use Cloudflare's wrapper
- Stack: **`agents@0.24.0`** (import `createMcpHandler` from `agents/mcp/server`) +
  **`@modelcontextprotocol/server@2.0.0`** (exact) + **`zod@4.6.5`** + `postgres@3.4.9`, on a
  dedicated `musebook-mcp` Worker at `mcp.musebook.dev`. **No Durable Objects. No Next.js route.**
- `mcp-handler@2.2.0` is not broken — it is a clean 12.9 KB shim with no `node:` imports and `next`
  optional in `peerDependenciesMeta`, and it does run on workerd. It becomes **redundant**, because
  both it and Cloudflare's wrapper call the same `createMcpHandler` from `@modelcontextprotocol/
  server@2.0.0`. Revision 2026-07-28 support lives in the SDK, so both inherit it identically.
- The decider: the MCP spec requires the server to validate browser `Origin`/`Host`, and the official
  SDK entry is explicitly validation-free. **mcp-handler never adds it — a bare Worker mount would be
  DNS-rebinding-vulnerable.** Cloudflare's wrapper adds Host/Origin validation, route matching, CORS,
  `workers-oauth-provider` props plumbing and a `notify` API.
- **`McpAgent` is DEPRECATED and feature-frozen.** Its Durable Object session state is legacy now
  that MCP 2026-07-28 is stateless. Do not use it.
- OAuth 2.1 via `workers-oauth-provider` + RFC 9728 protected resource metadata.
- x402 over MCP uses Cloudflare's `agents/x402` (`withX402`, `paidTool`) — this is the one place it
  applies.

## 10. TELEMETRY — split the firehose
- **Analytics Engine takes** impressions, dwell, scroll, play-through and agent crawl events.
  $0.25 per million data points (billing not yet enabled as of the current pricing page, so
  effectively $0 today). 204M events/mo ≈ $48.50, versus ~108 GB/mo of new Postgres heap+index and a
  sustained ~95 inserts/sec that would force a Supabase compute-tier jump.
- **Postgres keeps** everything spine invariant 3 depends on — `slate_id`, `position`,
  `weights_version`, `model_version` and the labelled rows the ranker trains on — plus the rollups.
  **AE cannot replace `action_events` wholesale**: it retains only 3 months and applies its own
  sampling. Do not put training labels in it.
- The ranker still never joins raw events at serve time; it reads worker-written rollup TABLES.

## 11. OBSERVABILITY AND COST
- **Workers Logs** (`observability.enabled = true`) is the 7-day hot store. 20M events/mo included,
  7-day max retention. `head_sampling_rate` 0.1 on the human pass-through path, **1.0 on a separate
  un-sampled money/agent Worker**.
- **Logpush (`workers_trace_events`) → `musebook-logs` R2 bucket** is the 30-day archive, ~$2.30/mo
  at $0.05/million requests. **Delete the plan's speculative "$200/mo log aggregator" line and the
  Vercel Log Drain entirely.**
- Sentry via the native OTLP destination with `persist: false` so traces are not double-billed.
  Do NOT use Tail Workers for log shipping — native OTLP supersedes them.
- **Alerting is the weak spot**: Cloudflare's native notifications do not cover the plan's silent
  failure modes. §15 must build them — a Cron Worker that queries AE and the DB and posts alerts.
- Verified cost of the Cloudflare side: **~$5/mo launch, ~$11/mo at 10k DAU, ~$114/mo at 100k DAU**,
  against the plan's current $1,895/mo Vercel subtotal at 100k DAU. At 28.8 TB/mo of media, Vercel
  Fast Data Transfer at $0.15/GB would bill ~$4,170/mo; R2 bills **$0**.

## 12. WORKERS RUNTIME
- **`compatibility_date = "2026-09-21"` and NO `compatibility_flags`.** Since 2026-08-04
  `nodejs_compat` and `nodejs_compat_v2` are ON BY DEFAULT — listing them is dead config implying a
  control you no longer have. (Conservative floor: 2026-08-04.)
- `node:crypto` is fully supported (missing only argon2, ed448/x448, DSA/DH keygen), so
  `packages/content` may use either `node:crypto` sha256 or WebCrypto.
- **secp256k1 is NOT in workerd WebCrypto and never will be** — EVM signature verify goes through
  `@noble/curves`, which viem already bundles. Moot at the edge anyway (see §6: no recovery there).
- Testing: **`@cloudflare/vitest-plugin`** — it supersedes `@cloudflare/vitest-pool-workers`, which
  the original plan names. §17 must be updated. `wrangler dev` + Miniflare for local.

## 13. OWNER DECISIONS NOW CLOSED (were blocking questions in §18)
1. **Music and video verticals SURVIVE**, as their own TikTok-style vertical feed — a distinct
   surface, not a merged timeline. §14 specifies it: full-bleed vertical pager, snap scrolling,
   autoplay with muted-by-default and a persistent unmute affordance, gesture navigation,
   prefetch-next, and a `surface = 'reels'` value in the shared surface enum. §9 gives it its own
   candidate sources and a watch-time-weighted scorer. §4's `post_kind` already carries `audio` and
   `video`. Media serves from `musebook-public` via `cdn.musebook.dev` with HLS.
2. **Base MAINNET USDC at launch.** Asset `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, EIP-712
   domain name **`"USD Coin"`** (NOT `"USDC"` — that is Sepolia), version `"2"`, 6 decimals. The
   testnet-only default facilitator cannot be used; §6 must name a mainnet-capable facilitator and
   §18 records which one was chosen.
3. **Syndicated per-platform variants are FULL PORTS**, not teasers. §12's reformatter ports the
   whole body to each platform under that platform's constraints. Note the consequence plainly in
   §12 and §18: for a HUMAN_FREE_AGENT_PAID or X402_ALWAYS post, a full syndicated copy on X or
   LinkedIn is unpaywalled public text — the owner has accepted this, and the plan must not silently
   re-litigate it.

## 14. WHAT DOES NOT CHANGE
The nine invariants. The two-function kernel (`resolveAccess` / `renderResource`) — still pure, now
called from a Worker instead of a Next route. `content_hash` as universal join key. Candidate
isolation and its merge-gate test. Three-score discipline. Runtime-loaded weights. Zero platform
imports in `muse-mixer`. §4's schema (now reached via Hyperdrive). §5's thirdweb v5 identity model.
§8's Jev classification. §10's connector registry. §12's Postiz posture. §18's structure.
