# Planning artifacts

These are the inputs that produced `plan.md`. They are kept in the repo because the plan cites them,
and because an implementer who disagrees with a decision should be able to see what it was based on.

| File | What it is |
|---|---|
| `SPINE.md` | The original architectural spine — nine invariants, the two-function kernel, `content_hash` as universal key, candidate isolation. Still binding except where `CF-SPINE.md` supersedes it. |
| `CF-SPINE.md` | The Cloudflare spine. 14 binding decisions covering DNS, Hyperdrive, Queues, R2, x402 on Workers, bot classification, MCP, telemetry and cost. Supersedes `SPINE.md` on conflict. |
| `MIGRATION.md` | The zero-migration ruling, with the measured contents of the legacy database that justify it. |
| `VERIFIED-FACTS-core.md` | Ten claims checked against primary sources on 2026-09-21 — Next.js, MCP revision, x402 wire format, USDC EIP-712 domain, thirdweb, Postiz, Typesafe, Supabase, bot detection. |
| `VERIFIED-FACTS-cloudflare.md` | Ten Cloudflare-specific verifications — Hyperdrive/Supabase, R2 gating, Queues vs pgmq, Web Bot Auth, pay-per-crawl, x402 on Workers, Vercel behind Cloudflare, the Workers runtime, MCP on Workers, observability and cost. |

**Precedence when two documents disagree:** the verified-facts files beat the spines, the spines beat
`plan.md`, and `CF-SPINE.md` beats `SPINE.md`. Anything marked **UNVERIFIED** in the plan was not
confirmable from a primary source in the authoring environment — check it before relying on it.

Several sources were unreachable behind the authoring environment's egress proxy
(`docs.typesafe.ai`, `muse.ai`, `modelcontextprotocol.io`, `developers.cloudflare.com`,
`vercel.com`, `blog.cloudflare.com`). Where a fact came from a published npm tarball, a spec
repository or a vendor documentation API instead of the official page, the verified-facts file says so.
