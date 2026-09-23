// packages/connectors/src/connector.ts — §10.3 verbatim
import type { ConnectorManifest } from "./manifest.js";
import type { Capability } from "./capabilities.js";

export interface ConnectorContext {
  /** delegations.id — the unit of authorization. Never a user id, never an agent id. */
  delegationId: string;
  /** users.id — the human the agent acts FOR (the `sub` claim in §5.7.2). */
  ownerUserId: string;
  /** agent_identities.id — the agent that acts (the `act.sub` claim). */
  agentIdentityId: string;
  scopes: readonly string[];
  /** USDC atomic units still available in the current spend window. */
  remainingAtomic: bigint;
  /**
   * Allowlisted, HTTPS-only, non-redirecting, RFC 9421-SIGNED fetch (10.8.2, 10.8.4).
   * Never globalThis.fetch. In a Worker it counts against the 1,000-subrequest ceiling
   * and, far more tightly, against the 6 SIMULTANEOUS OPEN CONNECTIONS one invocation
   * may hold (CF-SPINE §4) — which is what bounds the drafter's fan-out, not CPU.
   */
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  /** Writes one audit_log row. packages/connectors/src/audit.ts in a Worker,
   *  apps/web/lib/audit.ts on Vercel — one signature, two transports (§5.7.7). */
  audit: (action: string, meta?: Record<string, unknown>) => Promise<void>;
  /** cf-ray in a Worker (§7.13); the Vercel request id on the one Node call site. */
  requestId: string;
  signal: AbortSignal;
}

export interface HandshakeRequest {
  musebookProtocolVersion: "2026-09-01";
  requestedCapabilities: readonly Capability[];
  ownerUserId: string;
  /** Where the agent posts BACK to. §7's server, on its own Worker. */
  callbackMcpUrl: "https://mcp.musebook.dev/mcp";
  locale: string;
}

export interface HandshakeResult {
  ok: boolean;
  /** Opaque, stable per (connector, owner). Becomes agent_identities.slug's suffix. */
  agentInstanceId: string;
  agentDisplayName: string;
  agentAvatarUrl?: string | undefined;
  grantedCapabilities: Capability[];
  declined: { capability: Capability; reason: string }[];
  /** What the far side says it speaks; logged, never trusted for authorization. */
  remoteProtocolVersion?: string | undefined;
  models?: string[] | undefined;
}

export interface DraftRequest {
  intent: string;
  /** platforms.slug values from §4.12; the distributor reformats, not the agent. */
  targetPlatforms: string[];
  maxLengthChars: number;
  tone?: string | undefined;
  referenceUrls?: string[] | undefined;
  /** Opaque to the connector. The bridge echoes it back on collect; a synchronous
   *  transport ignores it. Derived from (schedule, firing) — see 10.15.3. */
  taskId: string;
}

export interface DraftResult {
  /** UNTRUSTED. Passes through sanitizeAgentText() before it touches the database. */
  text: string;
  hashtags: string[];
  modelUsed?: string | undefined;
  costAtomic: bigint;
  remoteTraceId?: string | undefined;
}

/**
 * THE SUBMIT-AND-COLLECT SPLIT. A Queue consumer and a Cron Trigger are both capped
 * at 15 MINUTES OF WALL CLOCK, not configurable (CF-SPINE §3). A transport whose far
 * side is a process on a user's laptop that may be asleep cannot be awaited inside
 * that budget and must not try. So draftPost returns one of two shapes and the caller
 * in 10.15.3 branches exactly once.
 */
export type DraftOutcome =
  | { kind: "complete"; draft: DraftResult }
  /** The work is now owed by the far side. `handle` is what the collect path matches
   *  on; for the bridge it is the taskId. See 10.6.6. */
  | { kind: "submitted"; handle: string; expectedWithinMs: number };

export interface HealthResult {
  ok: boolean;
  latencyMs: number;
  detail?: string | undefined;
}

export interface AgentConnector {
  readonly manifest: ConnectorManifest;
  /** connectors.id in musebook-prod. One row per (connectorId, transport). */
  readonly connectorRowId: string;
  readonly transport: ConnectorManifest["transports"][number]["kind"];

  handshake(ctx: ConnectorContext, req: HandshakeRequest): Promise<HandshakeResult>;
  health(ctx: ConnectorContext): Promise<HealthResult>;
  /**
   * REQUIRED for every connector whose manifest declares the `post` capability
   * (`post.draft`). Structurally optional only so a read-only connector (feed.read,
   * analytics.read) is expressible; the registry refuses to resolve an adapter that
   * declares post.draft and lacks the method (below), and §17.10's contract suite
   * asserts the same. Called by the scheduled drafter, 10.15.
   */
  draftPost?(ctx: ConnectorContext, req: DraftRequest): Promise<DraftOutcome>;
  /** Idempotent. Called by the agent_cancel queue consumer (10.7.5). */
  revoke(ctx: ConnectorContext): Promise<void>;
}
