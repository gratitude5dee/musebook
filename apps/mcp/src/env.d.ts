// apps/mcp/src/env.d.ts — Env keys `wrangler types` cannot see: secrets only.
export {};

declare global {
  interface Env {
    /** Settle idempotency window override — var (§6.8.4). */
    X402_IDEMPOTENT_WINDOW_SECONDS?: string;
    /** x402 pay-to address — Worker secret (§3.7, X402_PAY_TO). */
    X402_PAY_TO: string;
    /** CDP facilitator request-signing key pair — secrets (§6.7.5). */
    CDP_API_KEY_ID?: string;
    CDP_API_KEY_SECRET?: string;
    /** §7.8 — AES-256 key for multi-request-transaction request-state (base64). */
    MCP_REQUEST_STATE_KEY?: string;
    /** §10.8.1 — base64 of the 32-byte KEK for connector_credentials. */
    CONNECTOR_CRED_KEK?: string;
    /** §10.8.4 — Ed25519 private JWK (JSON) for outbound connector signing. */
    CONNECTOR_SIGNING_PRIVATE_KEY?: string;
  }
}
