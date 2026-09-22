import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "media",
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
