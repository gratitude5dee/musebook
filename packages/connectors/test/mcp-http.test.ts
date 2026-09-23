// packages/connectors/test/mcp-http.test.ts — adapter unit tests over a stub
// ctx.fetch. Covers mcp_http's error/branch surface the contract suite doesn't:
// !ok statuses, JSON-RPC error frames, absent result/resultType, discover's
// -32601 fallback, input_required declines, draftPost validation, revoke.
import { describe, expect, it } from "vitest";
import { makeMcpHttpConnector, mcpCall, discover } from "../src/adapters/mcp-http.js";
import type { ConnectorContext, DraftRequest } from "../src/connector.js";
import type { ConnectorManifest } from "../src/manifest.js";

const MANIFEST: ConnectorManifest = {
  connectorId: "test-mcp",
  version: "1.0.0",
  displayName: "Test MCP",
  transports: [{ kind: "mcp_http", url: "https://agent.example/mcp" }],
  capabilities: [{ capability: "post.draft" }],
  auth: { kind: "bearer" },
};

const INIT = {
  manifest: MANIFEST,
  connectorRowId: "11111111-1111-4111-8111-000000000001",
  transport: { kind: "mcp_http" as const, url: "https://agent.example/mcp" },
  credential: "cred-1",
};

type Responder = (url: string, init?: RequestInit) => Promise<Response>;

function ctx(respond: Responder, audits: Record<string, unknown>[] = []): ConnectorContext {
  return {
    delegationId: "22222222-2222-4222-8222-000000000002",
    ownerUserId: "33333333-3333-4333-8333-000000000003",
    agentIdentityId: "44444444-4444-4444-8444-000000000004",
    scopes: [],
    remainingAtomic: 0n,
    fetch: respond,
    audit: async (action, meta) => {
      audits.push({ action, meta });
    },
    requestId: "req-1",
    signal: new AbortController().signal,
  };
}

function rpcResult(result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: "mb-req-1", result }), {
    headers: { "content-type": "application/json" },
  });
}
function rpcError(code: number, message: string): Response {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", id: "mb-req-1", error: { code, message } }),
    {
      headers: { "content-type": "application/json" },
    },
  );
}

const DRAFT_REQ: DraftRequest = {
  intent: "write a post",
  targetPlatforms: ["x"],
  maxLengthChars: 500,
  taskId: "draft:x:1",
};

describe("mcpCall", () => {
  it("throws mcp_http_<status> on non-ok responses", async () => {
    await expect(
      mcpCall(
        ctx(async () => new Response("nope", { status: 500 })),
        "https://a/mcp",
        null,
        "tools/list",
        {},
      ),
    ).rejects.toThrow("mcp_http_500");
  });

  it("throws mcp_rpc_error with code and message, and tolerates a missing code", async () => {
    const c = ctx(async () => rpcError(-32602, "bad params"));
    await expect(mcpCall(c, "https://a/mcp", null, "tools/list", {})).rejects.toThrow(
      "mcp_rpc_error:-32602:bad params",
    );
    const c2 = ctx(
      async () =>
        new Response(JSON.stringify({ jsonrpc: "2.0", error: { message: "nope" } }), {
          headers: { "content-type": "application/json" },
        }),
    );
    await expect(mcpCall(c2, "https://a/mcp", null, "x", {})).rejects.toThrow(
      "mcp_rpc_error::nope",
    );
  });

  it("synthesizes a complete result when result/resultType are absent", async () => {
    const noResult = ctx(
      async () =>
        new Response(JSON.stringify({ jsonrpc: "2.0" }), {
          headers: { "content-type": "application/json" },
        }),
    );
    expect(await mcpCall(noResult, "https://a/mcp", null, "tools/list", {})).toEqual({
      resultType: "complete",
    });
    const noType = ctx(async () => rpcResult({ structuredContent: { ok: true } }));
    const r = await mcpCall(noType, "https://a/mcp", null, "tools/list", {});
    expect(r.resultType).toBe("complete");
    expect(r.structuredContent).toEqual({ ok: true });
  });

  it("sets mcp-name only for tools/call, and authorization only with a credential", async () => {
    const seen: RequestInit[] = [];
    const c = ctx(async (_u, init) => {
      seen.push(init ?? {});
      return rpcResult({ resultType: "complete" });
    });
    await mcpCall(c, "https://a/mcp", "tok", "tools/call", { name: "draft_post" });
    const h = seen[0]!.headers as Record<string, string>;
    expect(h["mcp-name"]).toBe("draft_post");
    expect(h.authorization).toBe("Bearer tok");
    seen.length = 0;
    await mcpCall(c, "https://a/mcp", null, "tools/list", {});
    const h2 = seen[0]!.headers as Record<string, string>;
    expect(h2["mcp-name"]).toBeUndefined();
    expect(h2.authorization).toBeUndefined();
  });
});

describe("discover", () => {
  it("falls back to tools/list when server/discover is unimplemented (-32601)", async () => {
    const calls: string[] = [];
    const c = ctx(async (_u, init) => {
      const body = JSON.parse(String(init?.body)) as { method: string };
      calls.push(body.method);
      return body.method === "server/discover"
        ? rpcError(-32601, "no")
        : rpcResult({ resultType: "complete" });
    });
    const r = await discover(c, "https://a/mcp", null);
    expect(calls).toEqual(["server/discover", "tools/list"]);
    expect(r.resultType).toBe("complete");
  });

  it("rethrows non-32601 errors and non-Error throws", async () => {
    await expect(
      discover(
        ctx(async () => rpcError(-32602, "bad")),
        "https://a/mcp",
        null,
      ),
    ).rejects.toThrow("mcp_rpc_error:-32602");
    await expect(
      discover(
        ctx(async () => Promise.reject("string-throw") as never),
        "https://a/mcp",
        null,
      ),
    ).rejects.toBe("string-throw");
  });
});

describe("handshake", () => {
  const REQ = {
    musebookProtocolVersion: "2026-09-01" as const,
    requestedCapabilities: ["post.draft", "feed.read"] as ("post.draft" | "feed.read")[],
    ownerUserId: "u",
    callbackMcpUrl: "https://mcp.musebook.dev/mcp" as const,
    locale: "en",
  };

  it("declines everything on input_required and audits it", async () => {
    const audits: Record<string, unknown>[] = [];
    const c = makeMcpHttpConnector(INIT);
    const res = await c.handshake(
      ctx(async () => rpcResult({ resultType: "input_required" }), audits),
      REQ,
    );
    expect(res.ok).toBe(false);
    expect(res.declined).toHaveLength(2);
    expect(res.declined[0]!.reason).toBe("input_required_declined");
    expect(audits[0]!.action).toBe("connector.input_required_declined");
  });

  it("grants post.draft only when the discovered tools advertise a draft tool", async () => {
    const c = makeMcpHttpConnector(INIT);
    const withDraft = await c.handshake(
      ctx(async () =>
        rpcResult({
          structuredContent: {
            tools: [{ name: "draft_post" }],
            agentInstanceId: "inst-1",
            agentDisplayName: "Far Agent",
            protocolVersion: "2026-01-01",
          },
        }),
      ),
      REQ,
    );
    expect(withDraft.ok).toBe(true);
    expect(withDraft.grantedCapabilities).toContain("post.draft");
    expect(withDraft.agentInstanceId).toBe("inst-1");
    expect(withDraft.agentDisplayName).toBe("Far Agent");
    expect(withDraft.remoteProtocolVersion).toBe("2026-01-01");

    const without = await c.handshake(
      ctx(async () => rpcResult({ structuredContent: { tools: [{ name: "other" }] } })),
      REQ,
    );
    expect(without.grantedCapabilities).toEqual(["feed.read"]);
    expect(without.declined).toEqual([{ capability: "post.draft", reason: "not_advertised" }]);
    // absent structuredContent/agent fields → derived instance id + manifest name + revision default
    expect(without.agentInstanceId).toBe("test-mcp:22222222");
    expect(without.agentDisplayName).toBe("Test MCP");
    expect(without.remoteProtocolVersion).toBe("2026-07-28");
  });

  it("treats absent structuredContent as no tools", async () => {
    const c = makeMcpHttpConnector(INIT);
    const res = await c.handshake(
      ctx(async () => rpcResult({ resultType: "complete" })),
      REQ,
    );
    expect(res.grantedCapabilities).toEqual(["feed.read"]);
  });
});

describe("health", () => {
  it("reports ok/failed latency, and detail on throw (Error and non-Error)", async () => {
    const c = makeMcpHttpConnector(INIT);
    expect((await c.health(ctx(async () => new Response("ok")))).ok).toBe(true);
    expect((await c.health(ctx(async () => new Response("no", { status: 503 })))).ok).toBe(false);
    const thrown = await c.health(ctx(async () => Promise.reject(new Error("boom"))));
    expect(thrown.ok).toBe(false);
    expect(thrown.detail).toBe("boom");
    const odd = await c.health(ctx(async () => Promise.reject(42 as never)));
    expect(odd.detail).toBe("unknown");
  });
});

describe("draftPost", () => {
  const good = {
    resultType: "complete",
    structuredContent: {
      text: "hi",
      costAtomic: "7",
      hashtags: ["a"],
      modelUsed: "m",
      remoteTraceId: "t",
    },
  };

  it("throws on tool isError, input_required (audited), and invalid payloads", async () => {
    const c = makeMcpHttpConnector(INIT);
    await expect(
      c.draftPost!(
        ctx(async () => rpcResult({ resultType: "complete", isError: true })),
        DRAFT_REQ,
      ),
    ).rejects.toThrow("mcp_tool_error");

    const audits: Record<string, unknown>[] = [];
    await expect(
      c.draftPost!(
        ctx(async () => rpcResult({ resultType: "input_required" }), audits),
        DRAFT_REQ,
      ),
    ).rejects.toThrow("input_required_declined");
    expect(audits).toHaveLength(1);

    await expect(
      c.draftPost!(
        ctx(async () =>
          rpcResult({ resultType: "complete", structuredContent: { costAtomic: "x" } }),
        ),
        DRAFT_REQ,
      ),
    ).rejects.toThrow("mcp_draft_invalid");
  });

  it("returns the complete draft coerced to bigint", async () => {
    const c = makeMcpHttpConnector(INIT);
    const out = await c.draftPost!(
      ctx(async () => rpcResult(good)),
      DRAFT_REQ,
    );
    expect(out.kind).toBe("complete");
    if (out.kind === "complete") {
      expect(out.draft.text).toBe("hi");
      expect(out.draft.costAtomic).toBe(7n);
      expect(out.draft.hashtags).toEqual(["a"]);
    }
    const numCost = await c.draftPost!(
      ctx(async () =>
        rpcResult({
          resultType: "complete",
          structuredContent: { ...good.structuredContent, costAtomic: 3 },
        }),
      ),
      DRAFT_REQ,
    );
    expect(numCost.kind === "complete" && numCost.draft.costAtomic).toBe(3n);
  });
});

describe("revoke", () => {
  it("swallows -32601 (verb not implemented) and rethrows anything else", async () => {
    const c = makeMcpHttpConnector(INIT);
    await expect(
      c.revoke(ctx(async () => rpcError(-32601, "not implemented"))),
    ).resolves.toBeUndefined();
    await expect(c.revoke(ctx(async () => rpcError(-32000, "other")))).rejects.toThrow("-32000");
  });
});
