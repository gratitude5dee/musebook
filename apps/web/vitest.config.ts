import { fileURLToPath } from "node:url";
import { defineProject } from "vitest/config";

export default defineProject({
  resolve: {
    // The route modules under test import via the Next.js "@/" alias.
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
  test: {
    name: "web",
    environment: "node",
    include: ["test/**/*.test.ts"],
    // The M18 cite test writes action_events rows dated now(): the local stack
    // has only the two bootstrap leaves without the daily partition job, so the
    // shared setup keeps the same 7-day headroom the edge/worker tiers rely on.
    globalSetup: ["../../scripts/test/ensure-worker-role.mjs"],
    // proxy.ts is a security control with a 100/100/100/100 floor (§17.14).
    // Vitest 4 removed per-project coverage config — the floor lives in the
    // root vitest.config.ts thresholds once proxy.ts has tests (M4/G-COV).
  },
});
