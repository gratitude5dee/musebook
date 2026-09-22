// apps/edge/src/env.d.ts — Env keys `wrangler types` cannot see: the secrets
// (never in `vars`) and the service-binding RPC shapes (generated `Service`
// carries fetch/connect only).
export {};

declare global {
  interface Env {
    /** Worker→origin bearer (§3.7 — a secret in BOTH scopes). */
    MUSEBOOK_EDGE_SECRET: string;
    /** x402 pay-to address — a Worker secret (§3.7). */
    X402_PAY_TO: string;
    /** Facilitator URL may be overridden by secret when a key is attached. */
    X402_FACILITATOR_API_KEY?: string;
  }

  /** musebook-worker's SlateBuilder entrypoint over the MIXER service binding
   *  (§9.21). Env.MIXER stays `Service | undefined`; narrow with `as Mixer`. */
  interface MixerBinding {
    buildSlate(req: {
      surface: string;
      actorUserId: string | null;
      actorAgentId: string | null;
      country?: string;
    }): Promise<{ slateId: string | null }>;
  }
}
