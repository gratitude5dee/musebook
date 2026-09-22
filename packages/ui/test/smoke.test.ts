import { describe, expect, it } from "vitest";
import * as pkg from "../src/index.js";

describe("@musebook/ui", () => {
  it("exports its module surface", () => {
    expect(pkg).toBeTypeOf("object");
  });
});
