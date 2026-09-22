import { describe, expect, it } from "vitest";
import worker from "../src/index.js";

describe("musebook-mcp", () => {
  it("exports a fetch handler", () => {
    expect(typeof worker.fetch).toBe("function");
  });
});
