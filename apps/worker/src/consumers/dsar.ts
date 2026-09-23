// apps/worker/src/consumers/dsar.ts — §15.11's consumer. Two kinds ride the
// musebook-dsar queue: 'export' collects the subject's rows into a zip on
// musebook-paid under dsar/{id}/export.zip (the 7-day lifecycle rule collects
// it, the edge download route streams it); 'delete' runs the eraser and
// writes the ops_events row that is §13.9.4's audit trail.
import { zipSync, strToU8 } from "fflate";
import type { DbClient } from "../db.js";

export interface DsarPayload {
  request_id?: string;
  kind?: string;
  user_id?: string;
}

export async function runDsar(
  db: DbClient,
  env: Env,
  payload: Record<string, unknown>,
): Promise<void> {
  const p = payload as DsarPayload;
  const requestId = typeof p.request_id === "string" ? p.request_id : null;
  if (requestId === null) throw new Error("dsar: payload.request_id missing");

  const { rows } = await db.query<{
    user_id: string | null;
    agent_id: string | null;
    kind: string;
    state: string;
  }>("select * from app.begin_dsar($1::uuid)", [requestId]);
  const req = rows[0];
  if (req === undefined || req.state === "completed" || req.state === "refused") {
    return; // redelivery after completion — nothing to do
  }
  const userId = req.user_id;

  if (req.kind === "export") {
    if (userId === null) {
      await db.query("select app.fail_dsar($1::uuid, 'no_user_subject')", [requestId]);
      return;
    }
    const doc = await db.query<{ collect_dsar_export: unknown }>(
      "select app.collect_dsar_export($1::uuid)",
      [userId],
    );
    const json = JSON.stringify(doc.rows[0]?.collect_dsar_export ?? {}, null, 2);
    // A single-entry zip — the artifact is a zip because §15.11 names it
    // export.zip, not because compression matters.
    const zip = zipSync({
      "musebook-export.json": strToU8(json),
      "README.txt": strToU8(
        "Musebook data export. musebook-export.json contains every row the " +
          "subject owns: identity, wallets, action events, posts, and prior " +
          "DSAR requests. This object expires 7 days after creation.\n",
      ),
    });
    const key = `dsar/${requestId}/export.zip`;
    await env.PAID_MEDIA.put(key, zip, {
      httpMetadata: { contentType: "application/zip" },
      customMetadata: { request_id: requestId, kind: "dsar_export" },
    });
    await db.query("select app.complete_dsar($1::uuid, $2, null)", [requestId, key]);
    return;
  }

  if (req.kind === "delete") {
    if (userId === null) {
      // Agent-subject erasure is a separate plane the eraser doesn't cover.
      await db.query("select app.fail_dsar($1::uuid, 'no_user_subject')", [requestId]);
      return;
    }
    // The eraser returns the per-table counts; the row it writes IS the audit
    // trail (§13.9.4: results land on ops_events, never the subject row).
    const { rows: erased } = await db.query<{ erase_user_subject: unknown }>(
      "select public.erase_user_subject($1::uuid)",
      [userId],
    );
    await db.query("select app.complete_dsar($1::uuid, null, $2)", [
      requestId,
      `deleted:${JSON.stringify(erased[0]?.erase_user_subject ?? {})}`,
    ]);
    return;
  }

  // 'objection' applies at request time on the edge — a queued objection is a
  // no-op beyond bookkeeping.
  await db.query("select app.complete_dsar($1::uuid, null, 'applied_at_request')", [requestId]);
}
