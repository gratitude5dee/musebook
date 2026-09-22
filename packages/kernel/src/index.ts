// packages/kernel/src/index.ts — plan.md §6.3, verbatim.
import type { AccessDecision, Actor, Rendered, Representation, Resource } from "@musebook/schema";
import type { KernelPorts } from "./ports.js";
import { getPorts, setPorts } from "./registry.js";
import { resolveAccessWith } from "./access.js";
import { renderResourceWith } from "./render/index.js";

export interface Kernel {
  resolveAccess(resource: Resource, actor: Actor): Promise<AccessDecision>;
  renderResource(
    resource: Resource,
    as: Representation,
    decision: AccessDecision,
  ): Promise<Rendered>;
}

export function createKernel(ports: KernelPorts): Kernel {
  return {
    resolveAccess: (resource, actor) => resolveAccessWith(ports, resource, actor),
    renderResource: (resource, as, decision) => renderResourceWith(ports, resource, as, decision),
  };
}

/**
 * Called from an adapter module (apps/edge, apps/mcp, apps/worker).
 * On workerd this is called ONCE PER REQUEST, not once per process: the ports carry a
 * Hyperdrive-backed `pg` client, and Cloudflare documents that a client cached in a
 * global throws "Cannot perform I/O on behalf of a different request". Connection
 * pooling already removes the startup cost, so per-request construction is correct.
 * `createKernel(ports)` is the preferred form in the Worker for the same reason; the
 * module-level registry exists for the pure test harness and for single-process hosts.
 */
export function configureKernel(ports: KernelPorts): void {
  setPorts(ports);
}

function kernel(): Kernel {
  return createKernel(getPorts()); // getPorts() throws if configureKernel() was never called
}

// The spine's exact signatures.
export function resolveAccess(resource: Resource, actor: Actor): Promise<AccessDecision> {
  return kernel().resolveAccess(resource, actor);
}

export function renderResource(
  resource: Resource,
  as: Representation,
  decision: AccessDecision,
): Promise<Rendered> {
  return kernel().renderResource(resource, as, decision);
}

/**
 * True iff a successful settlement on this resource mints a durable access_grants
 * row (§6.4: only `human_free_agent_paid` does; `x402_always` charges every fetch
 * and mints nothing). The sanctioned way §7.7.2 asks the question. Synchronous —
 * it reads a parsed Resource, not the database.
 */
export function mintsDurableGrant(resource: Resource): boolean {
  return resource.publishMode === "human_free_agent_paid";
}

export type { KernelPorts, SettleOutcome } from "./ports.js";
export type { ResourcePort, GrantPort, PaymentPort, PolicyPort, Grant } from "./ports.js";
export { loadResource } from "./load.js";
export type { ResourceRow } from "./load.js";
export { etagFor, linkHeaderFor, usageHeadersFor } from "./headers.js";
export { formatPriceUsd } from "./price.js";
export { variantIntentFor, accessToPublishMode, pricingLineFor } from "./projections.js";
export { toAccessBadge, type AccessBadgeKind, type AccessBadgeView } from "./view.js";
