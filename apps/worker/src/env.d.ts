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
  }
}
