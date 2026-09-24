// apps/worker/src/index.ts — 14 queue consumers + Cron, no public surface
// (§3.1). One queue() entrypoint switches on batch.queue; one scheduled()
// entrypoint switches on controller.cron against the canonical crons array in
// wrangler.jsonc — a cron with no matching case is a §15.28 acceptance failure.
import { sweepOutbox } from "./cron/outbox.js";
import { rebuildAnonSlates, rebuildWarmSlates } from "./cron/slates.js";
import { reconcileSettlements } from "./cron/settlements.js";
import { assertAssetDomainCron } from "./cron/asset-domain.js";
import { drainDueSchedules } from "./cron/agent-draft.js";
import {
  sweepHeldReservations,
  reapBridgeTasks,
  refreshConnectorTokens,
} from "./cron/agent-maintenance.js";
import { recomputeReputation } from "./cron/agent-reputation.js";
import { distributeReconcile } from "./cron/distribute-reconcile.js";
import { collectPlatformAnalytics } from "./cron/analytics.js";
import { refreshChannelConstraints } from "./cron/refresh-channel-constraints.js";
import { runAeRollup } from "./cron/ae-rollup.js";
import { backfillPostEmbeddings, recomputeUserEmbeddings } from "./cron/embed.js";
import { runAlertPass, writeHeartbeat } from "./alerts.js";
import { mediaPoll } from "./cron/media-poll.js";
import { deriveNotDwelledLabels } from "./cron/label-builder.js";
import { dispatch } from "./consumers/index.js";
import { SlateBuilder } from "./slate-builder.js";

/** §9.21: the service musebook-edge reaches over its MIXER binding — the
 *  wrangler services entry names this entrypoint class. buildSlate() is the
 *  RPC — never a route. */
export { SlateBuilder };

const noop = async (): Promise<void> => {
  // M10-M15 crons — declared so every declared cron has a case today.
};

export default {
  async queue(batch: MessageBatch, env: Env): Promise<void> {
    await dispatch(batch, env);
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    // §15.19: every scheduled job's last action on success is its heartbeat.
    // waitUntil so a failed heartbeat write can never kill the job itself.
    const beat = (job: string): void => {
      ctx.waitUntil(writeHeartbeat(env, job, []));
    };
    switch (controller.cron) {
      case "* * * * *":
        await sweepOutbox(env, ctx);
        beat("outbox-sweeper");
        await reconcileSettlements(env);
        return beat("settlements-reconcile");
      case "*/5 * * * *":
        // §12.3.9's reconciler is the state machine's authority; §15.19's
        // runAlertPass is the cf-side evaluator on the same tick and writes
        // its own heartbeat (edge-alert-pass) inside itself.
        await distributeReconcile(env);
        beat("distribute-reconcile");
        // §11.7.4: the media reconciler is the webhook's only fallback — polls
        // every live media_jobs row and times out anything past deadline_at.
        await mediaPoll(env);
        beat("media-poll");
        await runAlertPass(env, ctx);
        return noop();
      case "0 * * * *": {
        // §9.23: embeddings land before the slate rebuild in the same tick so
        //  a viewer's fresh embedding feeds the slate built seconds later.
        await backfillPostEmbeddings(env);
        beat("embed-backfill");
        await recomputeUserEmbeddings(env);
        beat("user-embed");
        // §9.17: warm viewers first, then the anonymous R3 slate. Both write
        // through SlateBuilder's scored pass, never the request path.
        await rebuildWarmSlates(env);
        beat("slates-warm");
        await rebuildAnonSlates(env, ctx); // §9.20 rung R3 + §13 rollups
        beat("slates-build");
        // §13.7.4: the AE rollup needs the 15-minute CPU budget that only an
        // interval >= 1h gets, so it hangs off this trigger gated on the hour.
        if (new Date(controller.scheduledTime).getUTCHours() === 4) {
          const day = new Date(Date.now() - 86400e3).toISOString().slice(0, 10);
          await runAeRollup(env, day);
          beat("rollup-daily-ae");
        }
        await collectPlatformAnalytics(env); // §12.3.10's decaying collector
        return beat("analytics-export");
      }
      case "0 4 * * 1":
        // §6.7's asset-domain drift check + §12.3.1's live-constraints refresh.
        await assertAssetDomainCron(env);
        beat("asset-domain-check");
        await refreshChannelConstraints(env);
        return beat("channel-constraints-refresh");
      case "*/15 * * * *":
        // §10.15's order matters: release dead holds before claiming new work,
        // so a stuck schedule cannot starve a cap it no longer needs.
        await reapBridgeTasks(env);
        await sweepHeldReservations(env);
        await refreshConnectorTokens(env);
        await drainDueSchedules(env, ctx);
        // §13.4.1's label builder on the same tick as the settle window.
        await deriveNotDwelledLabels(env);
        beat("label-builder");
        return beat("agent-suite");
      case "17 3 * * *":
        await recomputeReputation(env);
        return beat("agent-reputation");
    }
  },
} satisfies ExportedHandler<Env>;
