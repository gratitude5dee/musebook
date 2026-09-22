import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineProject } from "vitest/config";

export default defineProject({
  plugins: [
    cloudflareTest({
      // Bindings, routes, limits and compatibility_date all come from the REAL config
      // (§3.6.1). Do not restate them here: a second copy is a second thing to drift.
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        kvNamespaces: ["GRANTS"],
        r2Buckets: ["PUBLIC_MEDIA", "PAID_MEDIA", "ARTIFACTS", "UPLOADS"],
        queueConsumers: {
          "musebook-classify": { maxBatchSize: 25 },
          "musebook-media": { maxBatchSize: 1 },
        },
        // Producers for the outbox sweep's sendBatch (§17.11.4 spies on these).
        queueProducers: {
          Q_CLASSIFY: { queueName: "musebook-classify" },
          Q_EMBED: { queueName: "musebook-embed" },
          Q_DISTRIBUTE: { queueName: "musebook-distribute" },
          Q_MEDIA: { queueName: "musebook-media" },
          Q_MEDIA_FINALIZE: { queueName: "musebook-media-finalize" },
          Q_AGENT_CANCEL: { queueName: "musebook-agent-cancel" },
        },
      },
    }),
  ],
  // `pg`'s CJS internals resolve ESM builds workerd rejects; the gate tests
  // reach the real local DB through the postgres.js shim instead (D36).
  resolve: { alias: { pg: new URL("./test/stubs/pg-live.ts", import.meta.url).pathname } },
  test: {
    name: "worker",
    include: ["test/**/*.test.ts"],
    // Every suite shares the one local DB and resetSeed() clears effect/outbox
    // rows between tests — run files serially or a neighbor file's reset lands
    // mid-assertion (outbox-sweeper vs queue-idempotency raced green->red).
    fileParallelism: false,
    // Coverage activates with this app's own milestone (§17.14 activates
    // floors per milestone); until then the workerd pool skips collection,
    // matching the *-workers portability projects.
    coverage: { enabled: false },
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
    // No `environment` key: the plugin IS the environment.
  },
});
