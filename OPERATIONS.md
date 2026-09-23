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

| Resource    | Value                                                  |
| ----------- | ------------------------------------------------------ |
| Zone        | `musebook.dev` — status `active` (verified 2026-09-23) |
| Zone id     | `3e9ee9b3d7984d4482f62d7bc323cbf7`                     |
| Nameservers | `aria.ns.cloudflare.com`, `coen.ns.cloudflare.com`     |
| SSL         | `strict` (zone settings, live read)                    |
| Zone type   | `full`                                                 |

### R2 buckets (5 + sidecar)

| Bucket                  | Public surface                                                                                                             |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `musebook-public`       | `cdn.musebook.dev` (custom domain, enabled, ssl `active` — only custom domain on any Musebook bucket, verified 2026-09-23) |
| `musebook-paid`         | none — sealed forever                                                                                                      |
| `musebook-artifacts`    | none — sealed forever                                                                                                      |
| `musebook-uploads`      | none — presigned uploads only; lifecycle aborts incomplete multipart at 2 days; `object-create` → `musebook-r2-events`     |
| `musebook-logs`         | none — Logpush destination                                                                                                 |
| `musebook-postiz-media` | `media.postiz.musebook.dev` (Postiz sidecar; bound by NO wrangler.jsonc)                                                   |

The four other buckets (`paid`, `artifacts`, `uploads`, `logs`) verified
2026-09-23: zero custom domains — `G-R2-SEAL` stands.

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

### Hyperdrive (2 configs)

| Binding             | Config id (live, verified 2026-09-23)                      | Caching                                               |
| ------------------- | ---------------------------------------------------------- | ----------------------------------------------------- |
| `HYPERDRIVE_CACHED` | `48c4c1c7cc734a8cb4031bd546160eae` (`musebook-prod`)       | `max_age` 60, `swr` 15 — content reads only           |
| `HYPERDRIVE_FRESH`  | `5288b46cce7340438e840e1d0daeb23d` (`musebook-prod-fresh`) | disabled — every grant/quote/settlement/decision read |

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

## Cost controls — production record (§16.6 M11)

Four containment levers, kept as account state rather than code:

- **KV killswitch** — `GRANTS` key `killswitch.agents` on the
  `musebook-edge` KV namespace. Value `"on"` sheds unauthenticated agent
  traffic (no cookie, non-browser UA, no signature/authorization headers)
  with a 503 `agent_shed` before any other work; humans and signed agents
  pass. Read every request with `cacheTtl: 300`. Set/reset:
  `wrangler kv key put --binding GRANTS killswitch.agents '"on"'`
- **Cloudflare budget alerts** — `budget-2x` and `budget-4x` created
  2026-09-23 via `alerting/v3` (`billing_budget_alert`,
  `total_spend_dollars` 10 / 20 → `gratitude@5-dee.com`). The plan's
  `billing_usage_alert` name is the usage-units sibling; the dollar-
  threshold type is the one that matches "2×/4× the modelled spend".
- **Agent rate limit** — `musebook-agent-rate-limit` ruleset created
  2026-09-23 (`d4f4ef0b…`, `http_ratelimit`, zone). Free-plan shape: one
  rule per phase, `period:10`, `mitigation_timeout:10` — so the plan's
  600 req/min on `/api/events` ships as 100 req/10s, keyed
  `cf.colo.id + ip.src` (`cf.ja4_fingerprint` needs Enterprise Bot
  Management).
- **Worker trace logs** — `logpush: true` in all three wrangler configs +
  `musebook-logs` 30-day expiry (`expire-30d`). The
  `musebook-worker-traces` Logpush job itself is **pending**: this
  account's plan has zero `workers_trace_events` job slots (API
  `1004: exceeded max jobs allowed`) — creating it needs Workers Paid
  ($5/mo). Destination is ready: `r2://musebook-logs/workers/{DATE}`
  with the account-scoped R2 key pair.

## Attestations — human-verified records

Gate checks whose fact is unobservable through this zone tier's API
resolve against a dated record here, written only after the fact was
verified by eye. A check whose API _can_ observe the fact never reads
this section, so these lines can never mask a live drift.

- attested ppc-fence 2026-09-23 — no pay-per-crawl endpoint exists on
  this zone's API (`/zones/{id}/{ai_crawl,aibot,ppc,pay_per_crawl,
ai_crawl_control}` all non-200; the config-rule field is rejected by
  `http_config_settings` — closed beta), and zone-level
  `pay_per_crawl.enabled` reads `false` via API. Recorded by probe, not
  by eye.
- attested bot-management 2026-09-23 — Security → Bots on `musebook.dev` (Free zone): Super Bot Fight Mode OFF, AI Crawl Control Agent=allow, Search=allow. Verified by the account owner; the `bot_management` endpoint is unreadable on this zone tier, so this line is the record the gate substitutes.
- **Vercel spend limit** — dashboard-only control on team `5dee-studios`
  (Settings → Billing → Spend Management): a monthly spend cap that
  pauses deployments when hit. Covers the `musebook-web` project's
  build/function usage; no API exists to assert it, so this note is the
  record.

## Launch-hardening drills — M12 record

The drills §16.6 requires. A drill that needs a live deployment is marked
**pending** rather than fabricated; the gate check reports `BLOCK` on the same
items until the record exists.

| Drill                                                   | Status                                                                                                                              | What proves it                                                                                                                       |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Origin-secret rotation (PREVIOUS-first order, O7 §3.11) | **pending — needs live Vercel origin**                                                                                              | Set `MUSEBOOK_EDGE_SECRET_PREVIOUS`, rotate current, confirm no 404s, record elapsed.                                                |
| Kill-switch flip (GRANTS `killswitch.agents`)           | **pending — needs live traffic**                                                                                                    | Flip on: unauth-agent 503, human session + paying agent pass; flip off; record elapsed.                                              |
| Synthetic-402 failure path (broken price for one run)   | **pending — needs live probe**                                                                                                      | Point `SYNTHETIC_GATED_SLUG` at a deliberately broken price for one alert pass; assert `edge.gate_bypassable:no_402` pages; restore. |
| Nightly suite ×2 consecutive green                      | **pending — needs deploy secrets in Actions**                                                                                       | Two dated green `nightly` workflow runs recorded here.                                                                               |
| Feed p95 baseline (M13.4 reference)                     | **1.7 ms** (local `app.read_slate_doc` as `musebook_worker`, n=40 — the request path's one select, byte-for-byte the M12 code path) | Live `/api/feed/*` p95 recorded at first production deploy; the local bound (§16.7 M13.4) is 250 ms.                                 |

Probe evidence lane: the scheduled A27 pass counts its own successes —
`musebook.synthetic_402.gate` / `musebook.synthetic_402.origin_closed` in
`ops_counters` are the queryable record that the 402 check is firing (M12.4).

Deployment order (proven by `.github/workflows/deploy.yml`, §3.6.2): Vercel
`musebook-web` first, then `wrangler deploy` for `musebook-mcp` and
`musebook-worker`, and `musebook-edge` **last** — after `pnpm gate --check
r2-seal` re-verifies the sealed buckets. A failed earlier job never reaches
edge, so a half-deploy never exposes an origin the edge isn't covering.
