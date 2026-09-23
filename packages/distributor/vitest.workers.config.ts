import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineProject } from "vitest/config";

export default defineProject({
  // The validator + counter run inside Workers (the consumer and the compose
  // page's live preview both do); a counter proven only under Node is proven
  // on the wrong runtime — Intl.Segmenter on workerd is UNVERIFIED until this
  // tier runs (§12.3.2 note, M10 open question).
  plugins: [cloudflareTest({ wrangler: { configPath: "./test/wrangler.workers.jsonc" } })],
  test: {
    name: "distributor-workers",
    include: ["test/**/*.test.ts"],
    coverage: { enabled: false },
  },
});
