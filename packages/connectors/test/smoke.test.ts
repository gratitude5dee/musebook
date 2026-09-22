import { describe, expect, it } from "vitest";
import * as pkg from "../src/index.js";

describe("@musebook/connectors", () => {
  it("exports its module surface", () => {
    expect(pkg).toBeTypeOf("object");
  });
});
