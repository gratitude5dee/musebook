import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineProject } from "vitest/config";

export default defineProject({
  // A minimal wrangler config that declares NO bindings: a pure package must need none.
  plugins: [cloudflareTest({ wrangler: { configPath: "./test/wrangler.workers.jsonc" } })],
  test: {
    name: "kernel-workers",
    include: ["test/**/*.test.ts"],
    // The same files. If a fixture differs between the two runs, something in the
    // package reached for a host API — the only failure this run exists to find.
    coverage: { enabled: false },
  },
});
