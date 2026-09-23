// packages/connectors/src/adapters/index.ts — §10.5 verbatim
import type { AgentConnector } from "../connector.js";
import type { ConnectorManifest } from "../manifest.js";
import { makeMcpHttpConnector } from "./mcp-http.js";
import { makeA2aConnector } from "./a2a-card.js";
import { makeHttpOpenApiConnector } from "./http-openapi.js";
import { makeBridgeConnector } from "./bridge-token.js";

export type TransportKind = ConnectorManifest["transports"][number]["kind"];

export interface AdapterInit {
  manifest: ConnectorManifest;
  connectorRowId: string;
  transport: ConnectorManifest["transports"][number];
  /** Decrypted, single-use, delegation-scoped. Null for auth.kind === 'none'. */
  credential: string | null;
}

export type AdapterFactory = (init: AdapterInit) => AgentConnector;

export const ADAPTERS: Record<TransportKind, AdapterFactory> = {
  mcp_http: (init) => makeMcpHttpConnector(init),
  a2a_card: (init) => makeA2aConnector(init),
  http_openapi: (init) => makeHttpOpenApiConnector(init),
  bridge_token: (init) => makeBridgeConnector(init),
};

export { makeMcpHttpConnector, mcpCall, discover } from "./mcp-http.js";
export { makeA2aConnector, AgentCardZ, type AgentCard } from "./a2a-card.js";
export { makeHttpOpenApiConnector } from "./http-openapi.js";
export {
  makeBridgeConnector,
  BRIDGE_TASK_EXPECTED_MS,
  type BridgeFrame,
  type BridgeOp,
  type BridgeErrorCode,
} from "./bridge-token.js";
