// packages/connectors/src/manifest.ts — §10.4.1 verbatim
import { z } from "zod";
import { CAPABILITIES } from "./capabilities.js";

export const CapabilityZ = z.enum(CAPABILITIES);

export const TransportZ = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("mcp_http"),
    url: z.url({ protocol: /^https$/ }),
    /** Informational. The adapter always sends MCP-Protocol-Version: 2026-07-28. */
    protocolVersion: z.string().max(32).optional(),
  }),
  z.object({
    kind: z.literal("a2a_card"),
    agentCardUrl: z.url({ protocol: /^https$/ }),
  }),
  z.object({
    kind: z.literal("http_openapi"),
    baseUrl: z.url({ protocol: /^https$/ }),
    openapiUrl: z.url({ protocol: /^https$/ }).optional(),
  }),
  z.object({
    kind: z.literal("bridge_token"),
    runtime: z.enum(["openclaw", "hermes", "codex-cli", "claude-code", "acp", "generic"]),
    /** Minimum @musebook/bridge version this runtime adapter needs. */
    minBridgeVersion: z
      .string()
      .regex(/^\d+\.\d+\.\d+$/)
      .default("1.0.0"),
  }),
]);

export const AuthZ = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("oauth2"),
    resource: z.url({ protocol: /^https$/ }),
    scopes: z.array(z.string().max(64)).max(32),
    authorizationServers: z
      .array(z.url({ protocol: /^https$/ }))
      .max(4)
      .optional(),
  }),
  z.object({
    kind: z.literal("bearer"),
    header: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9-]{0,40}$/)
      .default("Authorization"),
    valuePrefix: z.string().max(16).default("Bearer "),
  }),
  z.object({ kind: z.literal("bridge_token") }),
  z.object({ kind: z.literal("none") }),
]);

export const ConnectorManifestZ = z.strictObject({
  manifestVersion: z.literal("2026-09-01"),
  connectorId: z.string().regex(/^[a-z0-9][a-z0-9_-]{1,38}[a-z0-9]$/),
  displayName: z.string().min(2).max(60),
  vendor: z.string().min(2).max(80),
  description: z.string().min(20).max(400),
  homepageUrl: z.url({ protocol: /^https$/ }),
  docsUrl: z.url({ protocol: /^https$/ }).optional(),
  iconUrl: z.url({ protocol: /^https$/ }),
  supportEmail: z.email(),
  transports: z.array(TransportZ).min(1).max(4),
  auth: AuthZ,
  capabilities: z.array(CapabilityZ).min(1),
  directions: z.array(z.enum(["inbound", "outbound"])).min(1),
  /** Ceilings the connector asks for. The delegation's own numbers are the floor
   *  that is actually enforced; see 10.7.4. A manifest cannot raise a cap. */
  limits: z.object({
    requestsPerHour: z.int().min(1).max(10_000).default(60),
    postsPerDay: z.int().min(0).max(200).default(10),
    maxConcurrentJobs: z.int().min(1).max(20).default(2),
  }),
  /** Suggested defaults for the mint UI, in USDC atomic units (6 decimals). */
  spendDefaults: z.object({
    perActionCapAtomic: z
      .string()
      .regex(/^[0-9]{1,30}$/)
      .default("500000"),
    windowCapAtomic: z
      .string()
      .regex(/^[0-9]{1,30}$/)
      .default("5000000"),
    windowHours: z.int().min(1).max(720).default(24),
  }),
  attribution: z.object({
    badgeLabel: z.string().min(2).max(24),
    c2paGeneratorName: z.string().min(2).max(80),
  }),
  privacy: z.object({
    trainsOnUserContent: z.boolean(),
    dataRetentionDays: z.int().min(0).max(3650),
    subprocessors: z.array(z.string().max(80)).max(20).default([]),
  }),
  submittedBy: z.object({
    walletAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    /** viem verifyMessage over canonicalize(manifest-without-submittedBy.signature),
     *  checked once in apps/web at review time. Never at the edge: secp256k1 is not
     *  in workerd's WebCrypto (CF-SPINE §12). */
    signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
  }),
});

export type ConnectorManifest = z.infer<typeof ConnectorManifestZ>;

/** Deterministic bytes for signing and for the manifest hash. Keys sorted, no spaces. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
}
