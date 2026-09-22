import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "web",
    environment: "node",
    include: ["test/**/*.test.ts"],
    // proxy.ts is a security control with a 100/100/100/100 floor (§17.14).
    // Vitest 4 removed per-project coverage config — the floor lives in the
    // root vitest.config.ts thresholds once proxy.ts has tests (M4/G-COV).
  },
});
