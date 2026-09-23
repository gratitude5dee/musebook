// apps/mcp/src/tools/get-analytics.ts — §7.4 tool 11: owner's own counters,
// from the worker-materialized action_events_daily rollups. analytics:read.
// Metrics map onto action_kind; the two with no daily rollup source
// (paywall_hits, distinct_agents) come back in unavailable_metrics — an
// honest empty set, never a fabricated count.
import type { McpServer } from "@modelcontextprotocol/server";
import { fresh, release } from "../db/client.js";
import { resolveActorFromMcp } from "../auth/resolve-actor.js";
import { recordAgentEvent } from "../telemetry.js";
import { requireScope, errorResult } from "./shared.js";
import { getAnalyticsInput } from "./schemas.js";

const METRIC_TO_ACTION = {
  impressions: { action: "impression", field: "n" },
  opens: { action: "view", field: "n" },
  dwell_ms_total: { action: "dwell", field: "dwell_ms" },
  likes: { action: "like", field: "n" },
  comments: { action: "comment", field: "n" },
  reposts: { action: "repost", field: "n" },
  paid_fetches: { action: "x402_pay", field: "n" },
  revenue_atomic: { action: "x402_pay", field: "n" },
} as const;
type MetricName = keyof typeof METRIC_TO_ACTION;
const ALL_METRICS = Object.keys(METRIC_TO_ACTION);

export function registerGetAnalytics(server: McpServer, env: Env, ctx: ExecutionContext): void {
  server.registerTool(
    "get_analytics",
    {
      title: "Read your Musebook analytics",
      description:
        "Aggregated counters for the delegating owner's own posts — impressions, opens, dwell, " +
        "likes, comments, reposts, paid fetches and revenue, per day. " +
        "Requires the analytics:read scope.",
      inputSchema: getAnalyticsInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args, toolCtx) => {
      const actor = await resolveActorFromMcp(toolCtx, env, ctx);
      const denied = requireScope(actor, "analytics:read");
      if (denied !== null) return denied;
      if (actor.class !== "owner_agent")
        return errorResult("unauthenticated", "A delegation is required.");

      const wanted = args.metrics ?? ALL_METRICS;
      const unmapped = wanted.filter((m) => !(m in METRIC_TO_ACTION));
      const mapped = wanted.filter((m): m is MetricName => m in METRIC_TO_ACTION);
      const actions = [...new Set(mapped.map((m) => METRIC_TO_ACTION[m].action))];

      const sql = fresh(env);
      try {
        const rows =
          actions.length === 0
            ? []
            : ((await sql.unsafe(
                `select * from app.analytics_for_owner($1::uuid, $2::uuid, $3::date, $4::date, $5::text[])`,
                [
                  actor.userId,
                  args.scope === "post" ? (args.post_id ?? null) : null,
                  args.from ?? null,
                  args.to ?? null,
                  actions,
                ],
              )) as {
                day: string;
                post_id: string;
                action: string;
                events: number;
                dwell_ms: number;
              }[]);

        // Pivot action rows back onto the metric names the caller asked for.
        const metrics = mapped.flatMap((m) => {
          const { action, field } = METRIC_TO_ACTION[m];
          return rows
            .filter((r) => r.action === action)
            .map((r) => ({
              day: r.day,
              post_id: r.post_id,
              metric: m,
              value: field === "dwell_ms" ? r.dwell_ms : r.events,
            }));
        });

        recordAgentEvent(env, ctx, { actor, tool: "get_analytics", outcome: "ok" });
        return {
          content: [
            {
              type: "text" as const,
              text:
                metrics.length === 0
                  ? "No events in window."
                  : metrics.map((r) => `${r.day} ${r.metric}: ${r.value}`).join("\n"),
            },
          ],
          structuredContent: {
            scope: args.scope,
            granularity: args.granularity === "hour" ? "day" : args.granularity,
            metrics,
            unavailable_metrics: unmapped,
          },
        };
      } finally {
        release(ctx, sql);
      }
    },
  );
}
