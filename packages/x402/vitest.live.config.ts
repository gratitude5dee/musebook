// vitest.live.config.ts — §17.6 T5 live-external tier, opt-in only. The gate
// runs `vitest run --config packages/x402/vitest.live.config.ts` with
// X402_FACILITATOR_URL + X402_TEST_PAYER_KEY set; never part of `pnpm test`.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "x402-live",
    environment: "node",
    include: ["test/live/**/*.test.ts"],
    testTimeout: 60_000, // a real Sepolia broadcast is not a 10 s unit test
    hookTimeout: 60_000,
  },
});
