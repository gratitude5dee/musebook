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
import { pgFresh, pgFreshJobs } from "../db.js";
import { audit } from "../lib/audit.js";
import {
  backendByName,
  createBackends,
  type BackendName,
  type GenerateJobRef,
} from "@musebook/media";
import { mediaModelStore } from "./media.js";
import { providerUrlsFor } from "./media-finalize.js";

export interface AgentCancelPayload {
  reservation_id?: string;
  delegation_id?: string;
  external_kind?: string;
  /** media_job cancel path — the media_jobs row id (§10.7.5 payload). */
  external_ref?: string;
  /** Legacy alias for external_ref on older queued messages. */
  media_job_id?: string;
}

/** §11.7.7's cooperative cancel for in-flight generations: best-effort provider
 *  cancel (false when already finished — harmless), then fail_media_job's
 *  'cancelled' transition which releases the reservation. */
async function cancelMediaJob(env: Env, mediaJobId: string): Promise<void> {
  const db = await pgFreshJobs(env);
  try {
    const { rows } = await db.query<{
      id: string;
      backend: string | null;
      model_id: string | null;
      provider_request_id: string | null;
      status: string;
      estimated_cost_atomic: string;
    }>("select * from media_jobs where id = $1::uuid", [mediaJobId]);
    const job = rows[0];
    if (job === undefined) return;
    if (
      job.status !== "cancelled" &&
      job.backend !== null &&
      job.model_id !== null &&
      job.provider_request_id !== null
    ) {
      const store = mediaModelStore(db);
      const backend = backendByName(createBackends(env, store), job.backend);
      if (backend !== null) {
        const urls = providerUrlsFor(job.backend, job.model_id, job.provider_request_id);
        const ref: GenerateJobRef = {
          jobId: job.id,
          backend: job.backend as BackendName,
          modelId: job.model_id,
          providerRequestId: job.provider_request_id,
          estimatedCostAtomic: job.estimated_cost_atomic,
          statusUrl: urls.statusUrl,
          cancelUrl: urls.cancelUrl,
          resultUrl: urls.resultUrl,
        };
        await backend.cancel(ref).catch(() => false); // provider cancel is best-effort
      }
    }
    await db.query(
      "select * from public.fail_media_job($1::uuid, 'cancelled'::media_job_status, 'cancelled_by_owner')",
      [mediaJobId],
    );
  } finally {
    await db.end().catch(() => undefined);
  }
}

/** Idempotent: a redelivered message re-runs revoke() on the same reservation,
 *  which adapters define as a no-op. */
export async function runAgentCancel(env: Env, payload: Record<string, unknown>): Promise<void> {
  const p = payload as AgentCancelPayload;
  if (p.external_kind === "media_job") {
    const id = typeof p.external_ref === "string" ? p.external_ref : p.media_job_id;
    if (typeof id === "string") await cancelMediaJob(env, id);
    return;
  }
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
