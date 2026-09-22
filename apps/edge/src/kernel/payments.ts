// apps/edge/src/kernel/payments.ts — PaymentPort over HYPERDRIVE_FRESH only.
// challenge() pins the resolved quote through app.pin_quote (§6.7.6: one
// statement, the plane entered inside the function, max_timeout_seconds 60 ==
// QUOTE_TTL_SECONDS, rate_source 'direct_usdc', pay_to always the treasury).
// settle() is §6.8's settleOnce: facilitator verify -> replay-claim insert ->
// settle -> flip, then the §6.10 three-leg ledger insert on 'settled'.
import type { Actor, PaymentRequired, Resource } from "@musebook/schema";
import type { PaymentPort, SettleOutcome } from "@musebook/kernel";
import {
  buildPaymentRequired,
  FacilitatorClient,
  makeCdpAuthHeaders,
  postLegsForSettlement,
  QUOTE_TTL_SECONDS,
  settleOnce,
  X402_ASSETS,
  type Quote,
} from "@musebook/x402";
import { makeSettlementStore } from "../db/settlements.js";
import type { DbClient } from "../db/client.js";

/** §6.7 asset-domain drift guard, Worker half: the env agrees with itself and
 *  with X402_ASSETS[network], or the deploy is broken and every request 503s.
 *  Runs once per isolate. */
let asserted = false;
export function assertAssetEnv(env: Env): void {
  if (asserted) return;
  const cfg = X402_ASSETS[env.X402_NETWORK];
  const chainId = env.X402_NETWORK.split(":")[1];
  if (
    cfg === undefined ||
    cfg.asset.toLowerCase() !== env.X402_ASSET_ADDRESS.toLowerCase() ||
    chainId !== env.X402_CHAIN_ID ||
    cfg.name !== env.X402_ASSET_EIP712_NAME ||
    String(cfg.decimals) !== env.X402_ASSET_DECIMALS
  ) {
    throw new Error("x402 asset env disagrees with X402_ASSETS — refusing to serve (§6.7)");
  }
  asserted = true;
}

// ── Facilitator, per isolate (§6.7.5). The client's failure-breaker state is
// isolate state on purpose; construction env comes from the first request that
// needs it, which is fine because env vars are per-deploy constants.
let facilitator: FacilitatorClient | null = null;
function facilitatorFor(env: Env): FacilitatorClient {
  facilitator ??= new FacilitatorClient({
    url: env.X402_FACILITATOR_URL ?? "",
    network: env.X402_NETWORK,
    timeoutMs: 8_000,
    ...(env.CDP_API_KEY_ID !== undefined && env.CDP_API_KEY_SECRET !== undefined
      ? { authHeaders: makeCdpAuthHeaders(env.CDP_API_KEY_ID, env.CDP_API_KEY_SECRET) }
      : {}),
  });
  return facilitator;
}

// GET <facilitator>/supported once per isolate; a configured facilitator that
// cannot settle our (v2, exact, network) triple turns every gated route into
// 'unavailable' -> 503 rather than minting 402s nothing can pay (§6.7.5).
let ready: Promise<void> | null = null;
function assertSupported(env: Env): Promise<void> {
  if (ready === null) {
    const p = facilitatorFor(env)
      .supported()
      .then((supported) => {
        const ok = supported.kinds.some(
          (k) => k.x402Version === 2 && k.scheme === "exact" && k.network === env.X402_NETWORK,
        );
        if (!ok) {
          throw new Error(`facilitator does not support ${env.X402_NETWORK} v2 exact`);
        }
      });
    p.catch(() => {
      if (ready === p) ready = null;
    });
    ready = p;
  }
  return ready;
}

export function makePaymentPort(env: Env, fresh: DbClient): PaymentPort {
  return {
    async challenge(input: {
      resource: Resource;
      actor: Actor;
      resourceUrl: string;
      mimeType: string;
      error?: string;
    }): Promise<PaymentRequired> {
      assertAssetEnv(env);
      const cfg = X402_ASSETS[env.X402_NETWORK];
      if (cfg === undefined) throw new Error(`no asset config for ${env.X402_NETWORK}`);
      const quote: Quote = {
        id: crypto.randomUUID(),
        contentHash: input.resource.contentHash,
        network: env.X402_NETWORK,
        asset: cfg.asset,
        payTo: env.X402_PAY_TO,
        amountAtomic: input.resource.priceAtomic,
        maxTimeoutSeconds: QUOTE_TTL_SECONDS,
        rateSource: "direct_usdc",
        expiresAt: new Date(Date.now() + QUOTE_TTL_SECONDS * 1000),
      };
      const required = buildPaymentRequired({
        quote,
        resourceUrl: input.resourceUrl,
        mimeType: input.mimeType,
        description: input.resource.title ?? input.resource.slug,
        tags: input.resource.tags,
        origin: new URL(input.resourceUrl).origin,
        ...(input.error !== undefined ? { error: input.error } : {}),
      });
      await fresh.query(
        `select app.pin_quote(
           $1::uuid, $2, $3::uuid, $4, $5::uuid, 'http',
           $6, $7, $8, $9::numeric, $10::jsonb, $11::uuid)`,
        [
          quote.id,
          input.resourceUrl,
          input.resource.postId,
          quote.contentHash,
          input.actor.plane === "agent" ? input.actor.agentIdentityId : null,
          quote.network,
          quote.asset,
          quote.payTo,
          quote.amountAtomic,
          required,
          input.actor.plane === "human" ? input.actor.userId : null,
        ],
      );
      return required;
    },

    async settle(input: {
      resource: Resource;
      actor: Actor;
      resourceUrl: string;
    }): Promise<SettleOutcome> {
      assertAssetEnv(env);
      try {
        await assertSupported(env);
      } catch {
        return { kind: "unavailable" };
      }
      const outcome = await settleOnce({
        store: makeSettlementStore(fresh),
        facilitator: facilitatorFor(env),
        resource: input.resource,
        actor: input.actor,
        now: new Date(),
        idempotentWindowSeconds: Number(env.X402_IDEMPOTENT_WINDOW_SECONDS ?? "120"),
      });
      // Legs run only on the 'settled' arm: the 'idempotent' arm replays a row
      // whose legs the original settle posted (or the reconciler will).
      if (outcome.kind === "settled") {
        await postLegsForSettlement(fresh, outcome.settlementId);
      }
      return outcome;
    },
  };
}
