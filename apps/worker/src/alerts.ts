// apps/worker/src/alerts.ts — dispatched from scheduled() on '*/5 * * * *'.
// A */5 cron caps at 30 seconds of CPU (an interval >= 1h would get 15 minutes);
// this pass is a handful of round trips and is nowhere near it.
import { pgFresh, jobsTx } from "./db.js";

interface QueueMetrics {
  backlogCount: number;
  backlogBytes?: number;
  oldestMessageTimestamp?: string | null;
}

/** Producer-side realtime metrics — shipped 2026-04-28. Present on every
 *  Queue binding in production; absent under `wrangler dev`/miniflare. */
interface MetricsQueue {
  metrics(): Promise<QueueMetrics>;
}

const PRODUCER_QUEUES = [
  "Q_CLASSIFY",
  "Q_MEDIA",
  "Q_MEDIA_FINALIZE",
  "Q_DISTRIBUTE",
  "Q_EMBED",
  "Q_AGENT_CANCEL",
  "Q_R2_EVENTS",
  "Q_DSAR",
] as const;

const DLQ_NAMES = [
  "musebook-classify-dlq",
  "musebook-media-dlq",
  "musebook-media-finalize-dlq",
  "musebook-distribute-dlq",
  "musebook-embed-dlq",
  "musebook-agent-cancel-dlq",
  "musebook-r2-events-dlq",
  "musebook-dsar-dlq",
] as const;

/** The page itself: one POST to ALERT_WEBHOOK_URL, bearer ALERT_WEBHOOK_SECRET.
 *  With no webhook configured the alert is still recorded — as an ops_events
 *  row at level 'error' and a counter — so a missing webhook cannot make a
 *  firing rule silent. */
export async function page(
  env: Env,
  severity: string,
  name: string,
  runbook: string,
): Promise<void> {
  const db = await pgFresh(env).catch(() => null);
  if (db) {
    await jobsTx(db, async () => {
      await db.query(
        `select public.bump_ops_counter('musebook.alert.page',
           jsonb_build_object('severity', $1, 'alert', $2))`,
        [severity, name],
      );
      await db.query(
        `insert into public.ops_events (component, event_name, level, outcome, metadata)
         values ('alerting', $1, 'error', 'fired',
                 jsonb_build_object('severity', $2, 'runbook', $3))`,
        [name, severity, runbook],
      );
    }).catch(() => {});
    await db.end().catch(() => {});
  }
  const url = env.ALERT_WEBHOOK_URL;
  if (!url) return;
  await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(env.ALERT_WEBHOOK_SECRET ? { authorization: `Bearer ${env.ALERT_WEBHOOK_SECRET}` } : {}),
    },
    body: JSON.stringify({ severity, alert: name, runbook, at: new Date().toISOString() }),
  }).catch(() => {});
}

/** §15.17's derivation: the paywall dataset folded into ops_counters, so the
 *  pg evaluator still sees the same conditions when AE is unreachable. */
async function foldIntoOpsCounters(env: Env, rows: Array<Record<string, string>>): Promise<void> {
  const db = await pgFresh(env);
  try {
    await jobsTx(db, async () => {
      for (const r of rows) {
        const labels = {
          outcome: r.outcome ?? "",
          gate: r.gate ?? "",
          mode: r.mode ?? "",
          paywall_mode: r.paywall_mode ?? "",
        };
        await db.query(
          `select public.bump_ops_counter('musebook.paywall.outcome', $1::jsonb, $2)`,
          [labels, Number(r.n) || 0],
        );
        if (r.breaker === "open") {
          await db.query(
            `select public.bump_ops_counter('musebook.x402.breaker_open', '{}'::jsonb, $1)`,
            [Number(r.n) || 0],
          );
        }
      }
    });
  } finally {
    await db.end().catch(() => {});
  }
}

async function bumpQueueGauges(env: Env, name: string, m: QueueMetrics): Promise<void> {
  const db = await pgFresh(env).catch(() => null);
  if (!db) return;
  try {
    const ageMs = m.oldestMessageTimestamp
      ? Date.now() - new Date(m.oldestMessageTimestamp).getTime()
      : 0;
    await jobsTx(db, async () => {
      await db.query(`select public.bump_ops_counter('musebook.queue.backlog', $1::jsonb, $2)`, [
        { queue: name },
        m.backlogCount,
      ]);
      await db.query(
        `select public.bump_ops_counter('musebook.queue.oldest_age_ms', $1::jsonb, $2)`,
        [{ queue: name }, ageMs],
      );
    });
  } finally {
    await db.end().catch(() => {});
  }
}

/** DLQs have no producer binding, so metrics() is unreachable for them; the
 *  REST realtime endpoint takes the queue name directly. */
async function dlqMetrics(env: Env, name: string): Promise<QueueMetrics> {
  const r = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/queues/${name}/metrics/realtime`,
    { headers: { authorization: `Bearer ${env.CF_API_TOKEN}` } },
  );
  if (!r.ok) throw new Error(`queue_metrics_${r.status}`);
  const j: { result?: { metrics?: QueueMetrics } } = await r.json();
  return j.result?.metrics ?? { backlogCount: 0 };
}

export async function writeHeartbeat(env: Env, job: string, failures: string[]): Promise<void> {
  const db = await pgFresh(env);
  try {
    await jobsTx(db, async () => {
      if (failures.length === 0) {
        await db.query(
          `insert into public.job_heartbeats (job, last_success_at, expected_every)
           values ($1, now(), interval '5 minutes')
           on conflict (job) do update
             set last_success_at = now(), last_error = null`,
          [job],
        );
      } else {
        await db.query(
          `insert into public.job_heartbeats (job, expected_every, last_error)
           values ($1, interval '5 minutes', $2)
           on conflict (job) do update set last_error = excluded.last_error`,
          [job, failures.join(";").slice(0, 4000)],
        );
        await db.query(
          `insert into public.ops_events (component, event_name, level, outcome, metadata)
           values ('alerting', $1, 'error', 'partial', jsonb_build_object('failures', $2::jsonb))`,
          [`${job}.partial`, JSON.stringify(failures)],
        );
      }
    });
  } finally {
    await db.end().catch(() => {});
  }
}

/** A23's rate leg: last hour's billable requests vs the trailing 7-day hourly
 *  median, read from the GraphQL Analytics API. Returns true when the rate is
 *  > 4× the median. Failures are the caller's problem — a broken GraphQL read
 *  must not page. */
async function costBurnRateCheck(env: Env): Promise<boolean> {
  const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.CF_API_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      query: `{
        viewer { accounts(filter: {accountTag: "${env.CF_ACCOUNT_ID}"}) {
          workersInvocationsAdaptive(
            limit: 1000,
            filter: {
              datetime_geq: "START",
              datetime_leq: "END"
            },
            orderBy: [datetimeHour_ASC]
          ) { sum { requests } dimensions { datetimeHour } }
        } }
      }`
        .replace("START", new Date(Date.now() - 8 * 86400e3).toISOString())
        .replace("END", new Date().toISOString()),
    }),
  });
  if (!res.ok) return false;
  const j: {
    data?: {
      viewer?: {
        accounts?: Array<{
          workersInvocationsAdaptive?: Array<{
            sum?: { requests?: number };
            dimensions?: { datetimeHour?: string };
          }>;
        }>;
      };
    };
  } = await res.json();
  const series = j.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [];
  const hourly = series.map((p) => Number(p.sum?.requests ?? 0));
  if (hourly.length < 49) return false; // not enough trailing data to trust a median
  const last = hourly[hourly.length - 1] ?? 0;
  const trailing = hourly.slice(-169, -1).sort((a, b) => a - b);
  const median = trailing[Math.floor(trailing.length / 2)] ?? 0;
  return last > Math.max(median * 4, 1);
}

/** One POST = one AE read query = $1.00/million, 1M included. Batch rules into
 *  fewer queries rather than adding cadence. */
async function ae(env: Env, query: string): Promise<Array<Record<string, string>>> {
  const r = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`,
    { method: "POST", headers: { authorization: `Bearer ${env.CF_API_TOKEN}` }, body: query },
  );
  if (!r.ok) throw new Error(`ae_sql_${r.status}`);
  const payload: { data: Array<Record<string, string>> } = await r.json();
  return payload.data;
}

export async function runAlertPass(env: Env, ctx: ExecutionContext): Promise<void> {
  const failures: string[] = [];

  // (1) ONE query covers A1, A2 and A4 plus the fold of every paywall counter.
  try {
    const rows = await ae(
      env,
      `
      SELECT blob3 AS outcome, blob2 AS gate, blob8 AS mode, blob9 AS breaker,
             index1 AS paywall_mode,
             SUM(_sample_interval) AS n
        FROM musebook_paywall
       WHERE timestamp > NOW() - INTERVAL '5' MINUTE
       GROUP BY outcome, gate, mode, breaker, paywall_mode`,
    );

    const sum = (f: (r: Record<string, string>) => boolean): number =>
      rows.filter(f).reduce((a, r) => a + Number(r.n), 0);

    const gated = sum((r) => r.gate === "gated");
    const leaked = sum(
      (r) =>
        r.gate === "gated" && (r.outcome === "served_free_gated" || r.outcome === "bypassed_error"),
    );
    // A1. One is too many; the ratio guard only exists so a single stray event
    // during a deploy does not page before the pg-side rule confirms it.
    if (leaked > 0 && (leaked / Math.max(gated, 1) > 0.005 || leaked >= 5)) {
      await page(env, "P1", "paywall.serve_free_gated", "R-1");
    }
    // A2. X402_MODE is carried on every point rather than polled, so "the
    // deploy that flipped it" is visible without a config heartbeat job.
    if (sum((r) => r.mode !== "live") > 0) await page(env, "P2", "paywall.mode_not_live", "R-1");
    // A4. Breaker counters are PER ISOLATE. A rate, never a single event.
    if (sum((r) => r.breaker === "open") >= 3)
      await page(env, "P1", "x402.facilitator_open", "R-2");

    await foldIntoOpsCounters(env, rows); // section 15.17's derivation
  } catch (e) {
    failures.push(`ae_paywall:${String(e)}`);
  }

  // (2) A19 + A28. Realtime Queues metrics, shipped 2026-04-28. The bound
  //     producers expose metrics() directly; the seven DLQs have no producer
  //     binding, so they go through the REST realtime endpoint by name.
  for (const name of PRODUCER_QUEUES) {
    const q = (env as unknown as Record<string, MetricsQueue | undefined>)[name];
    if (!q?.metrics) {
      failures.push(`queue:${name}:unbound`);
      continue;
    }
    try {
      const m = await q.metrics();
      const ageMs = m.oldestMessageTimestamp
        ? Date.now() - new Date(m.oldestMessageTimestamp).getTime()
        : 0;
      if (m.backlogCount > 5000 || ageMs > 900_000) {
        await page(env, "P2", `queue.backlog:${name}`, "R-14");
      }
      await bumpQueueGauges(env, name, m);
    } catch (e) {
      failures.push(`queue:${name}:${String(e)}`);
    }
  }
  for (const name of DLQ_NAMES) {
    try {
      const m = await dlqMetrics(env, name);
      // An unconsumed DLQ DISCARDS its messages after 4 days. Anything in it at all.
      if (m.backlogCount > 0) {
        await page(env, "P2", `queue.dlq_depth:${name}`, "R-14");
      }
      await bumpQueueGauges(env, name, m);
    } catch (e) {
      failures.push(`dlq:${name}:${String(e)}`);
    }
  }

  // (2b) A23, the rate leg. The dollar leg lives in Budget Alerts, account-side.
  try {
    if (await costBurnRateCheck(env)) {
      await page(env, "P2", "cost.spend_burn", "R-15");
    }
  } catch (e) {
    failures.push(`cost_burn:${String(e)}`);
  }

  // (3) A27 / S9. The one check that catches somebody "fixing" Vercel's
  //     permanently-red domain card by grey-clouding the DNS record, which
  //     removes the Worker from the request path and disables the ENTIRE
  //     paywall with no error anywhere in either dashboard.
  try {
    const gate = await fetch(`https://musebook.dev/p/${env.SYNTHETIC_GATED_SLUG}`, {
      headers: { accept: "text/markdown" },
      redirect: "manual",
    });
    if (gate.status !== 402) {
      await page(env, "P1", "edge.gate_bypassable:no_402", "R-16");
    } else {
      // M12.4: a green probe is evidence, not silence — the counter is what
      // "the synthetic 402 is live and firing" reads back out of.
      const db = await pgFresh(env);
      await db.query(
        `select public.bump_ops_counter('musebook.synthetic_402.gate', '{}'::jsonb, 1)`,
      );
      await db.end().catch(() => {});
    }

    // T17: the origin must refuse anything without x-musebook-edge.
    const origin = await fetch(`https://${env.ORIGIN_HOST}/p/${env.SYNTHETIC_GATED_SLUG}`, {
      redirect: "manual",
    });
    if (origin.status !== 404) {
      await page(env, "P1", "edge.gate_bypassable:origin_open", "R-16");
    } else {
      const db = await pgFresh(env);
      await db.query(
        `select public.bump_ops_counter('musebook.synthetic_402.origin_closed', '{}'::jsonb, 1)`,
      );
      await db.end().catch(() => {});
    }
  } catch (e) {
    failures.push(`synthetic:${String(e)}`);
  }

  // (4) Cross-watch, cf half of A26. The pg half is a seeded rule.
  try {
    const db = await pgFresh(env);
    const { rows } = await db.query<{ stale: boolean }>(
      `select coalesce(last_success_at,'-infinity'::timestamptz) < now() - interval '5 minutes'
                as stale
         from public.job_heartbeats where job = 'evaluate-alerts'`,
    );
    await db.end().catch(() => {});
    if (rows[0]?.stale) await page(env, "P1", "alerts.evaluator_stale:pg_cron", "R-14");
  } catch (e) {
    failures.push(`crosswatch:${String(e)}`);
  }

  // (5) This pass's own heartbeat — LAST, and only with the failure list, so a
  //     partially-broken pass does not look healthy to the pg-side rule.
  ctx.waitUntil(writeHeartbeat(env, "edge-alert-pass", failures));
}
