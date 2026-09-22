// apps/worker/src/env.d.ts — Env keys wrangler types cannot see: the secrets
// (never in `vars`).
export {};

declare global {
  interface Env {
    /** CDP facilitator request-signing key pair — Worker secrets (§6.7.5).
     *  Same secrets as musebook-edge: the reconciler re-settles through the
     *  same authenticated facilitator. */
    CDP_API_KEY_ID?: string;
    CDP_API_KEY_SECRET?: string;

    /** §10.8.1 — base64 of the 32-byte key-encrypting key for
     *  connector_credentials; Worker secret, never in vars. */
    CONNECTOR_CRED_KEK?: string;
    /** §10.8.4 — Ed25519 private JWK (JSON) for outbound signing; Worker
     *  secret. Absent → guardedFetch sends unsigned. */
    CONNECTOR_SIGNING_PRIVATE_KEY?: string;
  }
}
