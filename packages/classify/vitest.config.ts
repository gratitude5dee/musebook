import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "classify",
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
