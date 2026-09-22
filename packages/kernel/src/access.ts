// packages/kernel/src/access.ts — plan.md §6.5, verbatim.
import type {
  AccessDecision,
  Actor,
  DenyReason,
  PaymentRequired,
  Resource,
} from "@musebook/schema";
import type { KernelPorts } from "./ports.js";
import { PRIVATE_NO_STORE, PUBLIC_CACHEABLE, PUBLIC_CACHEABLE_AGENT_VARY } from "./cache.js";

/**
 * THE ONLY FUNCTION IN MUSEBOOK THAT READS publishMode.
 * Enforced mechanically by tools/eslint-plugin-musebook/rules/no-publish-mode-outside-kernel.js
 * (see the §6.1 amendment extending its needle set to camelCase).
 */
export async function resolveAccessWith(
  ports: KernelPorts,
  resource: Resource,
  actor: Actor,
): Promise<AccessDecision> {
  try {
    // 0. Servability. A draft/scheduled/removed post is a 404 to everyone but its author.
    const isAuthor = actor.userId !== null && actor.userId === resource.authorUserId;
    if (resource.status !== "published" && resource.status !== "unlisted" && !isAuthor) {
      return deny("not_published", 404, "empty", null);
    }

    // 1. The author, and any agent acting under the author's delegation, reads free.
    //    (owner_agent.userId IS the delegating human — §5.6 — so this one test covers both.)
    if (isAuthor) {
      return {
        allow: true,
        reason: "owner",
        bodyKind: "full",
        grantId: null,
        settlementId: null,
        settlement: null,
        cache: PRIVATE_NO_STORE,
      };
    }

    // 2. Blocked agents get nothing, not even a teaser.
    const agentId = agentIdOf(actor);
    if (agentId !== null && (await ports.policy.isAgentBlocked(agentId))) {
      return deny("blocked_agent", 403, "empty", null);
    }

    // 3. Kill switch. `shadow` computes the decision, logs it, and serves anyway.
    const mode = ports.policy.mode();

    // 4. Mode dispatch.
    switch (resource.publishMode) {
      case "free":
        return {
          allow: true,
          reason: "mode_free",
          bodyKind: "full",
          grantId: null,
          settlementId: null,
          settlement: null,
          cache: PUBLIC_CACHEABLE,
        };

      case "human_free_agent_paid": {
        if (actor.plane === "human") {
          return {
            allow: true,
            reason: "human_plane",
            bodyKind: "full",
            grantId: null,
            settlementId: null,
            settlement: null,
            cache: PUBLIC_CACHEABLE_AGENT_VARY,
          };
        }
        const payer = payerOf(actor);
        const held = await ports.grants.findLiveGrant({
          contentHash: resource.contentHash,
          payer,
          agentId,
          userId: actor.userId,
        });
        if (held !== null) {
          return {
            allow: true,
            reason: "grant_held",
            bodyKind: "full",
            grantId: held.id,
            settlementId: held.settlementId,
            settlement: null,
            cache: PRIVATE_NO_STORE,
          };
        }
        return await charge(ports, resource, actor, mode, /* mintGrant */ true);
      }

      case "x402_always":
        return await charge(ports, resource, actor, mode, /* mintGrant */ false);
    }
  } catch (err) {
    // Spine invariant 9: a thrown access check DENIES. It never serves bytes.
    ports.log({
      level: "error",
      msg: "resolveAccess threw",
      requestId: actor.requestId,
      err: String(err),
    });
    return deny("kernel_error", 503, "empty", null);
  }
}

async function charge(
  ports: KernelPorts,
  resource: Resource,
  actor: Actor,
  mode: "live" | "shadow" | "off",
  mintGrant: boolean,
): Promise<AccessDecision> {
  const resourceUrl = `${ports.policy.siteOrigin()}/p/${resource.slug}`;

  if (mode === "off") {
    return {
      allow: true,
      reason: "mode_free",
      bodyKind: "full",
      grantId: null,
      settlementId: null,
      settlement: null,
      cache: PRIVATE_NO_STORE,
    };
  }

  // `shadow` is decided BEFORE the payment check. The preview Worker
  // `musebook-edge-preview` sets X402_MODE=shadow and X402_NETWORK=eip155:84532
  // (§3.6.1) and must never settle real money — including when a client presents a
  // PAYMENT-SIGNATURE. The 402 is computed and logged; a 200 is served; nothing
  // touches ports.payments.settle. §16 M8 gate 11 asserts x402_settlements is
  // unchanged after a valid signed payment in shadow mode.
  if (mode === "shadow") {
    const challenge = await ports.payments.challenge({
      resource,
      actor,
      resourceUrl,
      mimeType: "text/markdown",
      error: "PAYMENT-SIGNATURE header is required",
    });
    ports.log({
      level: "info",
      msg: "x402 shadow",
      requestId: actor.requestId,
      postId: resource.postId,
      wouldCharge: challenge.accepts[0]?.amount ?? null,
      paymentPresented: actor.payment !== null,
    });
    return {
      allow: true,
      reason: "mode_free",
      bodyKind: "full",
      grantId: null,
      settlementId: null,
      settlement: null,
      cache: PRIVATE_NO_STORE,
    };
  }

  if (actor.payment === null) {
    const challenge = await ports.payments.challenge({
      resource,
      actor,
      resourceUrl,
      mimeType: "text/markdown",
      error: "PAYMENT-SIGNATURE header is required",
    });
    return deny("payment_required", 402, "preview", challenge);
  }

  const outcome = await ports.payments.settle({ resource, actor, resourceUrl });

  switch (outcome.kind) {
    case "settled": {
      let grantId: string | null = null;
      if (mintGrant) {
        const grant = await ports.grants.mintGrant({
          settlementId: outcome.settlementId,
          contentHash: resource.contentHash,
          postId: resource.postId,
          payer: outcome.payer.toLowerCase(),
          subjectAgentId: agentIdOf(actor),
          subjectUserId: actor.userId,
          expiresAt: null, // durable for these exact bytes
        });
        grantId = grant.id;
      }
      return {
        allow: true,
        reason: "settled_now",
        bodyKind: "full",
        grantId,
        settlementId: outcome.settlementId,
        settlement: outcome.response,
        cache: PRIVATE_NO_STORE,
      };
    }

    case "idempotent":
      return {
        allow: true,
        reason: "idempotent_replay",
        bodyKind: "full",
        grantId: null,
        settlementId: outcome.settlementId,
        settlement: outcome.response,
        cache: PRIVATE_NO_STORE,
      };

    case "in_flight":
      return deny("replay_in_flight", 409, "preview", null);

    case "consumed":
      return deny(
        "authorization_consumed",
        402,
        "preview",
        await ports.payments.challenge({
          resource,
          actor,
          resourceUrl,
          mimeType: "text/markdown",
          error: "authorization already consumed",
        }),
      );

    case "quote_expired":
      return deny(
        "quote_expired",
        402,
        "preview",
        await ports.payments.challenge({
          resource,
          actor,
          resourceUrl,
          mimeType: "text/markdown",
          error: "quote expired; a fresh quote is attached",
        }),
      );

    case "quote_mismatch":
      return deny(
        "quote_mismatch",
        402,
        "preview",
        await ports.payments.challenge({
          resource,
          actor,
          resourceUrl,
          mimeType: "text/markdown",
          error: `quote mismatch: ${outcome.detail}`,
        }),
      );

    case "invalid":
      return deny(
        "payment_invalid",
        402,
        "preview",
        await ports.payments.challenge({
          resource,
          actor,
          resourceUrl,
          mimeType: "text/markdown",
          error: outcome.invalidReason,
        }),
      );

    case "unavailable":
      return deny("facilitator_unavailable", 503, "preview", null);
  }
}

/** The address a grant is looked up by or minted to. §5.6's `payerAddress` is the
 *  resolver's answer; a signed authorization's `from` overrides it because it is proven. */
function payerOf(actor: Actor): string | null {
  if (actor.payment !== null) return actor.payment.payload.authorization.from.toLowerCase();
  if (actor.payerAddress !== null) return actor.payerAddress.toLowerCase();
  return null;
}

/** Only the two agent classes carry an agent identity; the switch is exhaustive on purpose. */
function agentIdOf(actor: Actor): string | null {
  switch (actor.class) {
    case "owner_agent":
      return actor.agentIdentityId;
    case "crawler_agent":
      return actor.agentIdentityId;
    case "human_reader":
    case "human_creator":
      return null;
  }
}

// Plain unions, not conditional types: a conditional type distributes only over a
// naked type parameter, and `AccessDecision extends {...}` on the concrete union
// evaluates whole (to false), which resolved both parameters to `never`.
function deny(
  reason: DenyReason,
  httpStatus: 402 | 403 | 404 | 409 | 503,
  bodyKind: "preview" | "empty",
  challenge: PaymentRequired | null,
): AccessDecision {
  return { allow: false, reason, httpStatus, bodyKind, challenge, cache: PRIVATE_NO_STORE };
}
