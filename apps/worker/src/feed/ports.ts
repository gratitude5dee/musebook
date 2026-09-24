// apps/worker/src/feed/ports.ts — the composing-app half of the mixer (§9.4).
// postgresDbHandles takes injected SqlClients; this file supplies the two
// ports the package deliberately does not implement: monetization (the kernel
// projection surface — never the publish_mode column, §9.8) and telemetry
// (Analytics Engine + the jobs-plane agent-action insert).
import { loadResource, toAccessBadge } from "@musebook/kernel";
import type { ResourceRow } from "@musebook/kernel";
import type { DbHandles, MonetizationPort } from "@musebook/muse-mixer";
import type { PublishMode } from "@musebook/schema";
import { postgresDbHandles } from "@musebook/muse-mixer/adapters/pg";
import { weightsRowVersion } from "@musebook/muse-mixer";
import { workersTelemetry } from "@musebook/muse-mixer/adapters/workers";
import { writePoint } from "@musebook/telemetry";
import type { DbClient } from "../db.js";

const BADGE_MODE = {
  open: "free",
  toll: "human_free_agent_paid",
  gated: "x402_always",
} as const satisfies Record<string, PublishMode>;

/**
 * §9.8: `loadResource()` on the batch, `toAccessBadge(resource).kind` mapped
 * open→free / toll→human_free_agent_paid / gated→x402_always, `resource.priceUsd`
 * for the price, live grants for `viewerEntitled` (the hydrator also ORs
 * `entitlements.paidContentHashes` over this — a miss here still resolves).
 * Never reads publish_mode: the mode comes back through the projection.
 */
export function kernelMonetization(fresh: DbClient): MonetizationPort {
  return {
    async forCandidates({ postIds, viewerUserId, viewerWallet }) {
      if (postIds.length === 0) return new Map();
      const [resources, entitled] = await Promise.all([
        fresh.query<ResourceRow>(
          "select * from app.load_resources_by_post_ids($1::uuid[], null::uuid)",
          [postIds],
        ),
        // access_grants is kernel-plane (§4.14) — the app.* capability enters
        // the role inside its own statement; never a raw select here.
        fresh.query<{ content_hash: string }>(
          "select content_hash from app.viewer_paid_content_hashes($1::uuid, $2)",
          [viewerUserId, viewerWallet],
        ),
      ]);
      const entitledSet = new Set(entitled.rows.map((r) => r.content_hash));
      const out = new Map<
        string,
        { mode: PublishMode; priceUsd: string | null; viewerEntitled: boolean }
      >();
      for (const row of resources.rows) {
        const resource = loadResource(row);
        const badge = toAccessBadge(resource);
        out.set(row.post_id, {
          mode: BADGE_MODE[badge.kind],
          priceUsd: resource.priceUsd,
          viewerEntitled: entitledSet.has(row.content_hash),
        });
      }
      return out;
    },
  };
}

/** §13's agent-plane writer: the mixer's side-effect rows land in
 *  action_events through the same ingest fn the edge route uses. */
export async function insertAgentActions(
  fresh: DbClient,
  rows: ReadonlyArray<Record<string, unknown>>,
): Promise<void> {
  if (rows.length === 0) return;
  const events = rows.map((r) => ({
    event_id: crypto.randomUUID(),
    occurred_at: new Date().toISOString(),
    actor_plane: "agent",
    viewer_user_id: null,
    actor_agent_id: r["agent_id"] ?? null,
    post_id: r["post_id"] ?? null,
    action: r["action"],
    surface: r["surface"],
    slate_id: r["slate_id"] ?? null,
    position: r["position"] ?? null,
    // version alone — the candidate's version/cohort compound is not the FK.
    weights_version:
      typeof r["weights_version"] === "string" ? weightsRowVersion(r["weights_version"]) : "none",
    model_version: r["model_version"] ?? "reverse_chron",
    dwell_ms: null,
    client: null,
    ip_hash: null,
    request_id: null,
  }));
  // ($1::text)::jsonb + JSON.stringify — arrays don't survive `$1::jsonb`
  // under node-pg (array literal, not JSON); ingest.ts uses the same form.
  await fresh.query("select app.ingest_action_events(($1::text)::jsonb)", [JSON.stringify(events)]);
}

/** §9.23's `feedPorts(env)`: the whole DbHandles over both Hyperdrive
 *  bindings — cached for content/dimension reads, fresh for grants, the
 *  slate write and the jobs-plane telemetry insert. */
export function feedPorts(input: {
  cached: DbClient;
  fresh: DbClient;
  ae?: {
    writeDataPoint(point: { indexes?: string[]; doubles?: number[]; blobs?: string[] }): void;
  };
  /** Effective impression/mixer sample rate — TELEMETRY_IMPRESSION_SAMPLE.
   *  Required: §13.3.1's double3 has no default and a shadow point that lies
   *  about its rate is worse than no point. */
  telemetrySampleRate: number;
}): DbHandles {
  const { cached, fresh } = input;
  const ae = input.ae;
  return postgresDbHandles({
    cached,
    fresh,
    monetization: kernelMonetization(fresh),
    telemetry: workersTelemetry(
      ae,
      (rows) => insertAgentActions(fresh, rows),
      ae === undefined
        ? undefined
        : {
            sampleRate: input.telemetrySampleRate,
            writePoint: (p) =>
              writePoint(ae, {
                postId: p.postId,
                action: "muse.shadow_score",
                plane: p.plane,
                surface: p.surface,
                slateId: p.slateId,
                weightsVersion: p.weightsVersion,
                modelVersion: p.modelVersion,
                position: p.position,
                value: p.value,
                sampleRate: p.sampleRate,
              }),
          },
    ),
  });
}
