// apps/web/lib/audit.ts — §5.7.7, the Vercel half of the one audit() signature
// (packages/connectors/src/audit.ts is the Worker half). Same record shape,
// different transport: PostgREST with the service key, which bypasses RLS for
// this cold write path. Fails open: the request it describes must never fail
// because the log is down.
import { serviceDb } from "@/lib/db/service";

export type AuditRecord = {
  actor: "human_creator" | "human_reader" | "owner_agent" | "crawler_agent" | "system";
  actor_user_id?: string | null;
  actor_agent_id?: string | null;
  delegation_id?: string | null;
  action: string;
  target_kind?: string | null;
  target_id?: string | null;
  before_state?: unknown;
  after_state?: unknown;
  request_id?: string | null;
  ip_hash?: string | null;
};

export async function audit(rec: AuditRecord): Promise<void> {
  try {
    const { error } = await serviceDb.from("audit_log").insert({
      actor: rec.actor,
      actor_user_id: rec.actor_user_id ?? null,
      actor_agent_id: rec.actor_agent_id ?? null,
      delegation_id: rec.delegation_id ?? null,
      action: rec.action,
      target_kind: rec.target_kind ?? null,
      target_id: rec.target_id ?? null,
      before_state: rec.before_state === undefined ? null : (rec.before_state as object),
      after_state: rec.after_state === undefined ? null : (rec.after_state as object),
      request_id: rec.request_id ?? null,
      ip_hash: rec.ip_hash ?? null,
    });
    if (error) console.error("audit_write_failed", rec.action, error.message);
  } catch (e) {
    console.error("audit_write_failed", rec.action, String(e));
  }
}
