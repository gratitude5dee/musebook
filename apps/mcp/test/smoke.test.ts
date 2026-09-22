import { describe, expect, it } from "vitest";
import worker from "../src/index.js";

describe("musebook-mcp", () => {
  it("exports a fetch handler", () => {
    expect(typeof worker.fetch).toBe("function");
  });

  it("serves the RFC 9728 protected-resource metadata doc", async () => {
    const res = await worker.fetch(
      new Request("https://mcp.musebook.dev/.well-known/oauth-protected-resource/mcp"),
      {} as Env,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
    const doc = (await res.json()) as {
      resource?: string;
      authorization_servers?: string[];
      scopes_supported?: string[];
    };
    expect(doc.resource).toBe("https://mcp.musebook.dev/mcp");
    expect(doc.authorization_servers).toContain("https://mcp.musebook.dev");
    expect(doc.scopes_supported).toContain("feed:read");
  });

  it("answers /healthz", async () => {
    const res = await worker.fetch(
      new Request("https://mcp.musebook.dev/healthz"),
      {} as Env,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
  });

  it("rejects MCP calls on a disallowed host", async () => {
    const res = await worker.fetch(
      new Request("https://evil.example/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      }),
      {} as Env,
      {} as ExecutionContext,
    );
    expect([400, 403, 421]).toContain(res.status);
  });
});
