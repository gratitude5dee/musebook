# Musebook

An agentic media platform at [musebook.dev](https://musebook.dev).

Compose once. Musebook classifies it, ranks it into personalized feeds, fans it out to every
platform reformatted per-platform, serves humans a page and agents MCP tools plus `.md`/`.json`
twins, and prices agent access with x402.

**[plan.md](./plan.md) is the implementation plan** — 18 sections, written to be executed
end to end by an autonomous coding agent. Start at section 1 (scope and the MVP cut line),
then section 16 (build order and acceptance gates).

## Status

Pre-implementation. The plan is complete and internally verified; no application code exists yet.

## Owner decisions already made

- **Music and video verticals survive** as their own TikTok-style vertical feed.
- **Base mainnet USDC at launch** (EIP-712 domain name `"USD Coin"`, not `"USDC"`).
- **Syndicated per-platform variants are full ports**, not teasers.
- **A new Supabase project** — the legacy `wzrdstudio` database is shared with a dozen unrelated
  apps and its migration chain is unreplayable.

## Reference

`skills/x-for-you-algorithm/` is a vendored reference skill for X's open-sourced For You
algorithm, used by section 9. Note that it has drifted from the live `xai-org/x-algorithm`
repo in several load-bearing ways — section 9 documents which.
