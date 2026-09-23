import { describe, expect, it } from "vitest";
import * as pkg from "../src/index";

describe("@musebook/distributor", () => {
  it("exports its module surface", () => {
    expect(pkg).toBeTypeOf("object");
  });
});
