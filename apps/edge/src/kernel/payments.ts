// apps/edge/src/kernel/payments.ts — PaymentPort over HYPERDRIVE_FRESH only.
// challenge() pins the resolved quote through app.pin_quote (§6.7.6: one
// statement, the plane entered inside the function, max_timeout_seconds 60 ==
// QUOTE_TTL_SECONDS, rate_source 'direct_usdc', pay_to always the treasury).
// settle() ships with §6.8's settleOnce at M8 — 'unavailable' is the fail-closed
// answer: facilitator_unavailable -> 503, never a free 200 (spine invariant 9).
import type { Actor, PaymentRequired, Resource } from "@musebook/schema";
import type { PaymentPort, SettleOutcome } from "@musebook/kernel";
import { buildPaymentRequired, QUOTE_TTL_SECONDS, X402_ASSETS, type Quote } from "@musebook/x402";
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

    // §6.8's settleOnce (facilitator verify -> replay-claim -> settle -> flip)
    // lands with the settlement milestone. 'unavailable' maps to
    // facilitator_unavailable -> 503: the paywall fails closed, never open.
    // eslint-disable-next-line @typescript-eslint/require-await
    async settle(): Promise<SettleOutcome> {
      return { kind: "unavailable" };
    },
  };
}
