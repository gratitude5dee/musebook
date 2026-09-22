-- 15. Reference rows. The first two are REQUIRED by spine invariant 3:
-- action_events.weights_version and .model_version are NOT NULL with FKs, and the
-- pre-ranker feed writes the literals 'none' and 'reverse_chron'.
--
-- Every id and timestamp here is a literal — G-SEED requires two consecutive
-- `supabase db reset` runs to produce byte-identical dumps, and the reference
-- rows ride along in the dump. ids live in the 00000000-… reserved block;
-- timestamps use the same SEED_EPOCH constant as supabase/seed.sql.
insert into public.ranking_weights (weights_version, cohort, weights, is_active, notes, created_at)
values ('none', 'default', '{}'::jsonb, true,
        'Placeholder for the pre-ranker reverse-chronological slate. Do not delete.',
        timestamptz '2026-09-22 12:00:00+00')
on conflict (weights_version) do nothing;

insert into public.model_registry (model_version, family, status, metrics, trained_at, created_at)
values ('reverse_chron', 'reverse_chron', 'active', '{}'::jsonb,
        timestamptz '2026-09-22 12:00:00+00', timestamptz '2026-09-22 12:00:00+00')
on conflict (model_version) do nothing;

-- The thirteen v1 scopes (section 5.7.3's ALL_SCOPES, in the same order). The
-- TypeScript tuple and these rows are the two halves of one list: section 7.6.2 serves
-- `scopes_supported` from ALL_SCOPES and the consent screen renders `description` from here.
insert into public.scopes (scope, description, requires_approval_default, is_spend_bearing, created_at)
values
  ('feed:read',            'Read ranked slates as the owner',                            false, false, timestamptz '2026-09-22 12:00:00+00'),
  ('post:read',            'Read the owner''s posts including drafts',                   false, false, timestamptz '2026-09-22 12:00:00+00'),
  ('post:write',           'Create and edit drafts',                                     false, false, timestamptz '2026-09-22 12:00:00+00'),
  ('post:publish',         'Move a draft to published, set publish_mode and price',      true,  false, timestamptz '2026-09-22 12:00:00+00'),
  ('comment:write',        'Comment as the owner',                                       true,  false, timestamptz '2026-09-22 12:00:00+00'),
  ('graph:write',          'Follow, unfollow, block, mute',                              false, false, timestamptz '2026-09-22 12:00:00+00'),
  ('media:generate',       'Invoke the media-generation providers',                      false, true,  timestamptz '2026-09-22 12:00:00+00'),
  ('channel:connect',      'Attach a social channel through Postiz',                     true,  false, timestamptz '2026-09-22 12:00:00+00'),
  ('distribution:publish', 'Trigger a Postiz fan-out',                                   true,  false, timestamptz '2026-09-22 12:00:00+00'),
  ('wallet:spend',         'Pay an x402 challenge from the owner''s balance',            true,  true,  timestamptz '2026-09-22 12:00:00+00'),
  ('profile:write',        'Edit handle, bio, avatar',                                   true,  false, timestamptz '2026-09-22 12:00:00+00'),
  ('audit:read',           'Read the owner''s own audit_log rows',                       false, false, timestamptz '2026-09-22 12:00:00+00'),
  ('analytics:read',       'Read the owner''s post and channel performance aggregates',  false, false, timestamptz '2026-09-22 12:00:00+00')
on conflict (scope) do nothing;

-- The six bootstrap verified crawlers. Section 6.11's VERIFIED_CRAWLERS constant is the
-- FCrDNS matcher; these are the identity rows its `agentSlug` values resolve to, so a
-- crawl event has an agent_identities row to point at on the very first request
-- (action_events_plane_actor requires one on the agent plane).
insert into public.agent_identities
  (id, slug, display_name, verification, user_agent_pattern, first_seen_at, created_at, updated_at)
values
  ('00000000-0000-4000-8000-000000000001', 'gptbot',        'OpenAI GPTBot',        'verified_crawler', 'GPTBot',        timestamptz '2026-09-22 12:00:00+00', timestamptz '2026-09-22 12:00:00+00', timestamptz '2026-09-22 12:00:00+00'),
  ('00000000-0000-4000-8000-000000000002', 'oai-searchbot', 'OpenAI OAI-SearchBot', 'verified_crawler', 'OAI-SearchBot', timestamptz '2026-09-22 12:00:00+00', timestamptz '2026-09-22 12:00:00+00', timestamptz '2026-09-22 12:00:00+00'),
  ('00000000-0000-4000-8000-000000000003', 'claudebot',     'Anthropic ClaudeBot',  'verified_crawler', 'ClaudeBot',     timestamptz '2026-09-22 12:00:00+00', timestamptz '2026-09-22 12:00:00+00', timestamptz '2026-09-22 12:00:00+00'),
  ('00000000-0000-4000-8000-000000000004', 'perplexitybot', 'PerplexityBot',        'verified_crawler', 'PerplexityBot', timestamptz '2026-09-22 12:00:00+00', timestamptz '2026-09-22 12:00:00+00', timestamptz '2026-09-22 12:00:00+00'),
  ('00000000-0000-4000-8000-000000000005', 'googlebot',     'Googlebot',            'verified_crawler', 'Googlebot',     timestamptz '2026-09-22 12:00:00+00', timestamptz '2026-09-22 12:00:00+00', timestamptz '2026-09-22 12:00:00+00'),
  ('00000000-0000-4000-8000-000000000006', 'bingbot',       'bingbot',              'verified_crawler', 'bingbot',       timestamptz '2026-09-22 12:00:00+00', timestamptz '2026-09-22 12:00:00+00', timestamptz '2026-09-22 12:00:00+00')
on conflict (slug) do nothing;

-- The fallback identity for an MCP caller that sent no identifying information
-- (section 7.9, resolution step 4). Seeded rather than created lazily so the first
-- event of a cold deployment cannot fail on the plane/actor check constraint.
insert into public.agent_identities
  (id, slug, display_name, verification, first_seen_at, created_at, updated_at)
values ('00000000-0000-4000-8000-000000000007', 'anonymous-mcp', 'Unidentified MCP client', 'none',
        timestamptz '2026-09-22 12:00:00+00', timestamptz '2026-09-22 12:00:00+00', timestamptz '2026-09-22 12:00:00+00')
on conflict (slug) do nothing;

-- The platform-wide fallback price, one row. USDC on Base mainnet:
-- 0x833589fcd6edb6e08f4c7c32d4f71b54bda02913, 6 decimals (verified 2026-09-21).
-- $0.25 per human unlock, $0.002 per agent crawl — section 18's open question B1 may
-- move both numbers, and moving them is an UPDATE of this one row, not a deploy.
insert into public.platform_publishing_defaults
  (id, read_price_atomic, crawl_price_atomic, price_asset, price_network, updated_at)
values (true, 250000, 2000, '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', 'eip155:8453',
        timestamptz '2026-09-22 12:00:00+00')
on conflict (id) do nothing;

-- The first-party connector. Musebook's own web UI is not a third-party agent, but a
-- human generating media from the composer still spends through the same two-phase
-- functions, so section 11.5 gives them a synthetic delegation whose connector_id points
-- here. One spend code path, not two.
insert into public.connectors
  (id, slug, display_name, vendor, transport, auth_kind, manifest, default_scopes,
   is_verified, is_enabled, created_at, updated_at)
values ('00000000-0000-4000-8000-000000000101', 'first_party', 'Musebook (first party)', 'musebook', 'bridge_token', 'none',
        '{"capabilities":["media.generate","post"],"description":"Musebook''s own web UI; not a remote agent."}'::jsonb,
        array['media:generate','post:write','post:publish'],
        true, true, timestamptz '2026-09-22 12:00:00+00', timestamptz '2026-09-22 12:00:00+00')
on conflict (slug) do nothing;

-- No platforms rows here. They are production data with a provenance column and are
-- inserted by section 12's 20260922091901_platform_seed.sql at M10, each row carrying
-- limits_source and limits_checked_at from a verified source (Postiz v1.47.0's
-- enforcement code or the platform's own spec). Rows for local development live in
-- supabase/seed.sql (section 17.3), which is never applied to production.
