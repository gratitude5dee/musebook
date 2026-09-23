import { describe, expect, it } from "vitest";
import { TOOL_FOR, parseJsonArgv } from "../src/index.js";

describe("musebook CLI", () => {
  it("maps every verb to an MCP tool name", () => {
    expect(Object.keys(TOOL_FOR).sort()).toEqual(
      [
        "analytics",
        "artifact",
        "asset",
        "authors",
        "feed",
        "follow",
        "pay",
        "post",
        "pricing",
        "read",
        "search",
      ].sort(),
    );
    expect(TOOL_FOR.pay).toBe("purchase_access");
    expect(TOOL_FOR.post).toBe("submit_post");
  });

  it("parseJsonArgv handles --k v, --k=v, flags and a JSON blob", () => {
    expect(parseJsonArgv(['{"a":1,"b":"x"}'])).toEqual({ a: 1, b: "x" });
    expect(parseJsonArgv(["--query", "hi", "--limit=20", "--agent_priced_only"])).toEqual({
      query: "hi",
      limit: 20,
      agent_priced_only: true,
    });
    expect(parseJsonArgv(["--unfollow"])).toEqual({ unfollow: true });
    expect(parseJsonArgv(["--price_atomic", "500", "--publish"])).toEqual({
      price_atomic: 500,
      publish: true,
    });
    expect(parseJsonArgv(["--tags", '["a","b"]'])).toEqual({ tags: ["a", "b"] });
  });
});
