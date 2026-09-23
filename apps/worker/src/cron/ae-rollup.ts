// apps/worker/src/cron/ae-rollup.ts — the one place Analytics Engine is read
// for rollups. Runs inside the `0 * * * *` scheduled() branch at UTC hour 04,
// because a cron interval >= 1 hour gets a 15-minute CPU budget and a shorter
// one silently caps at 30 seconds (§13.7.4).
import { pgFresh, type DbClient } from "../db.js";

const aeUrl = (env: Env): string =>
  `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`;

async function aeQuery<T>(env: Env, sql: string): Promise<T[]> {
  const res = await fetch(aeUrl(env), {
    method: "POST",
    headers: { authorization: `Bearer ${env.CF_API_TOKEN}` },
    body: sql,
  });
  if (!res.ok) throw new Error(`analytics_engine ${res.status}`);
  const json = await res.json<{ data: T[] }>();
  return json.data;
}

/** The twelve dwell buckets of app.dwell_bucket, as SUM(IF(...)) columns.
 *  SUM(_sample_interval), never a bare row count: Analytics Engine samples its own
 *  writes and _sample_interval is how many real events a stored row stands for. */
const EDGES = [
  0,
  1000,
  2000,
  5000,
  10000,
  20000,
  30000,
  60000,
  120000,
  300000,
  600000,
  1800000,
  Number.MAX_SAFE_INTEGER,
];

const histCols = (): string =>
  EDGES.slice(0, 12)
    .map(
      (lo, i) =>
        `SUM(IF(blob1 = 'dwell' AND double2 >= ${lo} AND double2 < ${EDGES[i + 1]}, ` +
        `_sample_interval, 0)) AS h${i + 1}`,
    )
    .join(",\n    ");

export function postStatsSql(day: string): string {
  return `
    SELECT
      index1 AS post_id,
      SUM(IF(blob1 = 'impression', _sample_interval, 0))                       AS impressions,
      SUM(IF(blob1 = 'dwell',      _sample_interval, 0))                       AS dwell_events,
      SUM(IF(blob1 = 'dwell',      double2 * _sample_interval, 0))             AS dwell_ms_total,
      SUM(IF(blob1 = 'dwell' AND double4 >= 90, _sample_interval, 0))          AS scroll_completes,
      SUM(IF(blob1 = 'dwell' AND double5 >= 25, _sample_interval, 0))          AS media_q25,
      SUM(IF(blob1 = 'dwell' AND double5 >= 50, _sample_interval, 0))          AS media_q50,
      SUM(IF(blob1 = 'dwell' AND double5 >= 75, _sample_interval, 0))          AS media_q75,
      ${histCols()}
    FROM musebook_telemetry
    WHERE blob2 = 'human'
      AND index1 != '-'
      AND timestamp >= toDateTime('${day} 00:00:00')
      AND timestamp <  toDateTime('${day} 00:00:00') + INTERVAL '1' DAY
    GROUP BY post_id
    LIMIT 10000`;
}

/** Agent plane, aggregate counts only. distinct_agents and signed_agents are
 *  derived in TS from agentKeysSql rather than a distinct-count dialect call —
 *  the AE subset has no portable distinct aggregator, and a second GROUP BY
 *  over (index1, blob9, blob10) is one extra included read. */
export function agentStatsSql(day: string): string {
  return `
    SELECT
      index1 AS post_id,
      SUM(IF(blob1 IN ('impression','agent_crawl'), _sample_interval, 0))      AS fetches,
      SUM(IF(blob12 != '',                        _sample_interval, 0))        AS mcp_calls,
      SUM(IF(blob7 = 'payment_required',          _sample_interval, 0))        AS paywall_hits,
      SUM(double6 * _sample_interval)                                          AS bytes_served
    FROM musebook_telemetry
    WHERE blob2 = 'agent'
      AND index1 != '-'
      AND timestamp >= toDateTime('${day} 00:00:00')
      AND timestamp <  toDateTime('${day} 00:00:00') + INTERVAL '1' DAY
    GROUP BY post_id
    LIMIT 10000`;
}

/** Per-post distinct agent keys + whether a signature was present (blob10). */
export function agentKeysSql(day: string): string {
  return `
    SELECT index1 AS post_id, blob9 AS agent_id, blob10 AS evidence
    FROM musebook_telemetry
    WHERE blob2 = 'agent'
      AND index1 != '-'
      AND blob9 != ''
      AND timestamp >= toDateTime('${day} 00:00:00')
      AND timestamp <  toDateTime('${day} 00:00:00') + INTERVAL '1' DAY
    GROUP BY post_id, agent_id, evidence
    LIMIT 10000`;
}

/** by_tool comes from a separate grouped read — never a lateral join inside an
 *  aggregate (§13.7.3's fan-out-bug note). */
export function byToolSql(day: string): string {
  return `
    SELECT index1 AS post_id, blob12 AS tool,
           SUM(_sample_interval) AS n
    FROM musebook_telemetry
    WHERE blob2 = 'agent'
      AND index1 != '-'
      AND blob12 != ''
      AND timestamp >= toDateTime('${day} 00:00:00')
      AND timestamp <  toDateTime('${day} 00:00:00') + INTERVAL '1' DAY
    GROUP BY post_id, tool
    LIMIT 10000`;
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export function shapePostStats(
  rows: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return rows.map((r) => ({
    post_id: String(r.post_id),
    impressions: num(r.impressions),
    dwell_events: num(r.dwell_events),
    dwell_ms_total: num(r.dwell_ms_total),
    scroll_completes: num(r.scroll_completes),
    media_q25: num(r.media_q25),
    media_q50: num(r.media_q50),
    media_q75: num(r.media_q75),
    hist: Array.from({ length: 12 }, (_, i) => num(r[`h${i + 1}`])),
  }));
}

export function shapeAgentStats(
  stats: Array<Record<string, unknown>>,
  keys: Array<Record<string, unknown>>,
  byTool: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const agentsByPost = new Map<string, Set<string>>();
  const signedByPost = new Map<string, Set<string>>();
  for (const k of keys) {
    const postId = String(k.post_id);
    const agent = String(k.agent_id);
    if (!agentsByPost.has(postId)) agentsByPost.set(postId, new Set());
    agentsByPost.get(postId)?.add(agent);
    if (k.evidence !== "" && k.evidence !== null && k.evidence !== undefined) {
      if (!signedByPost.has(postId)) signedByPost.set(postId, new Set());
      signedByPost.get(postId)?.add(agent);
    }
  }
  const toolsByPost = new Map<string, Record<string, number>>();
  for (const t of byTool) {
    const postId = String(t.post_id);
    const tool = String(t.tool);
    if (!toolsByPost.has(postId)) toolsByPost.set(postId, {});
    toolsByPost.get(postId)![tool] = num(t.n);
  }
  const postIds = new Set<string>([
    ...stats.map((r) => String(r.post_id)),
    ...agentsByPost.keys(),
    ...toolsByPost.keys(),
  ]);
  const statMap = new Map(stats.map((r) => [String(r.post_id), r]));
  return [...postIds].map((postId) => {
    const s = statMap.get(postId) ?? {};
    return {
      post_id: postId,
      fetches: num(s.fetches),
      distinct_agents: agentsByPost.get(postId)?.size ?? 0,
      signed_agents: signedByPost.get(postId)?.size ?? 0,
      mcp_calls: num(s.mcp_calls),
      paywall_hits: num(s.paywall_hits),
      bytes_served: num(s.bytes_served),
      by_tool: toolsByPost.get(postId) ?? {},
    };
  });
}

export function* chunks<T>(rows: T[], n: number): Generator<T[]> {
  for (let i = 0; i < rows.length; i += n) yield rows.slice(i, i + n);
}

/** The pass itself. Four SQL API reads per night = 4 of 1,000,000 included. */
export async function runAeRollup(env: Env, day: string): Promise<void> {
  const sql: DbClient = await pgFresh(env); // HYPERDRIVE_FRESH: read-after-write
  for (const pass of ["post_stats", "agent_stats"] as const) {
    try {
      const rows =
        pass === "post_stats"
          ? shapePostStats(await aeQuery(env, postStatsSql(day)))
          : shapeAgentStats(
              await aeQuery(env, agentStatsSql(day)),
              await aeQuery(env, agentKeysSql(day)),
              await aeQuery(env, byToolSql(day)),
            );
      let applied = 0;
      for (const chunk of chunks(rows, 1000)) {
        const fn =
          pass === "post_stats"
            ? "app.apply_ae_post_stats_daily"
            : "app.apply_ae_agent_stats_daily";
        const r = await sql.query<{ n: number }>(`select ${fn}($1::date, $2::jsonb) as n`, [
          day,
          JSON.stringify(chunk),
        ]);
        applied += Number(r.rows[0]?.n ?? 0);
      }
      await sql.query(`select app.record_ae_run($1::date, $2, 'succeeded', $3)`, [
        day,
        pass,
        applied,
      ]);
    } catch (err) {
      await sql
        .query(`select app.record_ae_run($1::date, $2, 'failed', 0, $3)`, [day, pass, String(err)])
        .catch(() => {});
      throw err;
    }
  }
}
