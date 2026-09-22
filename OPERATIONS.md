# OPERATIONS.md

The M0 resource record. Every value below was **read from the live account or
database**, not copied from plan.md (GATE M0.24 asserts presence; M0.25
asserts no secret value is present).

## Supabase — musebook-prod

| Setting         | Value                  |
| --------------- | ---------------------- |
| Project ref     | `rmcgtcsfrfrjxeyxoiin` |
| Organization id | `lskgtzehnlfzimkxhwre` |
| Region          | `us-east-1`            |
| Postgres engine | `17`                   |
| Status          | `ACTIVE_HEALTHY`       |

Extensions (all in the `extensions` schema — `pg_cron` stays in `pg_catalog`):

| Extension  | Version (live) |
| ---------- | -------------- |
| vector     | 0.8.2          |
| pg_partman | 5.3.1          |
| pg_trgm    | 1.6            |
| btree_gin  | 1.3            |
| pgcrypto   | 1.3            |

`pgmq` is deliberately absent — async work is Cloudflare Queues (CF-SPINE §3).
Login role `musebook_worker` exists: `rolcanlogin=t`, `rolbypassrls=f`,
`rolsuper=f`, plus `pg_read_all_data` for the read paths.

## Cloudflare — account `e8f42c0430906e1515a2af01d5c1d2d1`

| Resource    | Value                                                           |
| ----------- | --------------------------------------------------------------- |
| Zone        | `musebook.dev` — pending creation (token scope; see DEVIATIONS) |
| Zone id     | _pending_                                                       |
| Nameservers | _pending_                                                       |

### R2 buckets (5 + sidecar)

| Bucket                  | Public surface                                                                                                         |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `musebook-public`       | `cdn.musebook.dev` (custom domain — to attach once the zone exists)                                                    |
| `musebook-paid`         | none — sealed forever                                                                                                  |
| `musebook-artifacts`    | none — sealed forever                                                                                                  |
| `musebook-uploads`      | none — presigned uploads only; lifecycle aborts incomplete multipart at 2 days; `object-create` → `musebook-r2-events` |
| `musebook-logs`         | none — Logpush destination                                                                                             |
| `musebook-postiz-media` | `media.postiz.musebook.dev` (Postiz sidecar; bound by NO wrangler.jsonc)                                               |

### Queues (14)

Seven work + seven DLQ, all §4.13.2 names: `musebook-agent-cancel`,
`musebook-classify`, `musebook-distribute`, `musebook-embed`, `musebook-media`,
`musebook-media-finalize`, `musebook-r2-events`, each + `-dlq`. Retention is
**86400 s (1 day)** — the API ceiling on this account; plan said 1209600 s
(see DEVIATIONS.md).

### KV namespaces

| Binding    | Id                                 |
| ---------- | ---------------------------------- |
| `GRANTS`   | `f7f0e81c8e1f4eb190e366714ed6b0ad` |
| `WBA_DIR`  | `0d0153516ab24ceeb3a70f0c95b86a68` |
| `OAUTH_KV` | `7daede739ca44bb98df9429bcecffb8b` |

### Hyperdrive (2 configs — ids pending, token scope)

| Binding             | Caching                                               |
| ------------------- | ----------------------------------------------------- |
| `HYPERDRIVE_CACHED` | `max_age` 60, `swr` 15 — content reads only           |
| `HYPERDRIVE_FRESH`  | disabled — every grant/quote/settlement/decision read |

### Analytics Engine datasets (materialize on first writeDataPoint)

- `musebook_telemetry`
- `musebook_paywall`

## Vercel — team `team_PYXAVq4jrHw8k0bNffmhc2jE`

- `musebook.dev` domain entry: `renew: true`.
- Vercel's domain card will read **"Invalid Configuration"** permanently: it
  resolves the apex to Cloudflare anycast IPs. Serving and certificates still
  work. Do NOT "fix" it by grey-clouding the record — that silently removes
  the Worker from the request path and takes the paywall with it.
- `origin.musebook.dev` is the break-glass DNS-only path to the Vercel origin.
  It carries no Worker route — which also means it carries no paywall.

## x402 settlement mode — production record (§16.5 M8.12)

As of **2026-09-22** production runs `X402_MODE=live` on `eip155:8453` (Base
mainnet), asset `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (USDC,
EIP-712 domain `name="USD Coin"`, `version="2"`).

The evidence that justifies `live` rather than the `shadow` fallback: the
facilitator `GET {X402_FACILITATOR_URL}/supported` — the Coinbase CDP
facilitator `https://api.cdp.coinbase.com/platform/v2/x402`, authenticated
with the CDP JWT — returns a `kinds[]` entry with `"network":"eip155:8453"`
and `"x402Version":2` (verified 2026-09-22). The preview env
(`musebook-edge-preview`) stays `X402_MODE=shadow` on `eip155:84532`
permanently — it must never settle real money.

If a future facilitator cut fails this evidence, flip prod's
`apps/edge/wrangler.jsonc` `vars.X402_MODE` to `"shadow"` and update this
record with the new date — the gate re-reads the pair and refuses a mode
that is asserted but not evidenced.
