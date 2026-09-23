// apps/worker/src/lib/audit.ts — the Worker's audit() entry: §5.7.7's one
// signature behind app.audit_log_insert (jobs plane, one plpgsql call per
// row). Fails OPEN: a telemetry write never breaks the job it describes —
// callers either await it between steps or hand it to ctx.waitUntil.
import { audit as writeAudit, type AuditRecord } from "@musebook/connectors";
import { pgFresh } from "../db.js";

export type { AuditRecord };

/** Writes one audit_log row as musebook_jobs. Never throws. */
export async function audit(
  env: Env,
  rec: Omit<AuditRecord, "actor"> & { actor?: AuditRecord["actor"] },
): Promise<void> {
  try {
    const db = await pgFresh(env);
    try {
      await writeAudit(db, { actor: "owner_agent", ...rec });
    } finally {
      await db.end();
    }
  } catch (e) {
    console.warn("audit_write_failed", e instanceof Error ? e.message : String(e));
  }
}
