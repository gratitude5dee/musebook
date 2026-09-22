import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineProject } from "vitest/config";

export default defineProject({
  plugins: [cloudflareTest({ wrangler: { configPath: "./test/wrangler.workers.jsonc" } })],
  test: {
    name: "x402-workers",
    include: ["test/**/*.test.ts"],
    // The T5 live tier hits a real facilitator over HTTP — node only (§17.6).
    exclude: ["test/live/**"],
    coverage: { enabled: false },
  },
});
