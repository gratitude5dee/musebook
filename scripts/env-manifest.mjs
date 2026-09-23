// scripts/env-manifest.mjs — plan section 3.7 as data. Edit THIS when a section
// adds a variable; then `pnpm env:example` and commit all three files.
//
//   scope:  subset of ["VP","VPr","E","M","J","L","CI"]   (section 3.7's legend)
//   kind:   "public" | "var" | "secret"
//             public → inlined into the client bundle; may never be secret
//             var    → for E/M/J this MUST appear in that worker's wrangler.jsonc
//             secret → must appear in NO wrangler.jsonc, ever
//   local:  the value written into the example file (never a real credential)

/** Which wrangler.jsonc a scope code maps to. */
export const WORKER_CONFIG = {
  E: "apps/edge/wrangler.jsonc",
  M: "apps/mcp/wrangler.jsonc",
  J: "apps/worker/wrangler.jsonc",
};

export const GROUPS = [
  {
    title: "Application and the Vercel seam",
    vars: [
      {
        name: "NEXT_PUBLIC_SITE_URL",
        scope: ["VP", "VPr", "L", "CI"],
        kind: "public",
        local: "http://localhost:3000",
      },
      {
        name: "MUSEBOOK_EDGE_SECRET",
        scope: ["VP", "VPr", "E", "L"],
        kind: "secret",
        comment:
          "The origin lockdown. <project>.vercel.app stays publicly reachable; proxy.ts 404s anything without this header (CF-SPINE 1.4).",
      },
      { name: "MUSEBOOK_EDGE_SECRET_PREVIOUS", scope: ["VP", "VPr"], kind: "secret" },
      {
        name: "ORIGIN_HOST",
        scope: ["E", "J"],
        kind: "var",
        local: "musebook-web.vercel.app",
        comment:
          "Read this off the Vercel project's domain card. Vercel issues per-project targets; do not hardcode from memory.",
      },
      {
        name: "ORIGIN_SCHEME",
        scope: ["E", "L"],
        kind: "var",
        local: "https",
        comment:
          "toOrigin() rebuilds on ORIGIN_SCHEME://ORIGIN_HOST. Only the local dev pair sets http (wrangler dev → next start); deployed envs keep https.",
      },
      { name: "CDN_HOST", scope: ["VP", "VPr", "E", "J"], kind: "var", local: "cdn.musebook.dev" },
      { name: "MEDIA_HOST", scope: ["E", "J"], kind: "var", local: "media.musebook.dev" },
      { name: "ARTIFACT_HOST", scope: ["E"], kind: "var", local: "artifacts.musebook.dev" },
      {
        name: "ARTIFACT_ORIGIN",
        scope: ["VP", "VPr", "E", "L"],
        kind: "var",
        local: "https://artifacts.musebook.dev",
      },
      {
        name: "MUSEBOOK_LOG_LEVEL",
        scope: ["VP", "VPr", "E", "M", "J", "L"],
        kind: "var",
        local: "info",
      },
      {
        name: "MB_RELEASE_SHA",
        scope: ["E", "M", "J", "CI"],
        kind: "var",
        comment: "CI-injected via `wrangler deploy --var`. Not in wrangler.jsonc.",
      },
      { name: "PREVIEW_CHARS", scope: ["E", "M", "L"], kind: "var", local: "400" },
      { name: "LANDING_DEMO_SOURCE", scope: ["VP", "VPr", "L"], kind: "var", local: "auto" },
      {
        name: "NEXT_PUBLIC_LANDING_TESTIMONIALS",
        scope: ["VP", "VPr", "L", "CI"],
        kind: "public",
        local: "false",
      },
      {
        name: "NEXT_PUBLIC_LANDING_PROOF",
        scope: ["VP", "VPr", "L", "CI"],
        kind: "public",
        local: "false",
      },
      {
        name: "CONSENT_BANNER_REGIONS",
        scope: ["VP", "VPr", "E"],
        kind: "var",
        comment:
          "Region comes from request.cf.country, forwarded as x-mb-country — x-vercel-ip-country is dead behind Cloudflare.",
      },
      { name: "SECURITY_CONTACT_EMAIL", scope: ["VP", "VPr"], kind: "var" },
      { name: "PRIVACY_CONTACT_EMAIL", scope: ["VP", "VPr"], kind: "var" },
      {
        name: "LEGAL_REVIEW_STRICT",
        scope: ["VP", "VPr", "CI", "L"],
        kind: "var",
        comment:
          '"1" makes check-legal-review fail a build on any unreviewed legal doc; production VERCEL_ENV already does.',
      },
    ],
  },
  {
    title: "Cloudflare platform",
    vars: [
      {
        name: "CLOUDFLARE_API_TOKEN",
        scope: ["CI", "L"],
        kind: "secret",
        comment:
          "The deploy token: Workers Scripts:Edit, R2:Edit, Queues:Edit, KV:Edit + zone Cache Purge. Never Global API Key.",
      },
      {
        name: "CLOUDFLARE_ACCOUNT_ID",
        scope: ["CI", "L"],
        kind: "var",
        local: "e8f42c0430906e1515a2af01d5c1d2d1",
      },
      {
        name: "CF_ACCOUNT_ID",
        scope: ["J", "L", "CI", "E"],
        kind: "var",
        local: "e8f42c0430906e1515a2af01d5c1d2d1",
      },
      { name: "CF_ZONE_ID", scope: ["L", "CI"], kind: "var" },
      {
        name: "CF_API_TOKEN",
        scope: ["J", "L", "CI"],
        kind: "secret",
        comment:
          "Read-only + zone-settings scope for the AE SQL API and configure-cf.ts. NEVER the deploy token.",
      },
      {
        name: "R2_ACCESS_KEY_ID",
        scope: ["E"],
        kind: "secret",
        comment:
          "Scoped to musebook-uploads alone — a credential reaching musebook-paid is a paywall bypass.",
      },
      { name: "R2_SECRET_ACCESS_KEY", scope: ["E"], kind: "secret" },
      { name: "R2_PRESIGN_TTL_S", scope: ["E"], kind: "var", local: "900" },
      {
        name: "R2_LOGPUSH_ACCESS_KEY_ID",
        scope: ["L", "CI"],
        kind: "secret",
        comment: "Write-only on musebook-logs alone. Distinct from R2_ACCESS_KEY_ID.",
      },
      { name: "R2_LOGPUSH_SECRET_ACCESS_KEY", scope: ["L", "CI"], kind: "secret" },
    ],
  },
  {
    title: "Supabase (project musebook-prod — NOT the legacy shared project)",
    vars: [
      {
        name: "NEXT_PUBLIC_SUPABASE_URL",
        scope: ["VP", "VPr", "L", "CI"],
        kind: "public",
        local: "http://127.0.0.1:54321",
      },
      {
        name: "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
        scope: ["VP", "VPr", "L", "CI"],
        kind: "public",
        local: "",
      },
      {
        name: "SUPABASE_SECRET_KEY",
        scope: ["VP", "VPr", "L"],
        kind: "secret",
        comment:
          "Vercel only. A Worker reaches Postgres through Hyperdrive as musebook_worker, never through PostgREST.",
      },
      {
        name: "SUPABASE_DB_URL",
        scope: ["L", "CI"],
        kind: "secret",
        comment:
          "Direct, port 5432 — migrations, pg_partman, pgTAP. NO runtime component reads this.",
        local: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
      },
      {
        name: "MUSEBOOK_WORKER_DB_PASSWORD",
        scope: ["L", "CI"],
        kind: "secret",
        comment: "Only to create or rotate a Hyperdrive config. Never at runtime.",
      },
      {
        name: "SUPABASE_JWT_SECRET",
        scope: ["VP", "VPr", "L"],
        kind: "secret",
        local: "super-secret-jwt-token-with-at-least-32-characters-long",
      },
      {
        name: "SUPABASE_PROJECT_REF",
        scope: ["L", "CI"],
        kind: "var",
        local: "rmcgtcsfrfrjxeyxoiin",
      },
      {
        name: "SUPABASE_ACCESS_TOKEN",
        scope: ["CI"],
        kind: "secret",
        comment: "preview-db.yml creates/resets/deletes Supabase branches with it.",
      },
      { name: "SUPABASE_DB_PASSWORD", scope: ["CI"], kind: "secret" },
    ],
  },
  {
    title: "thirdweb (identity) and Moltbook",
    vars: [
      {
        name: "NEXT_PUBLIC_THIRDWEB_CLIENT_ID",
        scope: ["VP", "VPr", "L", "CI"],
        kind: "public",
        local: "",
      },
      {
        name: "NEXT_PUBLIC_THIRDWEB_AUTH_DOMAIN",
        scope: ["VP", "VPr", "L", "CI"],
        kind: "public",
        local: "localhost:3000",
      },
      { name: "THIRDWEB_SECRET_KEY", scope: ["VP", "J"], kind: "secret" },
      {
        name: "THIRDWEB_ADMIN_PRIVATE_KEY",
        scope: ["VP"],
        kind: "secret",
        comment: "Never on a Worker.",
      },
      {
        name: "THIRDWEB_SERVER_WALLET_ADDRESS",
        scope: ["VP", "J"],
        kind: "var",
        comment: "Outbound payout wallet. Never the inbound payTo — that is X402_PAY_TO.",
      },
      {
        name: "MOLTBOOK_MODE",
        scope: ["VP", "VPr", "E", "M", "J", "L"],
        kind: "var",
        local: "production",
      },
      {
        name: "MOLTBOOK_ALLOW_MOCK",
        scope: ["VP", "VPr", "E", "M", "J", "L"],
        kind: "var",
        local: "false",
      },
      { name: "MOLTBOOK_APP_KEY", scope: ["E", "M", "J"], kind: "secret" },
    ],
  },
  {
    title: "x402, settlement and payouts",
    vars: [
      // The example file renders Base Sepolia + shadow so a fresh checkout can
      // never settle real money (§3.8).
      { name: "X402_MODE", scope: ["E", "M", "J", "L"], kind: "var", local: "shadow" },
      { name: "X402_NETWORK", scope: ["E", "M", "J", "L"], kind: "var", local: "eip155:84532" },
      { name: "X402_CHAIN_ID", scope: ["E", "M", "J", "L"], kind: "var", local: "84532" },
      { name: "X402_RPC_URL", scope: ["J", "L"], kind: "var" },
      {
        name: "X402_ASSET_ADDRESS",
        scope: ["E", "M", "J", "L"],
        kind: "var",
        local: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      },
      {
        name: "X402_ASSET_EIP712_NAME",
        scope: ["E", "M", "J", "L"],
        kind: "var",
        local: "USDC",
        comment:
          "Base mainnet USDC is 'USD Coin', Sepolia is 'USDC'. A wrong pair makes every gated route unpayable.",
      },
      { name: "X402_ASSET_DECIMALS", scope: ["E", "M", "J", "L"], kind: "var", local: "6" },
      {
        name: "X402_PAY_TO",
        scope: ["E", "M", "J"],
        kind: "secret",
        comment: "The treasury address — secret for INTEGRITY, not confidentiality.",
      },
      {
        name: "X402_FACILITATOR_URL",
        scope: ["E", "M", "J", "L"],
        kind: "var",
        local: "https://api.cdp.coinbase.com/platform/v2/x402",
      },
      { name: "X402_IDEMPOTENT_WINDOW_SECONDS", scope: ["E", "M", "L"], kind: "var", local: "120" },
      {
        name: "X402_TEST_PAYER_KEY",
        scope: ["L", "CI"],
        kind: "secret",
        comment:
          "Base Sepolia payer key — the live-facilitator gate tier (m8-wire, packages/x402/test/live) only. Never a Worker binding.",
      },
      { name: "X402_GRANT_CACHE_TTL_S", scope: ["E", "M"], kind: "var", local: "86400" },
      { name: "X402_PAYOUT_NETWORK", scope: ["J"], kind: "var", local: "eip155:8453" },
      { name: "X402_PAYOUT_BATCH_MIN_ATOMIC", scope: ["J"], kind: "var", local: "5000000" },
      { name: "X402_PAYOUT_NET_BPS", scope: ["J"], kind: "var", local: "9000" },
      { name: "APECHAIN_PAYOUT_ENABLED", scope: ["J"], kind: "var", local: "false" },
      {
        name: "APECHAIN_RPC_URL",
        scope: ["J"],
        kind: "var",
        local: "https://rpc.apechain.com/http",
      },
      {
        name: "APECHAIN_PAYOUT_ASSET",
        scope: ["J"],
        kind: "var",
        comment: "Verify on apescan.io before use. Never native $APE.",
      },
      {
        name: "CDP_API_KEY_ID",
        scope: ["E"],
        kind: "secret",
        comment:
          "Facilitator auth — the Worker signs its own request JWT with WebCrypto; no cdp-sdk/viem in the bundle.",
      },
      { name: "CDP_API_KEY_SECRET", scope: ["E"], kind: "secret" },
    ],
  },
  {
    title: "Bot classification (Web Bot Auth)",
    vars: [
      { name: "WEB_BOT_AUTH_ENABLED", scope: ["E"], kind: "var", local: "true" },
      {
        name: "WEB_BOT_AUTH_MAX_AGE_S",
        scope: ["E"],
        kind: "var",
        local: "300",
        comment: "The library's default is looser; override it.",
      },
      { name: "WEB_BOT_AUTH_CLOCK_SKEW_S", scope: ["E"], kind: "var", local: "30" },
      {
        name: "WEB_BOT_AUTH_DIRECTORY_ALLOWLIST",
        scope: ["E"],
        kind: "var",
        comment:
          "The SSRF guard on attacker-supplied Signature-Agent origins. Absent ⇒ directory fetch disabled, never defaulted open.",
      },
    ],
  },
  {
    title: "Typesafe / Jev (classification) and LLM generation",
    vars: [
      {
        name: "TYPESAFE_API_KEY",
        scope: ["J", "L"],
        kind: "secret",
        comment:
          "TypeSafeClient throws in its CONSTRUCTOR — construct lazily inside the consumer or the deploy fails.",
      },
      {
        name: "TYPESAFE_BASE_URL",
        scope: ["J", "L"],
        kind: "var",
        local: "https://api.typesafe.ai",
      },
      { name: "TYPESAFE_DEFAULT_MODEL", scope: ["J", "L"], kind: "var", local: "jev-latest" },
      {
        name: "TYPESAFE_LOG_LEVEL",
        scope: ["J", "L"],
        kind: "var",
        local: "warn",
        comment: "Never debug in a deployed environment — it logs full request/response bodies.",
      },
      { name: "CLASSIFY_TAXONOMY_MODE", scope: ["J", "L"], kind: "var", local: "walk" },
      { name: "AI_GATEWAY_API_KEY", scope: ["J"], kind: "secret" },
      { name: "GEN_MODEL", scope: ["J"], kind: "var", local: "anthropic/claude-opus-5" },
      { name: "REFORMAT_MODEL", scope: ["J"], kind: "var", local: "anthropic/claude-sonnet-5" },
      { name: "REFORMAT_MAX_REPAIRS", scope: ["J"], kind: "var", local: "2" },
      {
        name: "ANTHROPIC_API_KEY",
        scope: ["J"],
        kind: "secret",
        comment: "Musebook's own key — never an inbound token.",
      },
    ],
  },
  {
    title: "Postiz (distribution)",
    vars: [
      {
        name: "POSTIZ_URL",
        scope: ["E", "J", "L"],
        kind: "var",
        local: "http://localhost:4200",
        comment:
          "API base is ${POSTIZ_URL}/api/public/v1 — the bundled nginx proxies /api/ to the backend.",
      },
      {
        name: "POSTIZ_API_KEY",
        scope: ["E", "J"],
        kind: "secret",
        comment:
          "Sent as a RAW `Authorization: <key>` — no Bearer prefix; the middleware feeds the whole header to findFirst(). Scoped E as well because §12.2.7's channels-sync route calls listIntegrations from musebook-edge.",
      },
      {
        name: "POSTIZ_WEBHOOK_SECRET",
        scope: ["E", "J"],
        kind: "secret",
        comment: "Carried in the URL path (Postiz webhooks are unsigned). ≥32 random bytes, hex.",
      },
      {
        name: "POSTIZ_MEDIA_DOMAIN",
        scope: ["J"],
        kind: "var",
        local: "media.postiz.musebook.dev",
      },
      {
        name: "DISTRIBUTION_ENABLED",
        scope: ["J"],
        kind: "var",
        local: "true",
        comment: "Kill switch — absence must throw, not default to off.",
      },
    ],
  },
  {
    title: "Media generation, artifacts and storage",
    vars: [
      {
        name: "FAL_KEY",
        scope: ["J"],
        kind: "secret",
        comment: "Optional subsystem — absent ⇒ disable the provider, do not crash.",
      },
      {
        name: "FAL_WEBHOOK_JWKS_URL",
        scope: ["E"],
        kind: "var",
        local: "https://rest.alpha.fal.ai/.well-known/jwks.json",
      },
      { name: "REPLICATE_API_TOKEN", scope: ["J"], kind: "secret" },
      {
        name: "REPLICATE_WEBHOOK_SECRET",
        scope: ["E"],
        kind: "secret",
        comment: "Absent ⇒ the handler rejects every delivery.",
      },
      {
        name: "MEDIA_WEBHOOK_BASE_URL",
        scope: ["J"],
        kind: "var",
        local: "https://musebook.dev/api/media/webhook",
      },
      { name: "MEDIA_WEBHOOK_VERIFY_MODE", scope: ["E"], kind: "var", local: "enforce" },
      { name: "MEDIA_BACKEND_REPLICATE_ENABLED", scope: ["J"], kind: "var", local: "false" },
      { name: "MEDIA_LONGFORM_VIDEO_ENABLED", scope: ["E", "J"], kind: "var", local: "false" },
      { name: "MEDIA_SANDBOX_IMAGE", scope: ["VP"], kind: "var", local: "vercel/sandbox/node:24" },
      { name: "C2PA_SIGNING_ENABLED", scope: ["VP"], kind: "var", local: "false" },
      { name: "C2PA_SIGNING_CERT_PEM", scope: ["VP"], kind: "secret" },
      { name: "C2PA_SIGNING_KEY_PEM", scope: ["VP"], kind: "secret" },
      { name: "C2PA_TSA_URL", scope: ["VP"], kind: "var" },
      {
        name: "ARTIFACT_TICKET_SIGNING_KEY",
        scope: ["E"],
        kind: "secret",
        comment: "Ed25519 PKCS#8 PEM.",
      },
      {
        name: "ARTIFACT_TICKET_PUBLIC_KEY",
        scope: ["E"],
        kind: "var",
        comment: "SPKI PEM — public by definition.",
      },
    ],
  },
  {
    title: "MCP server, OAuth and WebMCP",
    vars: [
      { name: "MCP_ISSUER_URL", scope: ["M"], kind: "var", local: "https://mcp.musebook.dev" },
      { name: "MCP_AUTH_SERVER_URL", scope: ["M"], kind: "var", local: "https://mcp.musebook.dev" },
      {
        name: "MCP_JWT_SIGNING_KEY",
        scope: ["M"],
        kind: "secret",
        comment:
          "Ed25519 PKCS#8 PEM, base64. See the UNVERIFIED note in §3.6.1 — may be dead once workers-oauth-provider is confirmed to self-sign.",
      },
      { name: "MCP_OAUTH_ACCESS_TOKEN_TTL_S", scope: ["M"], kind: "var", local: "3600" },
      { name: "MCP_OAUTH_AUTH_CODE_TTL_S", scope: ["M"], kind: "var", local: "600" },
      {
        name: "MCP_REQUEST_STATE_KEY",
        scope: ["M"],
        kind: "secret",
        comment:
          "32 random bytes base64 — seals MRTR requestState. Absent ⇒ MRTR disabled outright.",
      },
      {
        name: "MUSEBOOK_MCP_URL",
        scope: ["L", "CI"],
        kind: "var",
        local: "https://mcp.musebook.dev/mcp",
        comment: "musebook CLI — remote MCP endpoint. Not a Worker binding.",
      },
      {
        name: "MUSEBOOK_TOKEN",
        scope: ["L", "CI"],
        kind: "secret",
        comment: "musebook CLI — OAuth access token for the remote MCP.",
      },
      {
        name: "NEXT_PUBLIC_WEBMCP_OT_TOKEN",
        scope: ["VP", "VPr", "CI"],
        kind: "public",
        local: "",
      },
      { name: "WEBMCP_BRIDGE_ENABLED", scope: ["VP", "VPr"], kind: "var", local: "false" },
      { name: "LLMS_FULL_MAX_BYTES", scope: ["E"], kind: "var", local: "4000000" },
    ],
  },
  {
    title: "Internal calls between Vercel and Cloudflare",
    vars: [
      {
        name: "MB_INTERNAL_SIGNING_KEY",
        scope: ["VP", "J"],
        kind: "secret",
        comment: "Ed25519 PKCS#8 DER, base64. Signs the Worker→Vercel sandbox/C2PA calls.",
      },
      { name: "MB_INTERNAL_KEY_ID", scope: ["VP", "J"], kind: "var" },
      {
        name: "MB_INTERNAL_PUBLIC_KEYS",
        scope: ["VP", "J"],
        kind: "var",
        comment: "JSON map keyid → base64 SPKI; holds current AND previous during rotation.",
      },
      { name: "MB_INTERNAL_MAX_SKEW_S", scope: ["VP", "J"], kind: "var", local: "300" },
    ],
  },
  {
    title: "Connectors",
    vars: [
      {
        name: "CONNECTOR_SIGNING_PRIVATE_KEY",
        scope: ["J"],
        kind: "secret",
        comment: "Ed25519 (not NODE-ED25519) — signs Musebook's own outbound fetches.",
      },
      {
        name: "CONNECTOR_CRED_KEK",
        scope: ["J"],
        kind: "secret",
        comment: "base64, 32 bytes. KEK for connector_credentials.",
      },
      { name: "CONNECTOR_CRED_KEY_ID", scope: ["J"], kind: "var", local: "kek-2026-09" },
      { name: "CONNECTOR_EGRESS_TIMEOUT_MS", scope: ["E", "J"], kind: "var", local: "60000" },
      { name: "CONNECTOR_EGRESS_MAX_BYTES", scope: ["E", "J"], kind: "var", local: "8388608" },
      { name: "CONNECTOR_CODEX_AGENTS_API_ENABLED", scope: ["J"], kind: "var", local: "false" },
      { name: "MUSEBOOK_BRIDGE_POLL_MAX_MS", scope: ["E"], kind: "var", local: "25000" },
      { name: "MUSEBOOK_BRIDGE_MIN_VERSION", scope: ["E"], kind: "var", local: "1.0.0" },
      {
        name: "REGISTRY_REVIEW_NOTIFY_EMAIL",
        scope: ["J"],
        kind: "var",
        local: "registry@musebook.dev",
      },
    ],
  },
  {
    title: "Muse-mixer (ranking) and embeddings",
    vars: [
      { name: "MUSE_WEIGHTS_VERSION", scope: ["J", "L"], kind: "var", local: "none" },
      { name: "MUSE_RANKER_IMPL", scope: ["J", "L"], kind: "var", local: "heuristic" },
      {
        name: "MUSE_RANKER_MODEL_ID",
        scope: ["J", "L"],
        kind: "var",
        local: "muse-heuristic-2026-10",
      },
      { name: "MUSE_RANKER_ONNX_PATH", scope: ["J", "L"], kind: "var" },
      { name: "MUSE_RANKER_MODEL_URL", scope: ["J", "L"], kind: "var" },
      { name: "MUSE_DIVERSITY_IMPL", scope: ["J", "L"], kind: "var", local: "none" },
      { name: "MUSE_RANKER_TIMEOUT_MS", scope: ["J", "L"], kind: "var", local: "250" },
      {
        name: "MUSE_RETRIEVAL_NEW_USER_ACTION_THRESHOLD",
        scope: ["J", "L"],
        kind: "var",
        local: "20",
      },
      {
        name: "MUSE_RETRIEVAL_NEW_USER_INDEX_ID",
        scope: ["J", "L"],
        kind: "var",
        local: "cohort-centroid",
      },
      {
        name: "MUSE_RANKER_NEW_USER_ACTION_THRESHOLD",
        scope: ["J", "L"],
        kind: "var",
        local: "50",
      },
      { name: "MUSE_TOPK_CANDIDATES", scope: ["J", "L"], kind: "var", local: "100" },
      { name: "MUSE_MAX_CANDIDATES_PER_SOURCE", scope: ["J", "L"], kind: "var", local: "400" },
      { name: "MUSE_MIN_CANDIDATES", scope: ["J", "L"], kind: "var", local: "30" },
      { name: "MUSE_SOURCE_TIMEOUT_MS", scope: ["J", "L"], kind: "var", local: "180" },
      { name: "MUSE_HYDRATOR_TIMEOUT_MS", scope: ["J", "L"], kind: "var", local: "150" },
      { name: "MUSE_SCORER_TIMEOUT_MS", scope: ["J", "L"], kind: "var", local: "250" },
      { name: "MUSE_SLATE_TTL_SECONDS", scope: ["E", "J", "L"], kind: "var", local: "900" },
      { name: "MUSE_SCORE_CACHE_TTL_SECONDS", scope: ["J", "L"], kind: "var", local: "600" },
      { name: "MUSE_WEIGHTS_CACHE_TTL_SECONDS", scope: ["J", "L"], kind: "var", local: "30" },
      { name: "MUSE_HNSW_EF_SEARCH", scope: ["J", "L"], kind: "var", local: "200" },
      { name: "MUSE_BLOOM_CAPACITY", scope: ["J", "L"], kind: "var", local: "10000" },
      { name: "MUSE_BLOOM_ERROR_RATE", scope: ["J", "L"], kind: "var", local: "0.01" },
      { name: "MUSE_BLOOM_ROTATION", scope: ["J", "L"], kind: "var", local: "weekly" },
      { name: "MUSE_BLOOM_BYPASS_REMOVAL_RATIO", scope: ["J", "L"], kind: "var", local: "0.70" },
      { name: "MUSE_SEEN_EXACT_WINDOW", scope: ["J", "L"], kind: "var", local: "500" },
      {
        name: "MUSE_AGENT_CRAWL_MAX_PER_POST_PER_AGENT_PER_DAY",
        scope: ["J", "L"],
        kind: "var",
        local: "3",
      },
      { name: "MUSE_COLDSTART_ENABLED", scope: ["J", "L"], kind: "var", local: "true" },
      { name: "MUSE_COLDSTART_FOLLOWER_CAP", scope: ["J", "L"], kind: "var", local: "5000" },
      {
        name: "MUSE_COLDSTART_IMPRESSION_THRESHOLD",
        scope: ["J", "L"],
        kind: "var",
        local: "1000",
      },
      {
        name: "MUSE_COLDSTART_MAX_POST_AGE_MS",
        scope: ["J", "L"],
        kind: "var",
        local: "172800000",
      },
      { name: "MUSE_COLDSTART_MAX_POSITION_RATIO", scope: ["J", "L"], kind: "var", local: "0.5" },
      { name: "MUSE_COLDSTART_SLOT_MIN", scope: ["J", "L"], kind: "var", local: "3" },
      { name: "MUSE_COLDSTART_SLOT_MAX", scope: ["J", "L"], kind: "var", local: "12" },
      { name: "MUSE_COLDSTART_BETA_ALPHA0", scope: ["J", "L"], kind: "var", local: "1.0" },
      { name: "MUSE_COLDSTART_BETA_BETA0", scope: ["J", "L"], kind: "var", local: "1.0" },
      { name: "MUSE_COLDSTART_IMPRESSION_SCALE", scope: ["J", "L"], kind: "var", local: "1.0" },
      { name: "MUSE_COLDSTART_TS_TOP_K", scope: ["J", "L"], kind: "var", local: "5" },
      { name: "MUSE_VIEWER_EMBED_INTERVAL_H", scope: ["J", "L"], kind: "var", local: "24" },
      { name: "OUTBOX_SWEEP_MAX_ROWS", scope: ["J", "L"], kind: "var", local: "500" },
      { name: "EMBEDDING_MODEL", scope: ["J", "L"], kind: "var", local: "text-embedding-3-small" },
      { name: "EMBEDDING_DIMENSIONS", scope: ["J", "L"], kind: "var", local: "1536" },
    ],
  },
  {
    title: "Telemetry and analytics",
    vars: [
      { name: "TELEMETRY_ENABLED", scope: ["E", "M", "J"], kind: "var", local: "true" },
      { name: "TELEMETRY_IMPRESSION_SAMPLE", scope: ["E"], kind: "var", local: "1.0" },
      { name: "TELEMETRY_BATCH_MAX_EVENTS", scope: ["E"], kind: "var", local: "16" },
      { name: "TELEMETRY_IDLE_FLUSH_MS", scope: ["VP", "E"], kind: "var", local: "5000" },
      { name: "TELEMETRY_CLOCK_SKEW_MAX_MS", scope: ["E"], kind: "var", local: "21600000" },
      { name: "TELEMETRY_ANON_COOKIE_TTL_S", scope: ["E"], kind: "var", local: "86400" },
      { name: "TELEMETRY_ANON_ID_RETENTION_DAYS", scope: ["J"], kind: "var", local: "30" },
      { name: "TELEMETRY_IP_HASH_RETENTION_DAYS", scope: ["J"], kind: "var", local: "7" },
      { name: "TELEMETRY_IMPRESSION_COMPACT_DAYS", scope: ["J"], kind: "var", local: "120" },
      { name: "TELEMETRY_HUMAN_RETENTION_DAYS", scope: ["J"], kind: "var", local: "400" },
      { name: "TELEMETRY_AGENT_RETENTION_DAYS", scope: ["J"], kind: "var", local: "90" },
      { name: "ANALYTICS_MIN_COHORT", scope: ["E", "J"], kind: "var", local: "5" },
      { name: "ANALYTICS_AGENT_BREAKDOWN_CACHE_S", scope: ["J"], kind: "var", local: "900" },
    ],
  },
  {
    title: "Observability and alerting",
    vars: [
      {
        name: "SENTRY_DSN",
        scope: ["E", "M", "J"],
        kind: "var",
        comment: "Public by design. traces persist:false — they are not double-billed.",
      },
      { name: "NEXT_PUBLIC_SENTRY_DSN", scope: ["VP", "VPr", "CI"], kind: "public", local: "" },
      { name: "SENTRY_AUTH_TOKEN", scope: ["CI"], kind: "secret" },
      { name: "ALERT_WEBHOOK_URL", scope: ["J"], kind: "var" },
      { name: "ALERT_WEBHOOK_SECRET", scope: ["J"], kind: "secret" },
      { name: "SYNTHETIC_GATED_SLUG", scope: ["E", "J"], kind: "var" },
      { name: "PAGERDUTY_ROUTING_KEY", scope: ["J"], kind: "secret" },
    ],
  },
  {
    title: "CI-only, run-once, and platform-injected",
    vars: [
      {
        name: "MCP_TEST_URL",
        scope: ["CI"],
        kind: "var",
        comment: "Target for §17.9's MCP conformance run. On the ignore list.",
      },
      { name: "TURBO_TOKEN", scope: ["CI"], kind: "secret" },
      { name: "TURBO_TEAM", scope: ["CI"], kind: "var" },
      { name: "NEXT_TELEMETRY_DISABLED", scope: ["CI"], kind: "var", local: "1" },
      {
        name: "VERCEL_TOKEN",
        scope: ["L", "CI"],
        kind: "secret",
        comment: "vercel deploy / vercel env. Never set on a deployment.",
      },
      { name: "VERCEL_ORG_ID", scope: ["L", "CI"], kind: "var" },
      { name: "VERCEL_PROJECT_ID_WEB", scope: ["L", "CI"], kind: "var" },
      {
        name: "VERCEL_ENV",
        scope: ["VP", "VPr"],
        kind: "var",
        comment: "Platform-injected: production | preview | development.",
      },
      {
        name: "VERCEL_GIT_COMMIT_SHA",
        scope: ["VP", "VPr"],
        kind: "var",
        comment: "Platform-injected. Not available in a Worker — that is MB_RELEASE_SHA.",
      },
      {
        name: "VERCEL_OIDC_TOKEN",
        scope: ["VP", "VPr"],
        kind: "secret",
        comment: "Platform-injected for @vercel/sandbox. Nothing to set by hand.",
      },
    ],
  },
];

/** Names read in CI or injected by a platform that are deliberately not in an example file. */
export const IGNORED = [
  "CI",
  "MCP_TEST_URL",
  "NODE_ENV",
  "VERCEL_ENV",
  "VERCEL_URL",
  "VERCEL_GIT_COMMIT_SHA",
  "VERCEL_OIDC_TOKEN",
  "MB_RELEASE_SHA",
  "TURBO_TOKEN",
  "TURBO_TEAM",
  "NEXT_TELEMETRY_DISABLED",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
];

/** Bindings. NOT environment variables; listed so the checker can tell the
 *  difference between `env.HYPERDRIVE_FRESH` (a binding) and `env.X402_MODE`
 *  (a var it must find in the manifest). */
export const BINDINGS = [
  "HYPERDRIVE_CACHED",
  "HYPERDRIVE_FRESH",
  "PUBLIC_MEDIA",
  "PAID_MEDIA",
  "ARTIFACTS",
  "UPLOADS",
  "GRANTS",
  "WBA_DIR",
  "OAUTH_KV",
  // One entry per queue in section 4.13.2's registry — seven, not four.
  "Q_CLASSIFY",
  "Q_MEDIA",
  "Q_MEDIA_FINALIZE",
  "Q_DISTRIBUTE",
  "Q_DSAR",
  "Q_EMBED",
  "Q_AGENT_CANCEL",
  "Q_R2_EVENTS",
  // Service binding: apps/edge -> musebook-worker's SlateBuilder entrypoint.
  "MIXER",
  "TELEMETRY",
  "PAYWALL",
];
