import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "x402",
    environment: "node",
    include: ["test/**/*.test.ts"],
    exclude: ["test/live/**"],
  },
});
