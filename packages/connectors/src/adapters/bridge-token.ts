// packages/connectors/src/adapters/bridge-token.ts — §10.6.3 + §10.6.6
// The submit-and-collect transport: draftPost never waits. The task record IS
// the agent_spend_reservations row the drain already wrote (external_kind =
// 'bridge_draft', external_ref = taskId); POST /api/bridge/poll delivers it as a
// `task` frame, POST /api/bridge/result collects it, and the 30-minute reaper
// releases the hold if the bytes never arrive.
import type {
  AgentConnector,
  DraftOutcome,
  DraftRequest,
  HandshakeRequest,
  HandshakeResult,
  HealthResult,
} from "../connector.js";
import type { AdapterInit } from "./index.js";

export type BridgeFrame =
  | { v: 1; type: "hello"; bridgeVersion: string; runtime: string; capabilities: string[] }
  | { v: 1; type: "idle" } // server -> bridge: nothing to do
  | { v: 1; type: "task"; taskId: string; deadlineMs: number; op: BridgeOp }
  | { v: 1; type: "result"; taskId: string; ok: true; payload: unknown }
  | { v: 1; type: "error"; taskId: string; ok: false; code: BridgeErrorCode; detail?: string }
  | { v: 1; type: "revoked"; reason: string };

export type BridgeOp =
  | { kind: "health" }
  | { kind: "handshake"; request: HandshakeRequest }
  | { kind: "draft"; request: DraftRequest }
  | { kind: "revoke"; reason: string };

export type BridgeErrorCode =
  | "runtime_not_found"
  | "runtime_timeout"
  | "runtime_error"
  | "unsupported_op"
  | "output_too_large";

/** 10.6.6: a submitted bridge draft has 30 minutes before the reaper releases it. */
export const BRIDGE_TASK_EXPECTED_MS = 30 * 60 * 1000;

export function makeBridgeConnector(init: AdapterInit): AgentConnector {
  if (init.transport.kind !== "bridge_token")
    throw new Error(`bridge_adapter_wrong_transport:${init.transport.kind}`);

  return {
    manifest: init.manifest,
    connectorRowId: init.connectorRowId,
    transport: "bridge_token",

    handshake(ctx, req: HandshakeRequest): Promise<HandshakeResult> {
      // A bridge's hello IS its remote handshake — the poll route answers it.
      // What the adapter can synchronously establish is the local half: the
      // grant is the manifest's declared capabilities intersected with what the
      // delegation asked for, and proof of the far side arrives on first poll.
      const granted = req.requestedCapabilities.filter((c) =>
        init.manifest.capabilities.includes(c),
      );
      const declined = req.requestedCapabilities
        .filter((c) => !granted.includes(c))
        .map((capability) => ({ capability, reason: "not_in_manifest" }));
      return Promise.resolve({
        ok: true,
        agentInstanceId: `${init.manifest.connectorId}:${ctx.delegationId.slice(0, 8)}`,
        agentDisplayName: init.manifest.displayName,
        grantedCapabilities: granted,
        declined,
        remoteProtocolVersion: "bridge/1",
      });
    },

    health(): Promise<HealthResult> {
      // Liveness is observed from hello frames in audit_log, never probed.
      return Promise.resolve({ ok: true, latencyMs: 0, detail: "bridge_deferred" });
    },

    draftPost(_ctx, req: DraftRequest): Promise<DraftOutcome> {
      // Never awaits: the reservation row with external_ref = req.taskId is the
      // task. The next poll frame delivers it; the result route completes it.
      return Promise.resolve({
        kind: "submitted",
        handle: req.taskId,
        expectedWithinMs: BRIDGE_TASK_EXPECTED_MS,
      });
    },

    revoke(): Promise<void> {
      // The revoked frame goes out on the bridge's next poll; the DB half
      // (cancelled reservations, rejected approvals) already happened in
      // revoke_delegation's single statement.
      return Promise.resolve();
    },
  };
}
