import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineProject } from "vitest/config";

export default defineProject({
  // A minimal wrangler config that declares NO bindings: a pure package must need none.
  plugins: [cloudflareTest({ wrangler: { configPath: "./test/wrangler.workers.jsonc" } })],
  test: {
    name: "classify-workers",
    include: ["test/**/*.test.ts"],
    // no-private-state reads the migration file from disk (node:fs) — a
    // deliberate node-only proof like muse-mixer's postgres-adapter exclusion.
    exclude: ["test/no-private-state.test.ts"],
    coverage: { enabled: false },
  },
});
