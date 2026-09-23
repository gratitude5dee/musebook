// manifest.test.ts — §10.12 checks 1 + 7 (submission-side halves).
import { describe, expect, it } from "vitest";
import { ConnectorManifestZ, canonicalize } from "../src/manifest.js";
import { manifestCanDraft, parseManifest } from "../src/registry.js";
import { manifestFor } from "./contract/harnesses.js";

const BASE = manifestFor({ kind: "mcp_http", url: "https://mcp.example/mcp" }, ["feed.read"]);

describe("ConnectorManifestZ", () => {
  it("rejects an unknown top-level key (check 1)", () => {
    const hostile = { ...BASE, unexpected: "key" };
    expect(ConnectorManifestZ.safeParse(hostile).success).toBe(false);
  });

  it("accepts the seeded manifest shape", () => {
    expect(ConnectorManifestZ.safeParse(BASE).success).toBe(true);
  });

  it("rejects a non-https transport URL", () => {
    const bad = {
      ...BASE,
      transports: [{ kind: "mcp_http", url: "http://mcp.example/mcp" }],
    };
    expect(ConnectorManifestZ.safeParse(bad).success).toBe(false);
  });

  it("canonicalize is deterministic under key-order shuffle", () => {
    const a = { b: 1, a: { y: [2, 3], x: "s" }, z: undefined };
    const b = { a: { x: "s", y: [2, 3] }, b: 1 };
    expect(canonicalize(a)).toBe(canonicalize(b));
    expect(canonicalize(a)).toBe('{"a":{"x":"s","y":[2,3]},"b":1}');
  });

  it("parseManifest returns canonical bytes on ok and issue strings on bad", () => {
    const ok = parseManifest(BASE);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.canonical).toBe(canonicalize(BASE));
    const bad = parseManifest({ manifestVersion: "1999-01-01" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.issues.length).toBeGreaterThan(0);
  });
});

describe("manifestCanDraft (10.4.4 check 7)", () => {
  it("rejects post.draft on an a2a_card-only manifest", () => {
    const m = manifestFor({ kind: "a2a_card", agentCardUrl: "https://a2a.example/card.json" }, [
      "post.draft",
      "feed.read",
    ]);
    expect(manifestCanDraft(m)).toBe(false);
  });

  it("allows post.draft when a draft-capable transport exists", () => {
    for (const t of [
      { kind: "mcp_http", url: "https://mcp.example/mcp" },
      { kind: "http_openapi", baseUrl: "https://api.example" },
      { kind: "bridge_token", runtime: "generic", minBridgeVersion: "1.0.0" },
    ] as const) {
      const m = manifestFor(t, ["post.draft"]);
      expect(manifestCanDraft(m)).toBe(true);
    }
  });

  it("allows a read-only a2a manifest", () => {
    const m = manifestFor({ kind: "a2a_card", agentCardUrl: "https://a2a.example/card.json" }, [
      "feed.read",
    ]);
    expect(manifestCanDraft(m)).toBe(true);
  });
});
