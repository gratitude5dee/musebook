// @musebook/connectors — §10.2 public surface: registry + resolveAdapter,
// plus §5.7.5's scope/budget gate and §5.7.7's audit writer.
export {
  requireAgentScope,
  QUARANTINE_ALLOWED,
  type AgentGate,
  type OwnerAgent,
  type SpendPurpose,
  type SpendRequest,
} from "./require-agent-scope.js";
export { audit, auditFromActor, type AuditRecord } from "./audit.js";

export {
  CAPABILITIES,
  CAPABILITY_SCOPES,
  scopesForCapabilities,
  type Capability,
} from "./capabilities.js";
export {
  ConnectorManifestZ,
  TransportZ,
  AuthZ,
  CapabilityZ,
  canonicalize,
  type ConnectorManifest,
} from "./manifest.js";
export type {
  AgentConnector,
  ConnectorContext,
  HandshakeRequest,
  HandshakeResult,
  HealthResult,
  DraftRequest,
  DraftResult,
  DraftOutcome,
} from "./connector.js";
export {
  ADAPTERS,
  type AdapterInit,
  type AdapterFactory,
  type TransportKind,
} from "./adapters/index.js";
export {
  resolveAdapter,
  parseManifest,
  manifestCanDraft,
  canTransition,
  hostsOf,
  DRAFT_CAPABLE_TRANSPORTS,
  type ManifestParseResult,
  type RegistryState,
} from "./registry.js";
export { makeGuardedFetch, type GuardOptions } from "./egress.js";
export { signOutbound, SIGNATURE_AGENT_ENTRY } from "./sign.js";
export type { JsonWebKey } from "./types.js";
export { sealCredential, openCredential } from "./crypto.js";
export { sanitizeAgentText, wrapUntrusted } from "./safety/untrusted.js";
export { nextReputation, type ReputationInputs } from "./safety/reputation.js";
export type { BridgeFrame, BridgeOp, BridgeErrorCode } from "./adapters/bridge-token.js";
export { BRIDGE_TASK_EXPECTED_MS } from "./adapters/bridge-token.js";
