import { describe, expect, it } from "vitest";
import worker from "../src/index.js";

describe("musebook-worker", () => {
  it("exports queue and scheduled handlers", () => {
    expect(typeof worker.queue).toBe("function");
    expect(typeof worker.scheduled).toBe("function");
  });
});
