// apps/edge/src/ops.ts — opsLog: one ops_events row on FRESH, via
// app.write_ops_event. FAILS OPEN unconditionally — a failed ops insert must
// never fail the request it describes (the DDL's own comment, §4.13.2).
// Callers put the returned promise in ctx.waitUntil.
import { fresh } from "./db/client.js";

export interface OpsEvent {
  component: string;
  event_name: string;
  level?: "debug" | "info" | "warn" | "error";
  outcome?: string | undefined;
  request_id?: string | undefined;
  subject_id?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export async function opsLog(env: Env, e: OpsEvent): Promise<void> {
  const db = fresh(env);
  try {
    await db.query("select app.write_ops_event($1,$2,$3,$4,$5,$6::uuid,$7::jsonb,$8::uuid)", [
      e.component,
      e.event_name,
      e.level ?? "info",
      e.outcome ?? null,
      e.request_id ?? null,
      e.subject_id ?? null,
      e.metadata ?? {},
      null,
    ]);
  } catch {
    // fails open — see header.
  } finally {
    await db.end().catch(() => undefined);
  }
}
