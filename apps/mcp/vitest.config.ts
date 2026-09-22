import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineProject } from "vitest/config";

export default defineProject({
  plugins: [
    cloudflareTest({
      // Bindings, routes, limits and compatibility_date all come from the REAL config
      // (§3.6.1). Do not restate them here: a second copy is a second thing to drift.
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        kvNamespaces: ["OAUTH_KV", "GRANTS"],
        r2Buckets: ["PUBLIC_MEDIA", "PAID_MEDIA"],
        queueProducers: {
          Q_CLASSIFY: { queueName: "musebook-classify" },
          Q_MEDIA: { queueName: "musebook-media" },
          Q_MEDIA_FINALIZE: { queueName: "musebook-media-finalize" },
          Q_AGENT_CANCEL: { queueName: "musebook-agent-cancel" },
        },
      },
    }),
  ],
  test: {
    name: "mcp",
    include: ["test/**/*.test.ts"],
    // Coverage activates with this app's own milestone (§17.14 activates
    // floors per milestone); until then the workerd pool skips collection,
    // matching the *-workers portability projects.
    coverage: { enabled: false },
    // No `environment` key: the plugin IS the environment.
  },
});
