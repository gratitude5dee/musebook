import { describe, expect, it } from "vitest";
import * as pkg from "../src/index.js";

describe("@musebook/muse-mixer", () => {
  it("exports its module surface", () => {
    expect(pkg).toBeTypeOf("object");
  });
});
