// apps/worker/src/consumers/agent-cancel.ts — §10.7.5's cooperative cancel:
// revoke_delegation wrote one outbox row per cancelled 'held' reservation in
// the same statement as the revocation; this consumer resolves the adapter
// and asks the far side to stop — payload ids only, the rest is re-loaded.
import {
  resolveAdapter,
  makeGuardedFetch,
  hostsOf,
  type ConnectorManifest,
} from "@musebook/connectors";
import { pgFresh } from "../db.js";
import { audit } from "../lib/audit.js";

export interface AgentCancelPayload {
  reservation_id?: string;
  delegation_id?: string;
  external_kind?: string;
  external_ref?: string;
}

/** Idempotent: a redelivered message re-runs revoke() on the same reservation,
 *  which adapters define as a no-op. */
export async function runAgentCancel(env: Env, payload: Record<string, unknown>): Promise<void> {
  const p = payload as AgentCancelPayload;
  if (!p.reservation_id) return;

  const db = await pgFresh(env);
  try {
    const { rows } = await db.query<{
      reservation_id: string;
      delegation_id: string;
      owner_user_id: string;
      agent_identity_id: string;
      scopes: string[];
      external_kind: string | null;
      external_ref: string | null;
      connector_id: string;
      connector_slug: string;
      transport: string;
      auth_kind: string;
      manifest: ConnectorManifest;
    }>("select * from app.cancel_context_for($1::uuid)", [p.reservation_id]);
    const ctx = rows[0];
    if (!ctx) return; // reservation vanished — nothing to cancel

    const transport =
      ctx.manifest.transports.find((t) => t.kind === ctx.transport) ?? ctx.manifest.transports[0];
    if (!transport) return;

    const adapter = resolveAdapter({
      manifest: ctx.manifest,
      connectorRowId: ctx.connector_id,
      transport,
      credential: null, // a dead delegation's credential is never decrypted
    });
    await adapter.revoke({
      delegationId: ctx.delegation_id,
      ownerUserId: ctx.owner_user_id,
      agentIdentityId: ctx.agent_identity_id,
      scopes: ctx.scopes,
      remainingAtomic: 0n,
      fetch: makeGuardedFetch({
        allowHosts: hostsOf(ctx.manifest),
        totalTimeoutMs: Number(env.CONNECTOR_EGRESS_TIMEOUT_MS ?? 60_000),
        maxBytes: Number(env.CONNECTOR_EGRESS_MAX_BYTES ?? 8_388_608),
      }),
      audit: async () => {},
      requestId: `cancel:${ctx.reservation_id}`,
      signal: AbortSignal.timeout(15_000),
    });

    await audit(env, {
      action: "agent.cancel_completed",
      delegation_id: ctx.delegation_id,
      target_kind: "reservation",
      target_id: ctx.reservation_id,
      after_state: {
        external_kind: ctx.external_kind,
        external_ref: ctx.external_ref,
      },
    });
  } finally {
    await db.end();
  }
}
