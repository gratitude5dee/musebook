// packages/telemetry/src/ae.ts — the one writer. Imported by apps/edge,
// apps/mcp and apps/worker; no other file calls writeDataPoint.
import type { Surface } from "@musebook/schema/surface";

export interface Point {
  postId?: string | null | undefined;
  action: string; // action_kind, or a muse.* metric name
  plane: "human" | "agent";
  surface?: Surface | null | undefined;
  slateId: string;
  weightsVersion: string;
  modelVersion: string;
  outcome?: string | undefined;
  contentHash?: string | null | undefined;
  agentId?: string | null | undefined;
  evidence?: string | null | undefined;
  declaredIntent?: string | null | undefined;
  mcpTool?: string | null | undefined;
  routeClass?: string | undefined;
  rung?: string | undefined;
  requestId?: string | undefined;
  release?: string | undefined;
  position?: number | undefined;
  dwellMs?: number | undefined;
  sampleRate: number; // REQUIRED. There is no default.
  maxScrollPct?: number | undefined;
  completionPct?: number | undefined;
  bytesServed?: number | undefined;
  n?: number | undefined;
  value?: number | undefined;
}

const s = (v: string | null | undefined): string => v ?? "";
const d = (v: number | null | undefined): number => (Number.isFinite(v) ? (v as number) : 0);

/** NEVER awaited. writeDataPoint is non-blocking, is not a subrequest, does not
 *  count against the six-simultaneous-connection cap, and is not billed as a
 *  Workers request. It is also not available in `wrangler dev` (§13.1.2), which
 *  is why the try/catch is unconditional rather than defensive. */
export function writePoint(ds: AnalyticsEngineDataset, p: Point): void {
  try {
    ds.writeDataPoint({
      indexes: [p.postId ?? "-"],
      blobs: [
        p.action,
        p.plane,
        s(p.surface),
        p.slateId,
        p.weightsVersion,
        p.modelVersion,
        p.outcome ?? "ok",
        s(p.contentHash),
        s(p.agentId),
        s(p.evidence),
        s(p.declaredIntent),
        s(p.mcpTool),
        p.routeClass ?? "page",
        p.rung ?? "",
        p.requestId ?? "",
        p.release ?? "",
        "",
        "",
        "",
        "",
      ],
      doubles: [
        d(p.position),
        d(p.dwellMs),
        p.sampleRate,
        d(p.maxScrollPct),
        d(p.completionPct),
        d(p.bytesServed),
        p.n ?? 1,
        d(p.value),
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
      ],
    });
  } catch {
    // A telemetry write may never fail a request. §13.5.4 is the drop posture.
  }
}
