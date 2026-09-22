import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "artifacts",
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
