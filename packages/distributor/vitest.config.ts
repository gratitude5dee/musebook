import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "distributor",
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
