import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "eslint-plugin-musebook",
    environment: "node",
    include: ["rules/**/*.test.ts"],
  },
});
