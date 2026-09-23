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
    /** CDP facilitator request-signing key pair — secrets (§6.7.5). */
    CDP_API_KEY_ID?: string;
    CDP_API_KEY_SECRET?: string;
    /** R2 multipart signing credentials — scoped to musebook-uploads alone
     *  (§3.7). A credential reaching musebook-paid is a paywall bypass. */
    R2_ACCESS_KEY_ID: string;
    R2_SECRET_ACCESS_KEY: string;

    /** §10.8.1 — base64 of the 32-byte KEK for connector_credentials; secret. */
    CONNECTOR_CRED_KEK?: string;
    /** §10.8.4 — Ed25519 private JWK (JSON) for outbound signing; secret. */
    CONNECTOR_SIGNING_PRIVATE_KEY?: string;
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
