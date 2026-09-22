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
      },
    }),
  ],
  test: {
    name: "worker",
    include: ["test/**/*.test.ts"],
    // Coverage activates with this app's own milestone (§17.14 activates
    // floors per milestone); until then the workerd pool skips collection,
    // matching the *-workers portability projects.
    coverage: { enabled: false },
    // No `environment` key: the plugin IS the environment.
  },
});
