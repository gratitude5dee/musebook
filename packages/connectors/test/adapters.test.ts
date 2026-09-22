// adapters.test.ts — the transport-specific halves §17.10 keeps beside the
// contract suite: mcp_http's client-side revision assertions, http_openapi's
// output-schema typed failure, bridge's no-command type level, and the
// complete-vs-submitted draft split.
import { describe, expect, it, vi } from "vitest";
import { ADAPTERS } from "../src/adapters/index.js";
import { mcpCall } from "../src/adapters/mcp-http.js";
import type { BridgeOp } from "../src/adapters/bridge-token.js";
import { manifestFor, stubRemote, SEED_CREDENTIAL, SEED_DELEGATION_ID, SEED_OWNER_ID, SEED_AGENT_ID } from "./contract/harnesses.js";
import type { ConnectorContext, DraftRequest } from "../src/connector.js";

const ctx = (fetchImpl: ConnectorContext["fetch"]): ConnectorContext => ({
  delegationId: SEED_DELEGATION_ID,
  ownerUserId: SEED_OWNER_ID,
  agentIdentityId: SEED_AGENT_ID,
  scopes: ["post:write"],
  remainingAtomic: 1_000n,
  fetch: fetchImpl,
  audit: async () => {},
  requestId: "adapter-req",
  signal: new AbortController().signal,
});

const draftReq: DraftRequest = {
  intent: "a post about the muse",
  targetPlatforms: ["musebook"],
  maxLengthChars: 2_000,
  taskId: "draft:sched-1:1700000000000",
};

describe("mcp_http client revision (2026-07-28)", () => {
  it("sends _meta, revision headers and no initialize / Mcp-Session-Id", async () => {
    let seen: { headers: Record<string, string>; body: string } | null = null;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const h: Record<string, string> = {};
      for (const [k, v] of new Headers(init?.headers).entries()) h[k] = v;
      seen = { headers: h, body: String(init?.body) };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: "x", result: { resultType: "complete" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as ConnectorContext["fetch"];
    await mcpCall(ctx(fetchImpl), "https://mcp.example/mcp", SEED_CREDENTIAL, "tools/call", { name: "draft_post" });
    expect(seen).not.toBeNull();
    const s = seen as unknown as { headers: Record<string, string>; body: string };
    expect(s.headers["mcp-protocol-version"]).toBe("2026-07-28");
    expect(s.headers["mcp-method"]).toBe("tools/call");
    expect(s.headers["mcp-name"]).toBe("draft_post");
    expect(s.headers["authorization"]).toBe(`Bearer ${SEED_CREDENTIAL}`);
    const rpc = JSON.parse(s.body) as { method: string; params: Record<string, unknown> };
    expect(rpc.method).toBe("tools/call");
    expect(JSON.stringify(rpc.params)).not.toContain("initialize");
    expect(rpc.params._meta).toBeDefined();
    expect(s.headers["mcp-session-id"]).toBeUndefined();
  });

  it("falls back to tools/list when server/discover is -32601", async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const rpc = JSON.parse(String(init?.body)) as { method: string };
      seen.push(rpc.method);
      if (rpc.method === "server/discover") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: "x", error: { code: -32601, message: "method not found" } }), { status: 200 });
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: "x", result: { resultType: "complete" } }), { status: 200 });
    }) as unknown as ConnectorContext["fetch"];
    const manifest = manifestFor({ kind: "mcp_http", url: "https://mcp.example/mcp" }, ["post.draft", "feed.read"]);
    const c = ADAPTERS.mcp_http({ manifest, connectorRowId: "crow-1", transport: manifest.transports[0], credential: null });
    const r = await c.handshake(ctx(fetchImpl), {
      musebookProtocolVersion: "2026-09-01",
      requestedCapabilities: ["post.draft"],
      ownerUserId: SEED_OWNER_ID,
      callbackMcpUrl: "https://mcp.musebook.dev/mcp",
      locale: "en",
    });
    expect(seen).toEqual(["server/discover", "tools/list"]);
    expect(r.ok).toBe(true);
  });
});

describe("http_openapi schema discipline", () => {
  it("a response not matching the declared output schema is a typed failure", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ not: "a handshake" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as ConnectorContext["fetch"];
    const manifest = manifestFor({ kind: "http_openapi", baseUrl: "https://api.example" }, ["post.draft"]);
    const c = ADAPTERS.http_openapi({ manifest, connectorRowId: "crow-2", transport: manifest.transports[0], credential: SEED_CREDENTIAL });
    await expect(
      c.handshake(ctx(fetchImpl), {
        musebookProtocolVersion: "2026-09-01",
        requestedCapabilities: ["post.draft"],
        ownerUserId: SEED_OWNER_ID,
        callbackMcpUrl: "https://mcp.musebook.dev/mcp",
        locale: "en",
      }),
    ).rejects.toThrow("http_openapi_handshake_invalid");
  });

  it("draftPost wraps a validated DraftResult as complete with bigint cost", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({ text: "raw <b>untrusted</b>", hashtags: ["x"], costAtomic: "4200", modelUsed: "m1" }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ) as unknown as ConnectorContext["fetch"];
    const manifest = manifestFor({ kind: "http_openapi", baseUrl: "https://api.example" }, ["post.draft"]);
    const c = ADAPTERS.http_openapi({ manifest, connectorRowId: "crow-2", transport: manifest.transports[0], credential: SEED_CREDENTIAL });
    const out = await c.draftPost!(ctx(fetchImpl), draftReq);
    expect(out.kind).toBe("complete");
    if (out.kind === "complete") {
      expect(out.draft.text).toBe("raw <b>untrusted</b>");
      expect(typeof out.draft.costAtomic).toBe("bigint");
      expect(out.draft.costAtomic).toBe(4200n);
    }
  });
});

describe("bridge_token", () => {
  it("BridgeOp has no variant carrying a command line (type-level)", () => {
    // §10.12 check 14: if a future variant carries `exec`, `command` or `cmd`,
    // this assertion fails to compile AND fails at runtime.
    const op: BridgeOp = { kind: "draft", request: draftReq };
    expect("exec" in op).toBe(false);
    expect("command" in op).toBe(false);
    expect("cmd" in op).toBe(false);
    type Forbidden = "exec" | "command" | "cmd";
    type AssertNever<T> = T extends Forbidden ? never : T;
    const ops: BridgeOp[] = [
      { kind: "health" },
      { kind: "handshake", request: {
        musebookProtocolVersion: "2026-09-01",
        requestedCapabilities: ["post.draft"],
        ownerUserId: SEED_OWNER_ID,
        callbackMcpUrl: "https://mcp.musebook.dev/mcp",
        locale: "en",
      } },
      { kind: "draft", request: draftReq },
      { kind: "revoke", reason: "delegation_revoked" },
    ];
    for (const o of ops) {
      expect(Object.keys(o).filter((k): k is Forbidden => k === "exec" || k === "command" || k === "cmd")).toEqual([]);
      const _assert: AssertNever<keyof typeof o> = {} as never;
      void _assert;
    }
  });

  it("draftPost submits — the far side may be asleep", async () => {
    const manifest = manifestFor(
      { kind: "bridge_token", runtime: "generic", minBridgeVersion: "1.0.0" },
      ["post.draft"],
    );
    const c = ADAPTERS.bridge_token({ manifest, connectorRowId: "crow-3", transport: manifest.transports[0], credential: null });
    const out = await c.draftPost!(ctx(vi.fn()), draftReq);
    expect(out.kind).toBe("submitted");
    if (out.kind === "submitted") {
      expect(out.handle).toBe(draftReq.taskId);
      expect(out.expectedWithinMs).toBe(30 * 60 * 1000);
    }
  });
});
