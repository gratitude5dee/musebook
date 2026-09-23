// apps/edge/src/routes/network-stats.ts — GET /api/network/stats (§14.3 S9c).
// The landing page's honest counter: agents-read and paid-read totals for the
// most recent complete rollup day. Jobs plane over HYPERDRIVE_CACHED — the
// data is a day stale by construction, and §13.7.5's rollup tables are the
// only agent-side figures a serve path may read (never action_events).
import { cached } from "../db/client.js";

const JSON_HEADERS = {
  "content-type": "application/json",
  "cache-control": "public, max-age=60",
} as const;

export async function handleNetworkStats(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") return new Response(null, { status: 405 });
  const db = cached(env);
  try {
    // §14.3 S9's SQL lives in app.network_stats_daily — the rollup tables are
    // musebook_jobs-only, so the route crosses the plane through the function.
    const { rows } = await db.query<{ network_stats_daily: unknown }>(
      "select app.network_stats_daily()",
    );
    const doc = (rows[0]?.network_stats_daily ?? {}) as {
      agent_reads?: number;
      paid_reads?: number;
    };
    return new Response(
      JSON.stringify({
        agent_reads: Number(doc.agent_reads ?? 0),
        paid_reads: Number(doc.paid_reads ?? 0),
      }),
      { status: 200, headers: JSON_HEADERS },
    );
  } finally {
    await db.end().catch(() => undefined);
  }
}
