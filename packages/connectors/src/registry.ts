// packages/connectors/src/registry.ts — §10.3 + §10.4
// load/validate/review state machine. Third parties never ship code into
// Musebook: a manifest is data, resolveAdapter maps its transport kind to one
// of the four bundled adapters.
import { ADAPTERS, type AdapterInit, type TransportKind } from "./adapters/index.js";
import { ConnectorManifestZ, canonicalize, type ConnectorManifest } from "./manifest.js";
import type { AgentConnector } from "./connector.js";

export function resolveAdapter(init: AdapterInit): AgentConnector {
  const connector = ADAPTERS[init.transport.kind](init);
  if (
    init.manifest.capabilities.includes("post.draft") &&
    typeof connector.draftPost !== "function"
  ) {
    // A manifest that promises drafting on a transport that cannot draft is a
    // registry error, not a runtime surprise at 03:00 when the cron fires.
    throw new Error(
      `connector_missing_draftPost:${init.manifest.connectorId}:${init.transport.kind}`,
    );
  }
  return connector;
}

/** Transports that can carry a draftPost (10.4.4 auto-check 7). */
export const DRAFT_CAPABLE_TRANSPORTS = new Set<TransportKind>([
  "mcp_http",
  "http_openapi",
  "bridge_token",
]);

/**
 * §10.4.4 auto-check 7: a manifest declaring post.draft on an a2a_card-only
 * transport is a submission error. Pure — the route turns the false into a 422.
 */
export function manifestCanDraft(m: ConnectorManifest): boolean {
  return (
    !m.capabilities.includes("post.draft") ||
    m.transports.some((t) => DRAFT_CAPABLE_TRANSPORTS.has(t.kind))
  );
}

export type ManifestParseResult =
  | { ok: true; manifest: ConnectorManifest; canonical: string }
  | { ok: false; issues: string[] };

export function parseManifest(input: unknown): ManifestParseResult {
  const parsed = ConnectorManifestZ.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map(
        (i) => `${i.path.map(String).join(".")}: ${i.message}`,
      ),
    };
  }
  return { ok: true, manifest: parsed.data, canonical: canonicalize(parsed.data) };
}

/** The review state machine (10.4.4): what a transition may do and who may do it. */
export type RegistryState = "submitted" | "listed" | "verified" | "rejected" | "suspended";
const TRANSITIONS: Record<RegistryState, readonly RegistryState[]> = {
  submitted: ["listed", "rejected"],
  listed: ["verified", "suspended"],
  verified: ["suspended"],
  rejected: [],
  suspended: ["listed"],
};
export function canTransition(from: RegistryState, to: RegistryState): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Every host guardedFetch may reach for this manifest (10.8.2's allowlist). */
export function hostsOf(m: ConnectorManifest): string[] {
  const hosts = new Set<string>();
  const add = (u: string | undefined) => {
    if (!u) return;
    try {
      hosts.add(new URL(u).hostname.toLowerCase());
    } catch {
      // an unparsable URL can never be fetched; excluding it fails closed.
    }
  };
  for (const t of m.transports) {
    switch (t.kind) {
      case "mcp_http":
        add(t.url);
        break;
      case "a2a_card":
        add(t.agentCardUrl);
        break;
      case "http_openapi":
        add(t.baseUrl);
        add(t.openapiUrl);
        break;
      case "bridge_token":
        break;
    }
  }
  if (m.auth.kind === "oauth2") {
    add(m.auth.resource);
    for (const s of m.auth.authorizationServers ?? []) add(s);
  }
  add(m.iconUrl);
  add(m.homepageUrl);
  return [...hosts].sort();
}
