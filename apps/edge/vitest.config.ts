import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineProject } from "vitest/config";

export default defineProject({
  resolve: {
    alias: {
      // `pg` ships CJS + node: builtins; the workers pool can't transform it.
      // Tests never reach the production query path — they inject deps.query —
      // so the alias points at a typed stand-in instead of the real package.
      pg: new URL("./test/stubs/pg.ts", import.meta.url).pathname,
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
          Q_DISTRIBUTE: { queueName: "musebook-distribute" },
          Q_EMBED: { queueName: "musebook-embed" },
        },
        bindings: {
          MUSEBOOK_EDGE_SECRET: "test-edge-secret-0000",
          ORIGIN_HOST: "origin.test",
          X402_NETWORK: "eip155:8453",
          X402_PAY_TO: "0x0000000000000000000000000000000000000001",
        },
      },
    }),
  ],
  test: {
    name: "edge",
    include: ["test/**/*.test.ts"],
    // No `environment` key: the plugin IS the environment.
    // Istanbul — v8 needs node:inspector, which workerd does not implement
    // (the plugin rejects it). §17.14 measures apps/edge on this tier only.
    coverage: { provider: "istanbul" },
  },
});
