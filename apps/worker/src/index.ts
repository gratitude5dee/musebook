// apps/worker/src/index.ts — 14 queue consumers + Cron, no public surface
// (§3.1). One queue() entrypoint switches on batch.queue; one scheduled()
// entrypoint switches on controller.cron against the canonical crons array in
// wrangler.jsonc — a cron with no matching case is a §15.28 acceptance failure.
import { sweepOutbox } from "./cron/outbox.js";
import { rebuildAnonSlates } from "./cron/slates.js";
import { reconcileSettlements } from "./cron/settlements.js";
import { assertAssetDomainCron } from "./cron/asset-domain.js";
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
    switch (controller.cron) {
      case "* * * * *":
        await sweepOutbox(env, ctx);
        return reconcileSettlements(env);
      case "*/5 * * * *":
        return noop(); // §15's runAlertPass lands at M15
      case "0 * * * *":
        return rebuildAnonSlates(env, ctx); // §9.19 + §13 rollups hang off this one
      case "0 4 * * 1":
        // §6.7's asset-domain drift check; §12's refreshPlatformConstraints joins it later.
        return assertAssetDomainCron(env);
      case "*/15 * * * *":
        return noop(); // §10's agent maintenance lands at M10
      case "17 3 * * *":
        return noop(); // §10.10.4's reputation pass
    }
  },
} satisfies ExportedHandler<Env>;
