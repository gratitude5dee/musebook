import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineProject } from "vitest/config";

// The gate tier (§17.11.2/§17.11.6): the SAME Worker the edge project builds,
// but with REAL pg — the access-decision reads go over the Hyperdrive
// localConnectionString to the local Supabase, because a stubbed query path
// cannot prove the paywall. The base edge project keeps its pg alias for the
// unit tests that inject deps.query on purpose.
export default defineProject({
  resolve: {
    alias: {
      // `pg`'s CJS tree cannot pass through the workers pool's module pipeline;
      // postgres.js is pure ESM and Cloudflare-native. The shim implements the
      // exact node-postgres subset the read path uses.
      pg: new URL("./test/stubs/pg-live.ts", import.meta.url).pathname,
      // The origin-lockdown test imports apps/web/proxy.ts verbatim — the only
      // external symbol it needs is next/server, shimmed onto Web API types.
      "next/server": new URL("./test/stubs/next-server.ts", import.meta.url).pathname,
    },
  },
  plugins: [
    cloudflareTest({
      // Bindings, routes, limits and compatibility_date all come from the REAL config
      // (§3.6.1). Do not restate them here: a second copy is a second thing to drift.
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // MIXER is a service binding to musebook-worker (§3.10); the plugin
        // resolves `miniflare.workers` entries by name as `core:user:<name>`.
        workers: [
          {
            name: "musebook-worker",
            modules: true,
            compatibilityDate: "2026-09-10",
            script:
              'export default { fetch() { return new Response("musebook-worker test stub", { status: 501 }); } };' +
              ' export class SlateBuilder { fetch() { return new Response("SlateBuilder test stub", { status: 501 }); } }',
          },
        ],
        kvNamespaces: ["GRANTS", "WBA_DIR"],
        r2Buckets: ["PUBLIC_MEDIA", "PAID_MEDIA", "ARTIFACTS", "UPLOADS"],
        queueProducers: {
          Q_CLASSIFY: { queueName: "musebook-classify" },
          Q_MEDIA: { queueName: "musebook-media" },
          Q_MEDIA_FINALIZE: { queueName: "musebook-media-finalize" },
          Q_DISTRIBUTE: { queueName: "musebook-distribute" },
          Q_EMBED: { queueName: "musebook-embed" },
          Q_AGENT_CANCEL: { queueName: "musebook-agent-cancel" },
        },
        bindings: {
          MUSEBOOK_EDGE_SECRET: "test-edge-secret-0000",
          // Real R2 S3 creds for the M7 presign round-trip (gate sources .env).
          CF_ACCOUNT_ID: process.env.CF_ACCOUNT_ID ?? "missing",
          R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID ?? "missing",
          R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY ?? "missing",
          ORIGIN_HOST: "origin.test",
          X402_MODE: "live", // the gate matrix asserts real 402s — shadow serves 200
          // Sepolia tuple — assertAssetEnv (§6.7) cross-checks all four against
          // X402_ASSETS or every gated route 503s.
          X402_NETWORK: "eip155:84532",
          X402_CHAIN_ID: "84532",
          X402_ASSET_ADDRESS: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
          X402_ASSET_EIP712_NAME: "USDC",
          X402_ASSET_DECIMALS: "6",
          X402_PAY_TO: "0x0000000000000000000000000000000000000001",
          // Testnet facilitator for the M8 wire tier: the Sepolia tuple above
          // rules CDP out only by network, but the gate has no CDP secrets —
          // x402.org's facilitator is unauthenticated and testnet-only, which
          // is exactly what this tier settles through.
          X402_FACILITATOR_URL: process.env.X402_FACILITATOR_URL ?? "https://x402.org/facilitator",
          // The funded Sepolia payer for the M8.1/2/5 live checks (H9); the
          // test skips loudly when unset.
          X402_TEST_PAYER_KEY: process.env.X402_TEST_PAYER_KEY ?? "missing",
        },
      },
    }),
  ],
  test: {
    name: "edge-gate",
    include: ["test/gate/**/*.test.ts"],
    // `db reset` recreates musebook_worker without a password — restore the
    // localConnectionString convention before the first binding connects.
    globalSetup: ["../../scripts/test/ensure-worker-role.mjs"],
    // No `environment` key: the plugin IS the environment.
    // Istanbul — v8 needs node:inspector, which workerd does not implement
    // (the plugin rejects it). §17.14 measures apps/edge on this tier only.
    coverage: { provider: "istanbul" },
    // postgres.js leaves read sockets open across pool teardown — the
    // rejections it raises afterwards carry these strings and nothing else.
    // Drop only them; every other unhandled error still fails the run.
    onUnhandledError: (e: unknown) => {
      try {
        const m =
          e instanceof Error
            ? e.message
            : typeof e === "object" && e !== null
              ? JSON.stringify(e)
              : String(e);
        return !(m.includes("socket has been closed") || m.includes("SpanParent"));
      } catch {
        return true;
      }
    },
  },
});
