import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineProject } from "vitest/config";

export default defineProject({
  // A minimal wrangler config that declares NO bindings: a pure package must need none.
  plugins: [cloudflareTest({ wrangler: { configPath: "./test/wrangler.workers.jsonc" } })],
  test: {
    name: "media-workers",
    include: ["test/**/*.test.ts"],
    // provenance.test.ts + video paths drive sharp/c2pa-node/ffmpeg — node
    // only by §11.9.6's boundary; the workers run proves the rest is portable.
    exclude: ["test/provenance.test.ts"],
    coverage: { enabled: false },
  },
});
