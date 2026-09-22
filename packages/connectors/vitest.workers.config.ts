import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineProject } from "vitest/config";

export default defineProject({
  // The SSRF guard and the signed egress path run inside Workers; a guard proven
  // only under Node is proven on the wrong runtime (§17.10).
  plugins: [cloudflareTest({ wrangler: { configPath: "./test/wrangler.workers.jsonc" } })],
  test: {
    name: "connectors-workers",
    include: ["test/**/*.test.ts"],
    coverage: { enabled: false },
  },
});
