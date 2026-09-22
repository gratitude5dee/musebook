// packages/connectors/src/audit.ts — §5.7.7, the Worker half of the one
// audit() signature (apps/web/lib/audit.ts is the Vercel half). audit_log is a
// jobs-plane table: a Worker writes it as musebook_jobs via app.enter, through
// the same per-statement plane switch the rest of the file uses.
import type { Actor } from "@musebook/schema";
import type { Client } from "pg";

export type AuditRecord = {
  actor: Actor["class"];
  actor_user_id?: string | null;
  actor_agent_id?: string | null;
  delegation_id?: string | null;
  action: string; // 'post.publish', 'delegation.revoke', 'x402.settle'
  target_kind?: string | null; // 'post' | 'delegation' | 'channel' | 'grant'
  target_id?: string | null;
  before_state?: unknown;
  after_state?: unknown;
  request_id?: string | null;
  ip_hash?: string | null; // sha256(x-mb-client-ip) — NEVER x-forwarded-for
};

export const auditFromActor = (
  a: Actor,
): Pick<
  AuditRecord,
  "actor" | "actor_user_id" | "actor_agent_id" | "delegation_id" | "request_id"
> => ({
  actor: a.class,
  actor_user_id: "userId" in a ? (a.userId ?? null) : null,
  actor_agent_id:
    a.class === "owner_agent"
      ? a.agentIdentityId
      : a.class === "crawler_agent"
        ? a.agentIdentityId
        : null,
  delegation_id: a.class === "owner_agent" ? a.delegationId : null,
  request_id: a.requestId,
});

/**
 * Fails open and never blocks the response: the caller wraps this in
 * `ctx.waitUntil(audit(...).catch(warn))` — the insert is issued, the response
 * is returned, and a failure is logged and dropped. app.audit_log_insert is the
 * jobs-plane plpgsql entry point for exactly one row (§4.13's "one plpgsql call").
 */
export async function audit(fresh: Client, rec: AuditRecord): Promise<void> {
  await fresh.query(`select app.audit_log_insert($1::jsonb)`, [JSON.stringify(rec)]);
}
