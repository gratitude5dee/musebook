// apps/edge/src/kernel/configure.ts — portsFor(request, env, ctx), per request,
// never a module global: Hyperdrive clients may not cross requests ("Cannot
// perform I/O on behalf of a different request"). Content reads on
// HYPERDRIVE_CACHED; every access decision (grants, quotes, blocks) on FRESH.
import type { KernelPorts } from "@musebook/kernel";
import { fresh, type DbClient } from "../db/client.js";
import { makeGrantPort } from "./grants.js";
import { makePaymentPort } from "./payments.js";
import { makePolicyPort } from "./policy.js";
import { makeResourcePort } from "./resources.js";

/**
 * The actor reaches the ports by reference, not by argument: §6.12.2's order
 * builds ports before resolveActor, so the viewer's user id lands in `ctx.actor`
 * and the resource port reads it lazily, on the statement that needs it.
 */
export interface RequestCtx {
  actorUserId: string | null;
}

export function portsFor(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  ref: RequestCtx = { actorUserId: null },
  db?: DbClient,
): KernelPorts {
  // NEVER end the client here: ctx.waitUntil(db.end()) evaluates end() at
  // portsFor() call time — every kernel query then hits a closed pool
  // (CONNECTION_ENDED). Ownership stays with the caller, who releases the
  // client inside its own finally, the release(ctx, db) convention.
  const freshDb = db ?? fresh(env);

  return {
    now: () => new Date(),
    resources: makeResourcePort(freshDb, () => ref.actorUserId),
    grants: makeGrantPort(env, freshDb, ctx),
    payments: makePaymentPort(env, freshDb),
    policy: makePolicyPort(env, freshDb, request),
    log: (e) => console.log(JSON.stringify(e)),
  };
}

export type { DbClient };
