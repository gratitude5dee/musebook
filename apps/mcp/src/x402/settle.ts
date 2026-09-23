// apps/mcp/src/x402/settle.ts — the PaymentPort for musebook-mcp, §7.7.2.
// Same settleOnce as HTTP; the transport differs only in where the payload is
// read (_meta["x402/payment"]) and where the response is written
// (_meta["x402/payment-response"]). pin_quote's `transport` arg is 'mcp' so a
// quote pinned here can never satisfy an HTTP retry of the same row.
import type { Actor, PaymentRequired, Resource } from "@musebook/schema";
import type { PaymentPort, SettleOutcome } from "@musebook/kernel";
import {
  buildPaymentRequired,
  checkAgainstQuote,
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

let facilitator: FacilitatorClient | null = null;
function facilitatorFor(env: Env): FacilitatorClient {
  facilitator ??= new FacilitatorClient({
    url: env.X402_FACILITATOR_URL ?? "",
    network: env.X402_NETWORK,
    timeoutMs: 20_000, // NOT the SDK default of 90_000 — far too long for an edge request
    ...(env.CDP_API_KEY_ID !== undefined && env.CDP_API_KEY_SECRET !== undefined
      ? { authHeaders: makeCdpAuthHeaders(env.CDP_API_KEY_ID, env.CDP_API_KEY_SECRET) }
      : {}),
  });
  return facilitator;
}

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

export function makeMcpPaymentPort(env: Env, fresh: DbClient): PaymentPort {
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
           $1::uuid, $2, $3::uuid, $4, $5::uuid, 'mcp',
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
      if ((env.X402_MODE as string) !== "live" && input.actor.payment !== null) {
        // shadow computes and logs; it never settles (§6.5). checkAgainstQuote
        // still runs so a would-be quote mismatch is visible in Workers Logs.
        const store = makeSettlementStore(fresh);
        const payment = input.actor.payment;
        const live = await store.findLiveQuote({
          contentHash: input.resource.contentHash,
          network: payment.accepted.network,
          asset: payment.accepted.asset,
          amountAtomic: payment.accepted.amount,
        });
        const check =
          live === null
            ? { ok: false as const, kind: "mismatch" as const, detail: "no_matching_quote" }
            : checkAgainstQuote(live, payment.accepted, payment.payload.authorization, new Date());
        console.info(
          JSON.stringify({
            msg: "x402 shadow (mcp)",
            requestId: input.actor.requestId,
            postId: input.resource.postId,
            check,
          }),
        );
        return { kind: "invalid", invalidReason: "shadow_mode" };
      }
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
      if (outcome.kind === "settled") {
        await postLegsForSettlement(fresh, outcome.settlementId);
      }
      return outcome;
    },
  };
}
