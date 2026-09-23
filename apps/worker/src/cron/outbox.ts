// apps/worker/src/cron/outbox.ts — §4.13.2's sweep, on `* * * * *`. Reads the
// unsent rows over job_outbox_pending_idx on HYPERDRIVE_FRESH — the cached
// binding would re-read a stale `queued` set and re-enqueue it forever — and
// sendBatches them. ~60 s recovery on a path that essentially never fires.
import { pgFresh } from "../db.js";

const QUEUE_FOR: Readonly<Record<string, (env: Env) => Queue>> = {
  classify: (env) => env.Q_CLASSIFY,
  embed: (env) => env.Q_EMBED,
  distribute: (env) => env.Q_DISTRIBUTE,
  media: (env) => env.Q_MEDIA,
  media_finalize: (env) => env.Q_MEDIA_FINALIZE,
  agent_cancel: (env) => env.Q_AGENT_CANCEL,
  dsar: (env) => env.Q_DSAR,
};

/** sendBatch caps at 100 messages OR 256 KB, whichever comes first — the
 *  chunk is the platform ceiling, never a preference. MAX_PER_TICK is the
 *  30-second CPU budget of a <1 h cron: sweep in pages, not one read. */
const BATCH_MAX = 100;
const MAX_PER_TICK = 500;

export async function sweepOutbox(env: Env, ctx: ExecutionContext): Promise<void> {
  const db = await pgFresh(env);
  try {
    const { rows } = await db.query<{
      id: number;
      kind: string;
      dedupe_key: string;
      payload: Record<string, unknown>;
    }>("select * from app.sweep_outbox($1)", [MAX_PER_TICK]);

    const sentIds: number[] = [];
    for (const [kind, group] of groupBy(rows, (r) => r.kind)) {
      const queue = QUEUE_FOR[kind]?.(env);
      if (queue === undefined) continue;
      for (const chunk of chunks(group, BATCH_MAX)) {
        // Row ids only — never a payload inline. The consumer reads the row.
        await queue
          // int8 comes back BigInt — Number() before the JSON body, or
          // sendBatch's own serialization throws and the sweep silently stalls.
          .sendBatch(chunk.map((r) => ({ body: { job_id: Number(r.id) } })))
          .then(() => sentIds.push(...chunk.map((r) => r.id)))
          .catch(() => {
            // A failed send is the entire reason this sweep exists: the row stays
            // `queued` (unmarked) and the next tick retries it.
          });
      }
    }
    if (sentIds.length > 0) {
      await db.query("select app.mark_outbox_enqueued($1::bigint[])", [sentIds]);
    }
    void ctx;
  } finally {
    await db.end();
  }
}

function groupBy<T>(rows: T[], key: (r: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    const g = out.get(k) ?? [];
    g.push(r);
    out.set(k, g);
  }
  return out;
}

function chunks<T>(rows: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}
