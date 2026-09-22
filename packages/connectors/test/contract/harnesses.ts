// packages/connectors/test/contract/harnesses.ts — one stubRemote() for both
// tiers: Node vitest and cloudflareTest() alike get a fetch interceptor that
// can answer, 500, or hang, plus the seeded ctx/handshakeRequest.
import { vi } from "vitest";
import { ADAPTERS } from "../../src/adapters/index.js";
import { ConnectorManifestZ, type ConnectorManifest } from "../../src/manifest.js";
import { makeGuardedFetch } from "../../src/egress.js";
import { hostsOf } from "../../src/registry.js";
import type { ConnectorContext, HandshakeRequest } from "../../src/connector.js";
import type { ContractHarness } from "./suite.js";

export const SEED_DELEGATION_ID = "d1111111-1111-4111-8111-000000000001";
export const SEED_OWNER_ID = "d2222222-2222-4222-8222-000000000002";
export const SEED_AGENT_ID = "d3333333-3333-4333-8333-000000000003";
export const SEED_CREDENTIAL = "SEED_CONNECTOR_CREDENTIAL";

const STUB_TIMEOUT_MS = 4_000;

interface StubState {
  requests: number;
  broken: boolean;
  hanging: boolean;
}

export function manifestFor(
  transport: ConnectorManifest["transports"][number],
  capabilities: ConnectorManifest["capabilities"],
): ConnectorManifest {
  return ConnectorManifestZ.parse({
    manifestVersion: "2026-09-01",
    connectorId: `${transport.kind.replaceAll("_", "-")}-stub`,
    displayName: `Stub ${transport.kind}`,
    vendor: "Contract Suite",
    description: "Manifest fixture for the connector contract suite.",
    homepageUrl: "https://musebook.example/",
    iconUrl: "https://musebook.example/icon.png",
    supportEmail: "ops@musebook.example",
    transports: [transport],
    auth:
      transport.kind === "bridge_token"
        ? { kind: "bridge_token" }
        : transport.kind === "a2a_card"
          ? { kind: "none" }
          : { kind: "bearer" },
    capabilities,
    directions: ["inbound", "outbound"],
    limits: { requestsPerHour: 60, postsPerDay: 10, maxConcurrentJobs: 2 },
    spendDefaults: {
      perActionCapAtomic: "500000",
      windowCapAtomic: "5000000",
      windowHours: 24,
    },
    attribution: { badgeLabel: "Stub Agent", c2paGeneratorName: "stub-agent" },
    privacy: { trainsOnUserContent: false, dataRetentionDays: 30, subprocessors: [] },
    submittedBy: {
      walletAddress: "0x1111111111111111111111111111111111111111",
      signature: `0x${"ab".repeat(65)}`,
    },
  });
}

/** One fetch stub for both tiers. Routes by pathname of the allowlisted remote. */
export function stubRemote(
  manifest: ConnectorManifest,
  handlers: Record<string, () => Response | Promise<Response>>,
): { state: StubState; install(): void } {
  const state: StubState = { requests: 0, broken: false, hanging: false };
  const fetchImpl = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    state.requests += 1;
    if (state.hanging) {
      // Resolve never; only the caller's abort signal ends it.
      return new Promise<Response>((_resolve, reject) => {
        const sig = init?.signal;
        if (sig?.aborted) reject(new DOMException("AbortError", "AbortError"));
        sig?.addEventListener("abort", () => reject(new DOMException("AbortError", "AbortError")), {
          once: true,
        });
      });
    }
    if (state.broken) return new Response("down", { status: 500 });
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = new URL(url).pathname;
    const handler = handlers[path] ?? handlers["*"];
    if (!handler) return new Response(`no stub for ${path}`, { status: 404 });
    return handler();
  };
  return { state, install: () => vi.stubGlobal("fetch", fetchImpl) };
}

function ctxFor(manifest: ConnectorManifest): ConnectorContext {
  return {
    delegationId: SEED_DELEGATION_ID,
    ownerUserId: SEED_OWNER_ID,
    agentIdentityId: SEED_AGENT_ID,
    scopes: ["feed:read", "post:write"],
    remainingAtomic: 10_000_000n,
    fetch: makeGuardedFetch({
      allowHosts: hostsOf(manifest),
      totalTimeoutMs: STUB_TIMEOUT_MS,
    }),
    audit: async () => {},
    requestId: "contract-req-1",
    signal: new AbortController().signal,
  };
}

function handshakeRequestFor(manifest: ConnectorManifest): HandshakeRequest {
  return {
    musebookProtocolVersion: "2026-09-01",
    requestedCapabilities: manifest.capabilities,
    ownerUserId: SEED_OWNER_ID,
    callbackMcpUrl: "https://mcp.musebook.dev/mcp",
    locale: "en-US",
  };
}

function harnessFor(
  kind: ConnectorManifest["transports"][number]["kind"],
  transport: ConnectorManifest["transports"][number],
  capabilities: ConnectorManifest["capabilities"],
  handlers: Record<string, () => Response | Promise<Response>>,
  hasRemote = true,
): ContractHarness {
  const manifest = manifestFor(transport, capabilities);
  const stub = stubRemote(manifest, handlers);
  return {
    name: kind,
    manifest,
    hasRemote,
    make: (m = manifest) => {
      // The global fetch stub is shared by every harness in the file; the last
      // make() wins, which is correct — tests exercise one adapter at a time.
      stub.install();
      return ADAPTERS[kind]({
        manifest: m,
        connectorRowId: "crow-contract-1",
        transport: m.transports.find((t) => t.kind === kind) as typeof transport,
        credential: m.auth.kind === "none" || m.auth.kind === "bridge_token" ? null : SEED_CREDENTIAL,
      });
    },
    ctx: () => ctxFor(manifest),
    handshakeRequest: () => handshakeRequestFor(manifest),
    breakRemote: () => {
      stub.state.broken = true;
    },
    hangRemote: () => {
      stub.state.hanging = true;
    },
    requestCount: () => stub.state.requests,
    resetRemote: () => {
      stub.state.broken = false;
      stub.state.hanging = false;
      stub.state.requests = 0;
    },
  };
}

const JSON_HEADERS = { "content-type": "application/json" };
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: JSON_HEADERS });
const rpc = (result: unknown) => json({ jsonrpc: "2.0", id: "mb-contract-req-1", result });

// -- mcp_http -----------------------------------------------------------------
// discover → tools with draft_post; any call gets a complete result.
const mcpDiscover = () =>
  rpc({
    resultType: "complete",
    structuredContent: {
      tools: [{ name: "draft_post" }, { name: "feed_read" }],
      agentInstanceId: "mcp-stub-1",
      agentDisplayName: "Stub MCP Agent",
      protocolVersion: "2026-07-28",
    },
  });
export const mcpHttpHarness = harnessFor(
  "mcp_http",
  { kind: "mcp_http", url: "https://mcp.example/mcp" },
  ["post.draft", "feed.read"],
  { "*": () => mcpDiscover() },
);

// -- a2a_card -----------------------------------------------------------------
export const a2aHarness = harnessFor(
  "a2a_card",
  { kind: "a2a_card", agentCardUrl: "https://a2a.example/.well-known/agent-card.json" },
  ["feed.read"],
  {
    "/.well-known/agent-card.json": () =>
      json({
        name: "Stub A2A Agent",
        description: "Contract fixture card",
        url: "https://a2a.example/",
        version: "0.3.0",
        skills: [{ id: "feed.read", name: "Feed read" }],
      }),
  },
);

// -- http_openapi --------------------------------------------------------------
export const openApiHarness = harnessFor(
  "http_openapi",
  { kind: "http_openapi", baseUrl: "https://openapi.example" },
  ["post.draft", "feed.read"],
  {
    "/musebook/handshake": () =>
      json({
        ok: true,
        agentInstanceId: "openapi-stub-1",
        agentDisplayName: "Stub OpenAPI Agent",
        grantedCapabilities: ["post.draft", "feed.read"],
        declined: [],
      }),
    "/musebook/health": () => json({ ok: true }),
    "/musebook/draft": () =>
      json({
        text: "untrusted <img src=x onerror=alert(1)> draft body",
        hashtags: ["stub"],
        modelUsed: "stub-1",
        costAtomic: "12500",
      }),
    "/musebook/revoke": () => new Response(null, { status: 204 }),
  },
);

// -- bridge_token --------------------------------------------------------------
export const bridgeHarness = harnessFor(
  "bridge_token",
  { kind: "bridge_token", runtime: "generic", minBridgeVersion: "1.0.0" },
  ["post.draft", "feed.read"],
  {},
  false,
);
