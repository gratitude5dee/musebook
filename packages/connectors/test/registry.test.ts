// registry.test.ts — §10.12 check 16 halves + transitions + hostsOf.
import { describe, expect, it } from "vitest";
import { resolveAdapter, canTransition, hostsOf } from "../src/registry.js";
import { ADAPTERS } from "../src/adapters/index.js";
import { manifestFor } from "./contract/harnesses.js";

describe("resolveAdapter", () => {
  it("resolves every bundled transport kind", () => {
    const kinds = [
      { kind: "mcp_http", url: "https://mcp.example/mcp" },
      { kind: "a2a_card", agentCardUrl: "https://a2a.example/card.json" },
      { kind: "http_openapi", baseUrl: "https://api.example" },
      { kind: "bridge_token", runtime: "generic", minBridgeVersion: "1.0.0" },
    ] as const;
    for (const t of kinds) {
      const manifest = manifestFor(t, ["feed.read"]);
      const c = resolveAdapter({
        manifest,
        connectorRowId: "crow-1",
        transport: manifest.transports[0],
        credential: null,
      });
      expect(c.transport).toBe(t.kind);
    }
  });

  it("refuses a post.draft manifest on the a2a_card adapter (check 16)", () => {
    const manifest = manifestFor(
      { kind: "a2a_card", agentCardUrl: "https://a2a.example/card.json" },
      ["post.draft", "feed.read"],
    );
    expect(() =>
      resolveAdapter({
        manifest,
        connectorRowId: "crow-1",
        transport: manifest.transports[0],
        credential: null,
      }),
    ).toThrow(/connector_missing_draftPost/);
  });

  it("every ADAPTERS factory is reachable through the record", () => {
    for (const k of ["mcp_http", "a2a_card", "http_openapi", "bridge_token"] as const) {
      expect(typeof ADAPTERS[k]).toBe("function");
    }
  });
});

describe("registry state machine", () => {
  it("accepts the legal transitions only", () => {
    expect(canTransition("submitted", "listed")).toBe(true);
    expect(canTransition("submitted", "verified")).toBe(false);
    expect(canTransition("listed", "verified")).toBe(true);
    expect(canTransition("listed", "suspended")).toBe(true);
    expect(canTransition("verified", "suspended")).toBe(true);
    expect(canTransition("suspended", "listed")).toBe(true);
    expect(canTransition("rejected", "listed")).toBe(false);
    expect(canTransition("verified", "submitted")).toBe(false);
  });
});

describe("hostsOf", () => {
  it("collects every manifest host guardedFetch may reach", () => {
    const m = manifestFor(
      { kind: "mcp_http", url: "https://mcp.example/mcp" },
      ["feed.read"],
    );
    const hosts = hostsOf(m);
    expect(hosts).toContain("mcp.example");
    expect(hosts).toContain("musebook.example");
  });

  it("skips non-url strings and bridge transports without a URL", () => {
    const m = manifestFor(
      { kind: "bridge_token", runtime: "generic", minBridgeVersion: "1.0.0" },
      ["post.draft"],
    );
    const hosts = hostsOf(m);
    expect(hosts).toEqual(["musebook.example"]);
  });
});
