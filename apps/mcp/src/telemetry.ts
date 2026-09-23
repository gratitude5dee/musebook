// apps/mcp/src/telemetry.ts — §7.9: the agent-surface data points.
// env.TELEMETRY.writeDataPoint() is never awaited and is not a subrequest —
// it counts against neither the connection cap nor the subrequest budget.
import type { Actor } from "@musebook/schema";

export interface AgentEvent {
  actor: Actor;
  tool: string;
  outcome: "ok" | "payment_required" | "input_required" | "denied" | "error" | "partial";
  surface?: "mcp" | "mcp_feed" | "webmcp";
  contentHash?: string;
  postId?: string;
  n?: number;
  position?: number;
}

export function recordAgentEvent(env: Env, ctx: ExecutionContext, e: AgentEvent): void {
  void ctx;
  try {
    env.TELEMETRY.writeDataPoint({
      indexes: [
        e.actor.plane === "agent" ? (e.actor.agentIdentityId ?? "anonymous-mcp") : "anonymous-mcp",
      ],
      blobs: [e.tool, e.outcome, e.surface ?? "mcp", e.contentHash ?? "", e.postId ?? ""],
      doubles: [e.n ?? 1, e.position ?? 0, 1 /* sample_rate */],
    });
  } catch {
    // Telemetry must never fail a tool call.
  }
}
