// apps/edge/src/telemetry/salt.ts — §13.9.2 verbatim.
import { pgFresh } from "../db/client.js"; // pg client over HYPERDRIVE_FRESH

let cached: { day: string; salt: Buffer } | null = null; // per isolate

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function getDailySalt(env: Env): Promise<Buffer> {
  const day = utcDay();
  if (cached !== null && cached.day === day) return cached.salt;
  // FRESH, always: this is a write and a read-after-write across isolates, and
  // the cached binding would serve a 60-second-stale answer at the one moment
  // that matters — the first request after midnight UTC.
  const db = pgFresh(env);
  try {
    const rows = await db.query<{ salt: Buffer }>(
      `insert into public.telemetry_salts (day) values ($1::date)
       on conflict (day) do update set day = excluded.day
       returning salt`,
      [day],
    );
    const row = rows.rows[0];
    if (row === undefined) throw new Error("telemetry_salts returned no salt row");
    cached = { day, salt: row.salt };
    return cached.salt;
  } finally {
    await db.end().catch(() => undefined);
  }
}
