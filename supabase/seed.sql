-- supabase/seed.sql
-- DETERMINISTIC. Every id is a literal, every timestamp derives from SEED_EPOCH,
-- no gen_random_uuid(), no now(), no random(), no network call.
-- SYNTHETIC. Nothing here came from the legacy Supabase project; zero rows are migrated
-- (MIGRATION ruling, 2026-09-21) and there is no ETL script to have produced any.
-- Re-runnable: `supabase db reset` replays this file after the migration chain
-- (§4.17's fifteen files at M2; §16.8 is the registry of every later one).
-- Gate G-SEED asserts that two consecutive resets produce an identical ordered dump.

begin;

-- One clock for the whole file. It MUST fall inside the bootstrap partitions created
-- by 20260922090800_action_events.sql (2026-09-22 .. 2026-09-23), or every
-- action_events insert fails with "no partition of relation ... found for row".
create temporary table seed_const as
  select timestamptz '2026-09-22 12:00:00+00' as epoch;

-- ── identity ──────────────────────────────────────────────────────────────
insert into public.users (id, email, email_verified_at, country_code, tos_accepted_at,
                          analytics_consent, created_at, updated_at)
select v.id, v.email, c.epoch, 'US'::char(2), c.epoch, true, c.epoch, c.epoch
from (values
  ('11111111-1111-4111-8111-000000000001'::uuid, 'creator@seed.musebook.dev'),
  ('11111111-1111-4111-8111-000000000002'::uuid, 'reader@seed.musebook.dev'),
  ('11111111-1111-4111-8111-000000000003'::uuid, 'agentowner@seed.musebook.dev'),
  ('11111111-1111-4111-8111-000000000004'::uuid, 'blocked@seed.musebook.dev'),
  ('11111111-1111-4111-8111-000000000005'::uuid, 'isolated@seed.musebook.dev')
) as v(id, email),
     seed_const c
on conflict (id) do nothing;

insert into public.profiles (user_id, handle, display_name, bio, is_verified, created_at, updated_at)
select v.id, v.handle, v.display_name, v.bio, v.verified, c.epoch, c.epoch
from (values
  ('11111111-1111-4111-8111-000000000001'::uuid, 'seed_creator',  'Seed Creator',  'Publishes in all three modes.', true),
  ('11111111-1111-4111-8111-000000000002'::uuid, 'seed_reader',   'Seed Reader',   'Follows two people.',           false),
  ('11111111-1111-4111-8111-000000000003'::uuid, 'seed_agentown', 'Seed AgentOwner','Owns one delegated agent.',    false),
  ('11111111-1111-4111-8111-000000000004'::uuid, 'seed_blocked',  'Seed Blocked',  'Blocked by seed_creator.',      false),
  ('11111111-1111-4111-8111-000000000005'::uuid, 'seed_isolated', 'Seed Isolated', 'Degree zero. Cold-start case.', false)
) as v(id, handle, display_name, bio, verified),
     seed_const c
on conflict (user_id) do nothing;

-- Three wallets, one primary each. Lowercase hex — app.is_evm_address requires
-- '^0x[0-9a-f]{40}$' (the check predates EIP-55 casing support).
insert into public.wallets (id, user_id, address, is_primary, verified_at, created_at)
select v.id, v.uid, v.addr, true, c.epoch, c.epoch
from (values
  ('22222222-2222-4222-8222-000000000001'::uuid, '11111111-1111-4111-8111-000000000001'::uuid, '0x2222222222222222222222222222222222222222'),
  ('22222222-2222-4222-8222-000000000002'::uuid, '11111111-1111-4111-8111-000000000002'::uuid, '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
  ('22222222-2222-4222-8222-000000000003'::uuid, '11111111-1111-4111-8111-000000000003'::uuid, '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
) as v(id, uid, addr),
     seed_const c
on conflict (id) do nothing;

-- Two agent identities: one owner-delegated (bound to u-agent-owner), one
-- web_bot_auth crawler carrying the kernel AGENT fixture's directoryKeyid.
insert into public.agent_identities
  (id, slug, display_name, owner_user_id, wallet_address, verification,
   signature_agent, directory_url, directory_keyid, user_agent_pattern,
   first_seen_at, last_seen_at, is_blocked, created_at, updated_at)
select v.id, v.slug, v.name, v.owner, v.wallet, v.verif::agent_verification,
       v.sig_agent, v.dir_url, v.dir_keyid, v.ua, c.epoch, c.epoch, false, c.epoch, c.epoch
from (values
  ('33333333-3333-4333-8333-000000000001'::uuid, 'seed-delegated-agent', 'Seed Delegated Agent',
   '11111111-1111-4111-8111-000000000003'::uuid, '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
   'owner_delegated', null, null, null, null),
  ('33333333-3333-4333-8333-000000000002'::uuid, 'seed-crawler', 'Seed Crawler',
   null::uuid, '0x3333333333333333333333333333333333333333',
   'web_bot_auth', 'https://agent.example/.well-known/http-message-signatures-directory',
   'https://agent.example', 'mb-seed-crawler#key-1', 'SeedCrawler/1.0')
) as v(id, slug, name, owner, wallet, verif, sig_agent, dir_url, dir_keyid, ua),
     seed_const c
on conflict (id) do nothing;

-- §4.4: the row that seeds a new post's licence columns at compose time.
insert into public.creator_publishing_defaults
  (user_id, publish_mode, license_spdx, train_ai, ai_use, price_cents, updated_at)
select '11111111-1111-4111-8111-000000000001'::uuid,
       'free'::publish_mode, 'CC-BY-4.0', false, false, 200, c.epoch
from seed_const c
on conflict (user_id) do nothing;

-- ── content ───────────────────────────────────────────────────────────────
-- Bodies are content-addressed; the hash is COMPUTED, never typed.
-- post_bodies_hash_matches CHECK rejects any disagreement, which is the safety net.
-- 25 rows: one per post plus the second version of the x402_always article
-- (the "grant does not survive an edit" before/after pair).
insert into public.post_bodies (content_hash, canonical_markdown, byte_len, created_at)
select app.sha256_hex(v.md), v.md, octet_length(v.md), c.epoch
from (values
  ($$# Seed Note (Free)

A `note` post published in `free` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$),
  ($$# Seed Note (HFAP)

A `note` post published in `human_free_agent_paid` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$),
  ($$# Seed Note (X402)

A `note` post published in `x402_always` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$),
  ($$# Seed Article (Free)

A `article` post published in `free` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$),
  ($$# Seed Article (HFAP)

A `article` post published in `human_free_agent_paid` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$),
  ($$# Seed Article (X402)

A `article` post published in `x402_always` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$),
  ($$# Seed Image (Free)

A `image` post published in `free` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$),
  ($$# Seed Image (HFAP)

A `image` post published in `human_free_agent_paid` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$),
  ($$# Seed Image (X402)

A `image` post published in `x402_always` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$),
  ($$# Seed Video (Free)

A `video` post published in `free` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$),
  ($$# Seed Video (HFAP)

A `video` post published in `human_free_agent_paid` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$),
  ($$# Seed Video (X402)

A `video` post published in `x402_always` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$),
  ($$# Seed Audio (Free)

A `audio` post published in `free` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$),
  ($$# Seed Audio (HFAP)

A `audio` post published in `human_free_agent_paid` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$),
  ($$# Seed Audio (X402)

A `audio` post published in `x402_always` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$),
  ($$# Seed App (Free)

A `app` post published in `free` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$),
  ($$# Seed App (HFAP)

A `app` post published in `human_free_agent_paid` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$),
  ($$# Seed App (X402)

A `app` post published in `x402_always` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$),
  ($$# Seed Model3D (Free)

A `model3d` post published in `free` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$),
  ($$# Seed Model3D (HFAP)

A `model3d` post published in `human_free_agent_paid` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$),
  ($$# Seed Model3D (X402)

A `model3d` post published in `x402_always` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$),
  ($$# Seed Thread (Free)

A `thread` post published in `free` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$),
  ($$# Seed Thread (HFAP)

A `thread` post published in `human_free_agent_paid` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$),
  ($$# Seed Thread (X402)

A `thread` post published in `x402_always` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$),
  ($$# Seed Article (X402)

A `article` post published in `x402_always` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.



Second version — edited after the grant was minted.
MUSEBOOK_PAID_BODY_MARKER_7f3a$$)
) as v(md), seed_const c
on conflict (content_hash) do nothing;
insert into public.posts
  (id, author_user_id, kind, status, publish_mode, slug, title, summary,
   canonical_url, language_code, tags, content_hash, current_version,
   price_atomic, price_asset, price_network,
   license_spdx, license_url, train_ai, ai_use, search_indexable,
   attribution_required, citation_template, published_at, created_at, updated_at)
select v.id, '11111111-1111-4111-8111-000000000001'::uuid, v.kind::post_kind,
       'published'::post_status, v.mode::publish_mode, v.slug, v.title, v.summary,
       'https://musebook.dev/p/' || v.slug, 'en', v.tags::text[], v.chash,
       v.cv, v.price::numeric,
       case when v.price > 0 then '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' end,
       case when v.price > 0 then 'eip155:8453' end,
       v.spdx, case when v.spdx = 'ARR' then null
                    else 'https://creativecommons.org/licenses/by/4.0/' end,
       false, false, true, true,
       case when v.spdx = 'ARR'
            then 'Cite as: Seed Creator, "' || v.title || '", musebook.dev — all rights reserved.' end,
       c.epoch, c.epoch, c.epoch
from (values
  ('44444444-4444-4444-8444-000000000001'::uuid, 'note', 'free', 'seed-note-free', 'Seed Note (Free)', 'Seed note in free mode.', '{seed,note}', app.sha256_hex($$# Seed Note (Free)

A `note` post published in `free` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$), 1, 0, 'CC-BY-4.0'),
  ('44444444-4444-4444-8444-000000000002'::uuid, 'note', 'human_free_agent_paid', 'seed-note-hfap', 'Seed Note (HFAP)', 'Seed note in human_free_agent_paid mode.', '{seed,note}', app.sha256_hex($$# Seed Note (HFAP)

A `note` post published in `human_free_agent_paid` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$), 1, 2000, 'CC-BY-4.0'),
  ('44444444-4444-4444-8444-000000000003'::uuid, 'note', 'x402_always', 'seed-note-x402', 'Seed Note (X402)', 'Seed note in x402_always mode.', '{seed,note}', app.sha256_hex($$# Seed Note (X402)

A `note` post published in `x402_always` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$), 1, 2000, 'CC-BY-4.0'),
  ('44444444-4444-4444-8444-000000000004'::uuid, 'article', 'free', 'seed-article-free', 'Seed Article (Free)', 'Seed article in free mode.', '{seed,article}', app.sha256_hex($$# Seed Article (Free)

A `article` post published in `free` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$), 1, 0, 'ARR'),
  ('44444444-4444-4444-8444-000000000005'::uuid, 'article', 'human_free_agent_paid', 'seed-article-hfap', 'Seed Article (HFAP)', 'Seed article in human_free_agent_paid mode.', '{seed,article}', app.sha256_hex($$# Seed Article (HFAP)

A `article` post published in `human_free_agent_paid` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$), 1, 2000, 'ARR'),
  ('44444444-4444-4444-8444-000000000006'::uuid, 'article', 'x402_always', 'seed-article-x402', 'Seed Article (X402)', 'Seed article in x402_always mode.', '{seed,article}', app.sha256_hex($$# Seed Article (X402)

A `article` post published in `x402_always` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$), 2, 2000, 'ARR'),
  ('44444444-4444-4444-8444-000000000007'::uuid, 'image', 'free', 'seed-image-free', 'Seed Image (Free)', 'Seed image in free mode.', '{seed,image}', app.sha256_hex($$# Seed Image (Free)

A `image` post published in `free` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$), 1, 0, 'CC-BY-4.0'),
  ('44444444-4444-4444-8444-000000000008'::uuid, 'image', 'human_free_agent_paid', 'seed-image-hfap', 'Seed Image (HFAP)', 'Seed image in human_free_agent_paid mode.', '{seed,image}', app.sha256_hex($$# Seed Image (HFAP)

A `image` post published in `human_free_agent_paid` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$), 1, 2000, 'CC-BY-4.0'),
  ('44444444-4444-4444-8444-000000000009'::uuid, 'image', 'x402_always', 'seed-image-x402', 'Seed Image (X402)', 'Seed image in x402_always mode.', '{seed,image}', app.sha256_hex($$# Seed Image (X402)

A `image` post published in `x402_always` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$), 1, 2000, 'CC-BY-4.0'),
  ('44444444-4444-4444-8444-00000000000a'::uuid, 'video', 'free', 'seed-video-free', 'Seed Video (Free)', 'Seed video in free mode.', '{seed,video}', app.sha256_hex($$# Seed Video (Free)

A `video` post published in `free` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$), 1, 0, 'CC-BY-4.0'),
  ('44444444-4444-4444-8444-00000000000b'::uuid, 'video', 'human_free_agent_paid', 'seed-video-hfap', 'Seed Video (HFAP)', 'Seed video in human_free_agent_paid mode.', '{seed,video}', app.sha256_hex($$# Seed Video (HFAP)

A `video` post published in `human_free_agent_paid` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$), 1, 2000, 'CC-BY-4.0'),
  ('44444444-4444-4444-8444-00000000000c'::uuid, 'video', 'x402_always', 'seed-video-x402', 'Seed Video (X402)', 'Seed video in x402_always mode.', '{seed,video}', app.sha256_hex($$# Seed Video (X402)

A `video` post published in `x402_always` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$), 1, 2000, 'CC-BY-4.0'),
  ('44444444-4444-4444-8444-00000000000d'::uuid, 'audio', 'free', 'seed-audio-free', 'Seed Audio (Free)', 'Seed audio in free mode.', '{seed,audio}', app.sha256_hex($$# Seed Audio (Free)

A `audio` post published in `free` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$), 1, 0, 'CC-BY-4.0'),
  ('44444444-4444-4444-8444-00000000000e'::uuid, 'audio', 'human_free_agent_paid', 'seed-audio-hfap', 'Seed Audio (HFAP)', 'Seed audio in human_free_agent_paid mode.', '{seed,audio}', app.sha256_hex($$# Seed Audio (HFAP)

A `audio` post published in `human_free_agent_paid` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$), 1, 2000, 'CC-BY-4.0'),
  ('44444444-4444-4444-8444-00000000000f'::uuid, 'audio', 'x402_always', 'seed-audio-x402', 'Seed Audio (X402)', 'Seed audio in x402_always mode.', '{seed,audio}', app.sha256_hex($$# Seed Audio (X402)

A `audio` post published in `x402_always` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$), 1, 2000, 'CC-BY-4.0'),
  ('44444444-4444-4444-8444-000000000010'::uuid, 'app', 'free', 'seed-app-free', 'Seed App (Free)', 'Seed app in free mode.', '{seed,app}', app.sha256_hex($$# Seed App (Free)

A `app` post published in `free` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$), 1, 0, 'CC-BY-4.0'),
  ('44444444-4444-4444-8444-000000000011'::uuid, 'app', 'human_free_agent_paid', 'seed-app-hfap', 'Seed App (HFAP)', 'Seed app in human_free_agent_paid mode.', '{seed,app}', app.sha256_hex($$# Seed App (HFAP)

A `app` post published in `human_free_agent_paid` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$), 1, 2000, 'CC-BY-4.0'),
  ('44444444-4444-4444-8444-000000000012'::uuid, 'app', 'x402_always', 'seed-app-x402', 'Seed App (X402)', 'Seed app in x402_always mode.', '{seed,app}', app.sha256_hex($$# Seed App (X402)

A `app` post published in `x402_always` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$), 1, 2000, 'CC-BY-4.0'),
  ('44444444-4444-4444-8444-000000000013'::uuid, 'model3d', 'free', 'seed-model3d-free', 'Seed Model3D (Free)', 'Seed model3d in free mode.', '{seed,model3d}', app.sha256_hex($$# Seed Model3D (Free)

A `model3d` post published in `free` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$), 1, 0, 'CC-BY-4.0'),
  ('44444444-4444-4444-8444-000000000014'::uuid, 'model3d', 'human_free_agent_paid', 'seed-model3d-hfap', 'Seed Model3D (HFAP)', 'Seed model3d in human_free_agent_paid mode.', '{seed,model3d}', app.sha256_hex($$# Seed Model3D (HFAP)

A `model3d` post published in `human_free_agent_paid` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$), 1, 2000, 'CC-BY-4.0'),
  ('44444444-4444-4444-8444-000000000015'::uuid, 'model3d', 'x402_always', 'seed-model3d-x402', 'Seed Model3D (X402)', 'Seed model3d in x402_always mode.', '{seed,model3d}', app.sha256_hex($$# Seed Model3D (X402)

A `model3d` post published in `x402_always` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$), 1, 2000, 'CC-BY-4.0'),
  ('44444444-4444-4444-8444-000000000016'::uuid, 'thread', 'free', 'seed-thread-free', 'Seed Thread (Free)', 'Seed thread in free mode.', '{seed,thread}', app.sha256_hex($$# Seed Thread (Free)

A `thread` post published in `free` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$), 1, 0, 'CC-BY-4.0'),
  ('44444444-4444-4444-8444-000000000017'::uuid, 'thread', 'human_free_agent_paid', 'seed-thread-hfap', 'Seed Thread (HFAP)', 'Seed thread in human_free_agent_paid mode.', '{seed,thread}', app.sha256_hex($$# Seed Thread (HFAP)

A `thread` post published in `human_free_agent_paid` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$), 1, 2000, 'CC-BY-4.0'),
  ('44444444-4444-4444-8444-000000000018'::uuid, 'thread', 'x402_always', 'seed-thread-x402', 'Seed Thread (X402)', 'Seed thread in x402_always mode.', '{seed,thread}', app.sha256_hex($$# Seed Thread (X402)

A `thread` post published in `x402_always` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$), 1, 2000, 'CC-BY-4.0')
) as v(id, kind, mode, slug, title, summary, tags, chash, cv, price, spdx),
     seed_const c
on conflict (id) do nothing;
insert into public.post_versions
  (id, post_id, version, content_hash, title, summary, editor_user_id, change_note, created_at)
select v.id, v.post_id, v.version, v.chash, v.title, v.summary,
       '11111111-1111-4111-8111-000000000001'::uuid, v.note, c.epoch
from (values
  ('55555555-5555-4555-8555-000000000001'::uuid, '44444444-4444-4444-8444-000000000001'::uuid, 1, app.sha256_hex($$# Seed Note (Free)

A `note` post published in `free` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$), 'Seed Note (Free)', null, 'initial publish'),
  ('55555555-5555-4555-8555-000000000002'::uuid, '44444444-4444-4444-8444-000000000002'::uuid, 1, app.sha256_hex($$# Seed Note (HFAP)

A `note` post published in `human_free_agent_paid` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$), 'Seed Note (HFAP)', null, 'initial publish'),
  ('55555555-5555-4555-8555-000000000003'::uuid, '44444444-4444-4444-8444-000000000003'::uuid, 1, app.sha256_hex($$# Seed Note (X402)

A `note` post published in `x402_always` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$), 'Seed Note (X402)', null, 'initial publish'),
  ('55555555-5555-4555-8555-000000000004'::uuid, '44444444-4444-4444-8444-000000000004'::uuid, 1, app.sha256_hex($$# Seed Article (Free)

A `article` post published in `free` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$), 'Seed Article (Free)', null, 'initial publish'),
  ('55555555-5555-4555-8555-000000000005'::uuid, '44444444-4444-4444-8444-000000000005'::uuid, 1, app.sha256_hex($$# Seed Article (HFAP)

A `article` post published in `human_free_agent_paid` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$), 'Seed Article (HFAP)', null, 'initial publish'),
  ('55555555-5555-4555-8555-000000000006'::uuid, '44444444-4444-4444-8444-000000000006'::uuid, 1, app.sha256_hex($$# Seed Article (X402)

A `article` post published in `x402_always` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$), 'Seed Article (X402)', null, 'initial publish'),
  ('55555555-5555-4555-8555-000000000007'::uuid, '44444444-4444-4444-8444-000000000007'::uuid, 1, app.sha256_hex($$# Seed Image (Free)

A `image` post published in `free` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$), 'Seed Image (Free)', null, 'initial publish'),
  ('55555555-5555-4555-8555-000000000008'::uuid, '44444444-4444-4444-8444-000000000008'::uuid, 1, app.sha256_hex($$# Seed Image (HFAP)

A `image` post published in `human_free_agent_paid` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$), 'Seed Image (HFAP)', null, 'initial publish'),
  ('55555555-5555-4555-8555-000000000009'::uuid, '44444444-4444-4444-8444-000000000009'::uuid, 1, app.sha256_hex($$# Seed Image (X402)

A `image` post published in `x402_always` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$), 'Seed Image (X402)', null, 'initial publish'),
  ('55555555-5555-4555-8555-00000000000a'::uuid, '44444444-4444-4444-8444-00000000000a'::uuid, 1, app.sha256_hex($$# Seed Video (Free)

A `video` post published in `free` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$), 'Seed Video (Free)', null, 'initial publish'),
  ('55555555-5555-4555-8555-00000000000b'::uuid, '44444444-4444-4444-8444-00000000000b'::uuid, 1, app.sha256_hex($$# Seed Video (HFAP)

A `video` post published in `human_free_agent_paid` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$), 'Seed Video (HFAP)', null, 'initial publish'),
  ('55555555-5555-4555-8555-00000000000c'::uuid, '44444444-4444-4444-8444-00000000000c'::uuid, 1, app.sha256_hex($$# Seed Video (X402)

A `video` post published in `x402_always` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$), 'Seed Video (X402)', null, 'initial publish'),
  ('55555555-5555-4555-8555-00000000000d'::uuid, '44444444-4444-4444-8444-00000000000d'::uuid, 1, app.sha256_hex($$# Seed Audio (Free)

A `audio` post published in `free` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$), 'Seed Audio (Free)', null, 'initial publish'),
  ('55555555-5555-4555-8555-00000000000e'::uuid, '44444444-4444-4444-8444-00000000000e'::uuid, 1, app.sha256_hex($$# Seed Audio (HFAP)

A `audio` post published in `human_free_agent_paid` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$), 'Seed Audio (HFAP)', null, 'initial publish'),
  ('55555555-5555-4555-8555-00000000000f'::uuid, '44444444-4444-4444-8444-00000000000f'::uuid, 1, app.sha256_hex($$# Seed Audio (X402)

A `audio` post published in `x402_always` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$), 'Seed Audio (X402)', null, 'initial publish'),
  ('55555555-5555-4555-8555-000000000010'::uuid, '44444444-4444-4444-8444-000000000010'::uuid, 1, app.sha256_hex($$# Seed App (Free)

A `app` post published in `free` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$), 'Seed App (Free)', null, 'initial publish'),
  ('55555555-5555-4555-8555-000000000011'::uuid, '44444444-4444-4444-8444-000000000011'::uuid, 1, app.sha256_hex($$# Seed App (HFAP)

A `app` post published in `human_free_agent_paid` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$), 'Seed App (HFAP)', null, 'initial publish'),
  ('55555555-5555-4555-8555-000000000012'::uuid, '44444444-4444-4444-8444-000000000012'::uuid, 1, app.sha256_hex($$# Seed App (X402)

A `app` post published in `x402_always` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$), 'Seed App (X402)', null, 'initial publish'),
  ('55555555-5555-4555-8555-000000000013'::uuid, '44444444-4444-4444-8444-000000000013'::uuid, 1, app.sha256_hex($$# Seed Model3D (Free)

A `model3d` post published in `free` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$), 'Seed Model3D (Free)', null, 'initial publish'),
  ('55555555-5555-4555-8555-000000000014'::uuid, '44444444-4444-4444-8444-000000000014'::uuid, 1, app.sha256_hex($$# Seed Model3D (HFAP)

A `model3d` post published in `human_free_agent_paid` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$), 'Seed Model3D (HFAP)', null, 'initial publish'),
  ('55555555-5555-4555-8555-000000000015'::uuid, '44444444-4444-4444-8444-000000000015'::uuid, 1, app.sha256_hex($$# Seed Model3D (X402)

A `model3d` post published in `x402_always` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$), 'Seed Model3D (X402)', null, 'initial publish'),
  ('55555555-5555-4555-8555-000000000016'::uuid, '44444444-4444-4444-8444-000000000016'::uuid, 1, app.sha256_hex($$# Seed Thread (Free)

A `thread` post published in `free` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$), 'Seed Thread (Free)', null, 'initial publish'),
  ('55555555-5555-4555-8555-000000000017'::uuid, '44444444-4444-4444-8444-000000000017'::uuid, 1, app.sha256_hex($$# Seed Thread (HFAP)

A `thread` post published in `human_free_agent_paid` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$), 'Seed Thread (HFAP)', null, 'initial publish'),
  ('55555555-5555-4555-8555-000000000018'::uuid, '44444444-4444-4444-8444-000000000018'::uuid, 1, app.sha256_hex($$# Seed Thread (X402)

A `thread` post published in `x402_always` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$), 'Seed Thread (X402)', null, 'initial publish'),
  ('55555555-5555-4555-8555-000000000019'::uuid, '44444444-4444-4444-8444-000000000006'::uuid, 2, app.sha256_hex($$# Seed Article (X402)

A `article` post published in `x402_always` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.



Second version — edited after the grant was minted.
MUSEBOOK_PAID_BODY_MARKER_7f3a$$), 'Seed Article (X402)', null, 'body edited after grant minted')
) as v(id, post_id, version, chash, title, summary, note),
     seed_const c
on conflict (id) do nothing;

insert into public.post_counters
  (post_id, likes, comments, reposts, bookmarks, impressions, opens, dwell_ms_total, paid_fetches, updated_at)
select v.id, v.likes, v.comments, v.reposts, v.bookmarks, 1000 + v.i, 40 + v.i, 3600 * v.i,
       case when v.id = '44444444-4444-4444-8444-000000000005'::uuid then 1 else 0 end,
       c.epoch
from (values
  ('44444444-4444-4444-8444-000000000001'::uuid, 1, 1, 1, 1, 1),
  ('44444444-4444-4444-8444-000000000002'::uuid, 1, 0, 0, 0, 2),
  ('44444444-4444-4444-8444-000000000003'::uuid, 1, 0, 0, 0, 3),
  ('44444444-4444-4444-8444-000000000004'::uuid, 1, 3, 1, 1, 4),
  ('44444444-4444-4444-8444-000000000005'::uuid, 1, 1, 0, 1, 5),
  ('44444444-4444-4444-8444-000000000006'::uuid, 1, 0, 0, 0, 6),
  ('44444444-4444-4444-8444-000000000007'::uuid, 1, 1, 1, 1, 7),
  ('44444444-4444-4444-8444-000000000008'::uuid, 1, 0, 0, 0, 8),
  ('44444444-4444-4444-8444-000000000009'::uuid, 1, 0, 0, 0, 9),
  ('44444444-4444-4444-8444-00000000000a'::uuid, 1, 1, 1, 1, 10),
  ('44444444-4444-4444-8444-00000000000b'::uuid, 1, 0, 0, 0, 11),
  ('44444444-4444-4444-8444-00000000000c'::uuid, 1, 0, 0, 0, 12),
  ('44444444-4444-4444-8444-00000000000d'::uuid, 1, 1, 0, 1, 13),
  ('44444444-4444-4444-8444-00000000000e'::uuid, 1, 0, 0, 0, 14),
  ('44444444-4444-4444-8444-00000000000f'::uuid, 1, 0, 0, 0, 15),
  ('44444444-4444-4444-8444-000000000010'::uuid, 1, 0, 0, 0, 16),
  ('44444444-4444-4444-8444-000000000011'::uuid, 1, 0, 0, 0, 17),
  ('44444444-4444-4444-8444-000000000012'::uuid, 1, 0, 0, 0, 18),
  ('44444444-4444-4444-8444-000000000013'::uuid, 1, 0, 0, 0, 19),
  ('44444444-4444-4444-8444-000000000014'::uuid, 1, 0, 0, 0, 20),
  ('44444444-4444-4444-8444-000000000015'::uuid, 1, 0, 0, 0, 21),
  ('44444444-4444-4444-8444-000000000016'::uuid, 1, 0, 0, 0, 22),
  ('44444444-4444-4444-8444-000000000017'::uuid, 1, 0, 0, 0, 23),
  ('44444444-4444-4444-8444-000000000018'::uuid, 1, 0, 0, 0, 24)
) as v(id, likes, comments, reposts, bookmarks, i),
     seed_const c
on conflict (post_id) do nothing;
-- Graph: 2-cycle (1↔2), 3-cycle (2→3→4→2), leaf edges into 1, one topic
-- follow for §9's topic source; user 5 keeps degree zero on purpose.
insert into public.follows (id, follower_user_id, target_kind, followee_user_id, topic_id, created_at)
select v.id, v.follower, 'user', v.followee, null, c.epoch
from (values
  ('66666666-6666-4666-8666-000000000001'::uuid, '11111111-1111-4111-8111-000000000001'::uuid, '11111111-1111-4111-8111-000000000002'::uuid),
  ('66666666-6666-4666-8666-000000000002'::uuid, '11111111-1111-4111-8111-000000000002'::uuid, '11111111-1111-4111-8111-000000000001'::uuid),
  ('66666666-6666-4666-8666-000000000003'::uuid, '11111111-1111-4111-8111-000000000002'::uuid, '11111111-1111-4111-8111-000000000003'::uuid),
  ('66666666-6666-4666-8666-000000000004'::uuid, '11111111-1111-4111-8111-000000000003'::uuid, '11111111-1111-4111-8111-000000000004'::uuid),
  ('66666666-6666-4666-8666-000000000005'::uuid, '11111111-1111-4111-8111-000000000004'::uuid, '11111111-1111-4111-8111-000000000002'::uuid),
  ('66666666-6666-4666-8666-000000000006'::uuid, '11111111-1111-4111-8111-000000000003'::uuid, '11111111-1111-4111-8111-000000000001'::uuid),
  ('66666666-6666-4666-8666-000000000007'::uuid, '11111111-1111-4111-8111-000000000004'::uuid, '11111111-1111-4111-8111-000000000001'::uuid),
  ('66666666-6666-4666-8666-000000000008'::uuid, '11111111-1111-4111-8111-000000000004'::uuid, '11111111-1111-4111-8111-000000000003'::uuid),
  ('66666666-6666-4666-8666-000000000009'::uuid, '11111111-1111-4111-8111-000000000001'::uuid, '11111111-1111-4111-8111-000000000003'::uuid),
  ('66666666-6666-4666-8666-00000000000a'::uuid, '11111111-1111-4111-8111-000000000002'::uuid, '11111111-1111-4111-8111-000000000004'::uuid),
  ('66666666-6666-4666-8666-00000000000b'::uuid, '11111111-1111-4111-8111-000000000001'::uuid, '11111111-1111-4111-8111-000000000004'::uuid)
) as v(id, follower, followee),
     seed_const c
on conflict (id) do nothing;

insert into public.follows (id, follower_user_id, target_kind, topic_id, created_at)
select '66666666-6666-4666-8666-000000000012'::uuid,
       '11111111-1111-4111-8111-000000000002'::uuid, 'topic', 'seed-music', c.epoch
from seed_const c
on conflict (id) do nothing;

insert into public.blocks (blocker_user_id, blocked_user_id, reason, created_at)
select '11111111-1111-4111-8111-000000000001'::uuid,
       '11111111-1111-4111-8111-000000000004'::uuid, 'seed fixture', c.epoch
from seed_const c
on conflict (blocker_user_id, blocked_user_id) do nothing;

-- One muted_user_id mute + one muted_keyword mute (mutes_target_exactly_one).
insert into public.mutes (id, muter_user_id, muted_user_id, created_at)
select '66666666-6666-4666-8666-000000000013'::uuid,
       '11111111-1111-4111-8111-000000000002'::uuid,
       '11111111-1111-4111-8111-000000000004'::uuid, c.epoch
from seed_const c
on conflict (id) do nothing;

insert into public.mutes (id, muter_user_id, muted_keyword, created_at)
select '66666666-6666-4666-8666-000000000014'::uuid,
       '11111111-1111-4111-8111-000000000003'::uuid, 'spoiler', c.epoch
from seed_const c
on conflict (id) do nothing;
insert into public.likes (post_id, user_id, actor_agent_id, created_at)
select v.pid, v.uid, v.agent, c.epoch
from (values
  ('44444444-4444-4444-8444-000000000007'::uuid, '11111111-1111-4111-8111-000000000001'::uuid, null::uuid),
  ('44444444-4444-4444-8444-00000000000a'::uuid, '11111111-1111-4111-8111-000000000001'::uuid, null::uuid),
  ('44444444-4444-4444-8444-00000000000d'::uuid, '11111111-1111-4111-8111-000000000001'::uuid, null::uuid),
  ('44444444-4444-4444-8444-000000000010'::uuid, '11111111-1111-4111-8111-000000000001'::uuid, null::uuid),
  ('44444444-4444-4444-8444-000000000013'::uuid, '11111111-1111-4111-8111-000000000001'::uuid, null::uuid),
  ('44444444-4444-4444-8444-000000000016'::uuid, '11111111-1111-4111-8111-000000000001'::uuid, null::uuid),
  ('44444444-4444-4444-8444-000000000001'::uuid, '11111111-1111-4111-8111-000000000002'::uuid, null::uuid),
  ('44444444-4444-4444-8444-000000000004'::uuid, '11111111-1111-4111-8111-000000000002'::uuid, null::uuid),
  ('44444444-4444-4444-8444-000000000005'::uuid, '11111111-1111-4111-8111-000000000002'::uuid, null::uuid),
  ('44444444-4444-4444-8444-000000000008'::uuid, '11111111-1111-4111-8111-000000000002'::uuid, null::uuid),
  ('44444444-4444-4444-8444-00000000000b'::uuid, '11111111-1111-4111-8111-000000000002'::uuid, null::uuid),
  ('44444444-4444-4444-8444-00000000000e'::uuid, '11111111-1111-4111-8111-000000000002'::uuid, null::uuid),
  ('44444444-4444-4444-8444-000000000002'::uuid, '11111111-1111-4111-8111-000000000003'::uuid, '33333333-3333-4333-8333-000000000001'::uuid),
  ('44444444-4444-4444-8444-000000000006'::uuid, '11111111-1111-4111-8111-000000000003'::uuid, null::uuid),
  ('44444444-4444-4444-8444-000000000009'::uuid, '11111111-1111-4111-8111-000000000003'::uuid, null::uuid),
  ('44444444-4444-4444-8444-00000000000c'::uuid, '11111111-1111-4111-8111-000000000003'::uuid, null::uuid),
  ('44444444-4444-4444-8444-00000000000f'::uuid, '11111111-1111-4111-8111-000000000003'::uuid, null::uuid),
  ('44444444-4444-4444-8444-000000000012'::uuid, '11111111-1111-4111-8111-000000000003'::uuid, null::uuid),
  ('44444444-4444-4444-8444-000000000003'::uuid, '11111111-1111-4111-8111-000000000004'::uuid, null::uuid),
  ('44444444-4444-4444-8444-000000000014'::uuid, '11111111-1111-4111-8111-000000000004'::uuid, null::uuid),
  ('44444444-4444-4444-8444-000000000015'::uuid, '11111111-1111-4111-8111-000000000004'::uuid, null::uuid),
  ('44444444-4444-4444-8444-000000000017'::uuid, '11111111-1111-4111-8111-000000000004'::uuid, null::uuid),
  ('44444444-4444-4444-8444-000000000018'::uuid, '11111111-1111-4111-8111-000000000004'::uuid, null::uuid),
  ('44444444-4444-4444-8444-000000000011'::uuid, '11111111-1111-4111-8111-000000000004'::uuid, null::uuid)
) as v(pid, uid, agent),
     seed_const c
on conflict (post_id, user_id) do nothing;
insert into public.comments
  (id, post_id, author_user_id, actor_agent_id, parent_comment_id, thread_root_id,
   depth, body_markdown, content_hash, status, created_at)
select v.id, v.pid, v.uid, v.agent, v.parent, v.root, v.depth, v.body, v.chash,
       'published'::post_status, c.epoch
from (values
  ('77777777-7777-4777-8777-000000000001'::uuid, '44444444-4444-4444-8444-000000000004'::uuid, '11111111-1111-4111-8111-000000000002'::uuid, null::uuid, null::uuid, null::uuid, 0, $$Sharp piece — the licensing section especially.$$, app.sha256_hex($$Sharp piece — the licensing section especially.$$)),
  ('77777777-7777-4777-8777-000000000002'::uuid, '44444444-4444-4444-8444-000000000005'::uuid, '11111111-1111-4111-8111-000000000002'::uuid, null::uuid, null::uuid, null::uuid, 0, $$Preview reads clean; paying for the rest now.$$, app.sha256_hex($$Preview reads clean; paying for the rest now.$$)),
  ('77777777-7777-4777-8777-000000000003'::uuid, '44444444-4444-4444-8444-000000000001'::uuid, '11111111-1111-4111-8111-000000000003'::uuid, '33333333-3333-4333-8333-000000000001'::uuid, null::uuid, null::uuid, 0, $$Posted by the delegated agent under a live delegation.$$, app.sha256_hex($$Posted by the delegated agent under a live delegation.$$)),
  ('77777777-7777-4777-8777-000000000004'::uuid, '44444444-4444-4444-8444-000000000004'::uuid, '11111111-1111-4111-8111-000000000004'::uuid, null::uuid, null::uuid, null::uuid, 0, $$Blocked user can still comment on a public post.$$, app.sha256_hex($$Blocked user can still comment on a public post.$$)),
  ('77777777-7777-4777-8777-000000000005'::uuid, '44444444-4444-4444-8444-000000000004'::uuid, '11111111-1111-4111-8111-000000000001'::uuid, null::uuid, null::uuid, null::uuid, 0, $$Author reply — see the thread.$$, app.sha256_hex($$Author reply — see the thread.$$)),
  ('77777777-7777-4777-8777-000000000006'::uuid, '44444444-4444-4444-8444-000000000007'::uuid, '11111111-1111-4111-8111-000000000002'::uuid, null::uuid, null::uuid, null::uuid, 0, $$The image set renders fast.$$, app.sha256_hex($$The image set renders fast.$$)),
  ('77777777-7777-4777-8777-000000000007'::uuid, '44444444-4444-4444-8444-00000000000a'::uuid, '11111111-1111-4111-8111-000000000003'::uuid, null::uuid, null::uuid, null::uuid, 0, $$Plays inline, no download needed.$$, app.sha256_hex($$Plays inline, no download needed.$$)),
  ('77777777-7777-4777-8777-000000000008'::uuid, '44444444-4444-4444-8444-00000000000d'::uuid, '11111111-1111-4111-8111-000000000004'::uuid, null::uuid, null::uuid, null::uuid, 0, $$Seed comment on the audio post.$$, app.sha256_hex($$Seed comment on the audio post.$$)),
  ('77777777-7777-4777-8777-000000000009'::uuid, '44444444-4444-4444-8444-000000000004'::uuid, '11111111-1111-4111-8111-000000000001'::uuid, null::uuid, '77777777-7777-4777-8777-000000000001'::uuid, '77777777-7777-4777-8777-000000000001'::uuid, 1, $$Threaded reply to the first comment.$$, app.sha256_hex($$Threaded reply to the first comment.$$))
) as v(id, pid, uid, agent, parent, root, depth, body, chash),
     seed_const c
on conflict (id) do nothing;
insert into public.bookmarks (post_id, user_id, actor_agent_id, collection, created_at)
select v.pid, v.uid, v.agent, v.col, c.epoch
from (values
  ('44444444-4444-4444-8444-000000000001'::uuid, '11111111-1111-4111-8111-000000000002'::uuid, null::uuid, 'default'),
  ('44444444-4444-4444-8444-000000000004'::uuid, '11111111-1111-4111-8111-000000000003'::uuid, null::uuid, 'default'),
  ('44444444-4444-4444-8444-000000000005'::uuid, '11111111-1111-4111-8111-000000000004'::uuid, null::uuid, 'default'),
  ('44444444-4444-4444-8444-000000000007'::uuid, '11111111-1111-4111-8111-000000000001'::uuid, '33333333-3333-4333-8333-000000000001'::uuid, 'default'),
  ('44444444-4444-4444-8444-00000000000a'::uuid, '11111111-1111-4111-8111-000000000002'::uuid, null::uuid, 'default'),
  ('44444444-4444-4444-8444-00000000000d'::uuid, '11111111-1111-4111-8111-000000000003'::uuid, null::uuid, 'default')
) as v(pid, uid, agent, col),
     seed_const c
on conflict (post_id, user_id) do nothing;
insert into public.reposts (id, post_id, user_id, actor_agent_id, created_at)
select v.id, v.pid, v.uid, v.agent, c.epoch
from (values
  ('77777777-7777-4777-8777-00000000000a'::uuid, '44444444-4444-4444-8444-000000000001'::uuid, '11111111-1111-4111-8111-000000000002'::uuid, null::uuid),
  ('77777777-7777-4777-8777-00000000000b'::uuid, '44444444-4444-4444-8444-000000000004'::uuid, '11111111-1111-4111-8111-000000000003'::uuid, null::uuid),
  ('77777777-7777-4777-8777-00000000000c'::uuid, '44444444-4444-4444-8444-000000000007'::uuid, '11111111-1111-4111-8111-000000000004'::uuid, null::uuid),
  ('77777777-7777-4777-8777-00000000000d'::uuid, '44444444-4444-4444-8444-00000000000a'::uuid, '11111111-1111-4111-8111-000000000001'::uuid, '33333333-3333-4333-8333-000000000001'::uuid)
) as v(id, pid, uid, agent),
     seed_const c
on conflict (id) do nothing;
-- Hand-written topic/quality rows — NOT a classifier call; the seed must work
-- with TYPESAFE_API_KEY unset (the classifier's own tests stub the transport).
insert into public.post_classifications
  (content_hash, provider, model, primary_topic, topics, language_code,
   quality, toxicity, spam, commercial_intent, is_nsfw, is_ai_generated,
   classified_at, latency_ms)
select v.chash, 'seed', 'seed-static-v0', 'music', '{music,seed}'::text[], 'en',
       0.70, 0.01, 0.0, 0.10, false, false, c.epoch, 0
from (values
  (app.sha256_hex($$# Seed Note (Free)

A `note` post published in `free` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$)),
  (app.sha256_hex($$# Seed Note (HFAP)

A `note` post published in `human_free_agent_paid` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$)),
  (app.sha256_hex($$# Seed Note (X402)

A `note` post published in `x402_always` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$)),
  (app.sha256_hex($$# Seed Article (Free)

A `article` post published in `free` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$)),
  (app.sha256_hex($$# Seed Article (HFAP)

A `article` post published in `human_free_agent_paid` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$)),
  (app.sha256_hex($$# Seed Article (X402)

A `article` post published in `x402_always` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$)),
  (app.sha256_hex($$# Seed Image (Free)

A `image` post published in `free` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$)),
  (app.sha256_hex($$# Seed Image (HFAP)

A `image` post published in `human_free_agent_paid` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$)),
  (app.sha256_hex($$# Seed Image (X402)

A `image` post published in `x402_always` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$)),
  (app.sha256_hex($$# Seed Video (Free)

A `video` post published in `free` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$)),
  (app.sha256_hex($$# Seed Video (HFAP)

A `video` post published in `human_free_agent_paid` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$)),
  (app.sha256_hex($$# Seed Video (X402)

A `video` post published in `x402_always` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$)),
  (app.sha256_hex($$# Seed Audio (Free)

A `audio` post published in `free` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$)),
  (app.sha256_hex($$# Seed Audio (HFAP)

A `audio` post published in `human_free_agent_paid` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$)),
  (app.sha256_hex($$# Seed Audio (X402)

A `audio` post published in `x402_always` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$)),
  (app.sha256_hex($$# Seed App (Free)

A `app` post published in `free` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$)),
  (app.sha256_hex($$# Seed App (HFAP)

A `app` post published in `human_free_agent_paid` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$)),
  (app.sha256_hex($$# Seed App (X402)

A `app` post published in `x402_always` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$)),
  (app.sha256_hex($$# Seed Model3D (Free)

A `model3d` post published in `free` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$)),
  (app.sha256_hex($$# Seed Model3D (HFAP)

A `model3d` post published in `human_free_agent_paid` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$)),
  (app.sha256_hex($$# Seed Model3D (X402)

A `model3d` post published in `x402_always` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$)),
  (app.sha256_hex($$# Seed Thread (Free)

A `thread` post published in `free` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$)),
  (app.sha256_hex($$# Seed Thread (HFAP)

A `thread` post published in `human_free_agent_paid` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$)),
  (app.sha256_hex($$# Seed Thread (X402)

A `thread` post published in `x402_always` mode.

This seed body exists so the 400-character preview boundary is exercised by real text rather than by a comment about it. The paywall preview ends before the marker below, so any representation that leaks past it leaks paid content. Filler sentence to keep the byte count honest, and then a second clause so the marker lands strictly past the boundary.

MUSEBOOK_PAID_BODY_MARKER_7f3a$$))
) as v(chash),
     seed_const c
on conflict (content_hash) do nothing;
-- D5: deterministic vectors derived from the row's content_hash — an embedding
-- API call in a seed file is an integration test with a bill.
insert into public.post_embeddings (content_hash, post_id, model, dim, embedding, created_at)
select b.content_hash, p.id, 'seed-deterministic-v0', 1536,
       (select array_agg((('x' || substr(b.content_hash, 1 + mod(g, 59), 6))::bit(24)::int % 10000)::real / 10000.0)
          from generate_series(1, 1536) g)::extensions.vector(1536),
       c.epoch
from public.post_bodies b
     join public.posts p on p.content_hash = b.content_hash,
     seed_const c
on conflict (content_hash) do nothing;

insert into public.user_embeddings (user_id, model, embedding, n_events, updated_at)
select v.id, 'seed-deterministic-v0',
       (select array_agg((('x' || substr(app.sha256_hex(v.id::text), 1 + mod(g, 59), 6))::bit(24)::int % 10000)::real / 10000.0)
          from generate_series(1, 1536) g)::extensions.vector(1536),
       8, c.epoch
from (values
  ('11111111-1111-4111-8111-000000000001'::uuid),
  ('11111111-1111-4111-8111-000000000002'::uuid),
  ('11111111-1111-4111-8111-000000000003'::uuid),
  ('11111111-1111-4111-8111-000000000004'::uuid),
  ('11111111-1111-4111-8111-000000000005'::uuid)
) as v(id),
     seed_const c
on conflict (user_id) do nothing;
-- 'none' and 'reverse_chron' already exist via 20260922091400_seed_reference.sql;
-- this adds 'v0' so RankingScorer has a real weight map to load.
insert into public.ranking_weights (weights_version, cohort, weights, is_active, notes, created_at, activated_at)
select 'v0', 'all',
       '{"impression":1.0,"view":2.0,"dwell_ms":0.01,"like":8.0,"comment":12.0,"bookmark":10.0,"repost":14.0,"follow":20.0,"not_interested":-15.0,"not_dwelled":-5.0,"recency_half_life_hours":24.0,"author_graph_boost":1.25}'::jsonb,
       true, 'seed bootstrap weights', c.epoch, c.epoch
from seed_const c
on conflict (weights_version) do nothing;

-- ── slate ─────────────────────────────────────────────────────────────────
-- One historical slate at the bootstrap dimension pair, positions 0–19 over the
-- first twenty posts, so pagination/replay and the M6 one-read feed path have a
-- persisted slate without musebook-worker having run.
insert into public.slates
  (id, viewer_user_id, surface, weights_version, model_version, candidate_count,
   params, created_at, expires_at)
select '88888888-8888-4888-8888-000000000001'::uuid,
       '11111111-1111-4111-8111-000000000002'::uuid, 'home', 'none', 'reverse_chron',
       24, '{}'::jsonb, c.epoch, c.epoch + interval '30 minutes'
from seed_const c
on conflict (id) do nothing;

insert into public.slate_items (slate_id, position, post_id, source, action_scores, weighted_score, score)
select '88888888-8888-4888-8888-000000000001'::uuid, v.pos, v.pid, v.source,
       ('{"view":' || v.pos || ',"like":' || (v.pos % 5) || '}')::jsonb,
       1.0 - v.pos * 0.045, 1.0 - v.pos * 0.045
from (values
  (0, '44444444-4444-4444-8444-000000000001'::uuid, 'follows'),
  (1, '44444444-4444-4444-8444-000000000002'::uuid, 'embedding'),
  (2, '44444444-4444-4444-8444-000000000003'::uuid, 'topic'),
  (3, '44444444-4444-4444-8444-000000000004'::uuid, 'fresh'),
  (4, '44444444-4444-4444-8444-000000000005'::uuid, 'follows'),
  (5, '44444444-4444-4444-8444-000000000006'::uuid, 'embedding'),
  (6, '44444444-4444-4444-8444-000000000007'::uuid, 'topic'),
  (7, '44444444-4444-4444-8444-000000000008'::uuid, 'fresh'),
  (8, '44444444-4444-4444-8444-000000000009'::uuid, 'follows'),
  (9, '44444444-4444-4444-8444-00000000000a'::uuid, 'embedding'),
  (10, '44444444-4444-4444-8444-00000000000b'::uuid, 'topic'),
  (11, '44444444-4444-4444-8444-00000000000c'::uuid, 'fresh'),
  (12, '44444444-4444-4444-8444-00000000000d'::uuid, 'follows'),
  (13, '44444444-4444-4444-8444-00000000000e'::uuid, 'embedding'),
  (14, '44444444-4444-4444-8444-00000000000f'::uuid, 'topic'),
  (15, '44444444-4444-4444-8444-000000000010'::uuid, 'fresh'),
  (16, '44444444-4444-4444-8444-000000000011'::uuid, 'follows'),
  (17, '44444444-4444-4444-8444-000000000012'::uuid, 'embedding'),
  (18, '44444444-4444-4444-8444-000000000013'::uuid, 'topic'),
  (19, '44444444-4444-4444-8444-000000000014'::uuid, 'fresh')
) as v(pos, pid, source)
on conflict (slate_id, position) do nothing;
-- 30 human + 10 agent events, all at SEED_EPOCH + n seconds. Human rows resolve
-- their slate_id to the seeded slate; agent fetches carry DIRECT_FETCH_SLATE_ID
-- (constants.ts) because they were never served from a ranked slate.
insert into public.action_events
  (event_id, occurred_at, actor_plane, viewer_user_id, actor_agent_id, post_id,
   action, surface, slate_id, position, weights_version, model_version,
   dwell_ms, client, request_id)
select v.id, c.epoch + (v.n || ' seconds')::interval, 'human'::actor_plane,
       v.uid, null, v.pid, v.action::action_kind, 'home',
       '88888888-8888-4888-8888-000000000001'::uuid, v.pos, 'none', 'reverse_chron',
       v.dwell, '{"ua":"seed"}'::jsonb, 'seed-req-' || v.n
from (values
  ('99999999-9999-4999-8999-000000000001'::uuid, 1, '11111111-1111-4111-8111-000000000001'::uuid, '44444444-4444-4444-8444-000000000001'::uuid, 'impression', 0, null),
  ('99999999-9999-4999-8999-000000000002'::uuid, 2, '11111111-1111-4111-8111-000000000002'::uuid, '44444444-4444-4444-8444-000000000002'::uuid, 'view', 1, null),
  ('99999999-9999-4999-8999-000000000003'::uuid, 3, '11111111-1111-4111-8111-000000000003'::uuid, '44444444-4444-4444-8444-000000000003'::uuid, 'dwell', 2, 600),
  ('99999999-9999-4999-8999-000000000004'::uuid, 4, '11111111-1111-4111-8111-000000000004'::uuid, '44444444-4444-4444-8444-000000000004'::uuid, 'like', 3, null),
  ('99999999-9999-4999-8999-000000000005'::uuid, 5, '11111111-1111-4111-8111-000000000001'::uuid, '44444444-4444-4444-8444-000000000005'::uuid, 'impression', 4, null),
  ('99999999-9999-4999-8999-000000000006'::uuid, 6, '11111111-1111-4111-8111-000000000002'::uuid, '44444444-4444-4444-8444-000000000006'::uuid, 'view', 5, null),
  ('99999999-9999-4999-8999-000000000007'::uuid, 7, '11111111-1111-4111-8111-000000000003'::uuid, '44444444-4444-4444-8444-000000000007'::uuid, 'dwell', 6, 800),
  ('99999999-9999-4999-8999-000000000008'::uuid, 8, '11111111-1111-4111-8111-000000000004'::uuid, '44444444-4444-4444-8444-000000000008'::uuid, 'like', 7, null),
  ('99999999-9999-4999-8999-000000000009'::uuid, 9, '11111111-1111-4111-8111-000000000001'::uuid, '44444444-4444-4444-8444-000000000009'::uuid, 'impression', 8, null),
  ('99999999-9999-4999-8999-00000000000a'::uuid, 10, '11111111-1111-4111-8111-000000000002'::uuid, '44444444-4444-4444-8444-00000000000a'::uuid, 'view', 9, null),
  ('99999999-9999-4999-8999-00000000000b'::uuid, 11, '11111111-1111-4111-8111-000000000003'::uuid, '44444444-4444-4444-8444-00000000000b'::uuid, 'dwell', 10, 1000),
  ('99999999-9999-4999-8999-00000000000c'::uuid, 12, '11111111-1111-4111-8111-000000000004'::uuid, '44444444-4444-4444-8444-00000000000c'::uuid, 'like', 11, null),
  ('99999999-9999-4999-8999-00000000000d'::uuid, 13, '11111111-1111-4111-8111-000000000001'::uuid, '44444444-4444-4444-8444-00000000000d'::uuid, 'impression', 12, null),
  ('99999999-9999-4999-8999-00000000000e'::uuid, 14, '11111111-1111-4111-8111-000000000002'::uuid, '44444444-4444-4444-8444-00000000000e'::uuid, 'view', 13, null),
  ('99999999-9999-4999-8999-00000000000f'::uuid, 15, '11111111-1111-4111-8111-000000000003'::uuid, '44444444-4444-4444-8444-00000000000f'::uuid, 'dwell', 14, 1200),
  ('99999999-9999-4999-8999-000000000010'::uuid, 16, '11111111-1111-4111-8111-000000000004'::uuid, '44444444-4444-4444-8444-000000000010'::uuid, 'like', 15, null),
  ('99999999-9999-4999-8999-000000000011'::uuid, 17, '11111111-1111-4111-8111-000000000001'::uuid, '44444444-4444-4444-8444-000000000011'::uuid, 'impression', 16, null),
  ('99999999-9999-4999-8999-000000000012'::uuid, 18, '11111111-1111-4111-8111-000000000002'::uuid, '44444444-4444-4444-8444-000000000012'::uuid, 'view', 17, null),
  ('99999999-9999-4999-8999-000000000013'::uuid, 19, '11111111-1111-4111-8111-000000000003'::uuid, '44444444-4444-4444-8444-000000000013'::uuid, 'dwell', 18, 1400),
  ('99999999-9999-4999-8999-000000000014'::uuid, 20, '11111111-1111-4111-8111-000000000004'::uuid, '44444444-4444-4444-8444-000000000014'::uuid, 'like', 19, null),
  ('99999999-9999-4999-8999-000000000015'::uuid, 21, '11111111-1111-4111-8111-000000000001'::uuid, '44444444-4444-4444-8444-000000000015'::uuid, 'impression', 0, null),
  ('99999999-9999-4999-8999-000000000016'::uuid, 22, '11111111-1111-4111-8111-000000000002'::uuid, '44444444-4444-4444-8444-000000000016'::uuid, 'view', 1, null),
  ('99999999-9999-4999-8999-000000000017'::uuid, 23, '11111111-1111-4111-8111-000000000003'::uuid, '44444444-4444-4444-8444-000000000017'::uuid, 'dwell', 2, 1600),
  ('99999999-9999-4999-8999-000000000018'::uuid, 24, '11111111-1111-4111-8111-000000000004'::uuid, '44444444-4444-4444-8444-000000000018'::uuid, 'like', 3, null),
  ('99999999-9999-4999-8999-000000000019'::uuid, 25, '11111111-1111-4111-8111-000000000001'::uuid, '44444444-4444-4444-8444-000000000001'::uuid, 'impression', 4, null),
  ('99999999-9999-4999-8999-00000000001a'::uuid, 26, '11111111-1111-4111-8111-000000000002'::uuid, '44444444-4444-4444-8444-000000000002'::uuid, 'view', 5, null),
  ('99999999-9999-4999-8999-00000000001b'::uuid, 27, '11111111-1111-4111-8111-000000000003'::uuid, '44444444-4444-4444-8444-000000000003'::uuid, 'dwell', 6, 1800),
  ('99999999-9999-4999-8999-00000000001c'::uuid, 28, '11111111-1111-4111-8111-000000000004'::uuid, '44444444-4444-4444-8444-000000000004'::uuid, 'like', 7, null),
  ('99999999-9999-4999-8999-00000000001d'::uuid, 29, '11111111-1111-4111-8111-000000000001'::uuid, '44444444-4444-4444-8444-000000000005'::uuid, 'impression', 8, null),
  ('99999999-9999-4999-8999-00000000001e'::uuid, 30, '11111111-1111-4111-8111-000000000002'::uuid, '44444444-4444-4444-8444-000000000005'::uuid, 'x402_pay', 4, null)
) as v(id, n, uid, pid, action, pos, dwell),
     seed_const c
on conflict do nothing;

insert into public.action_events
  (event_id, occurred_at, actor_plane, actor_agent_id, post_id,
   action, surface, slate_id, position, weights_version, model_version,
   client, request_id)
select v.id, c.epoch + (v.n || ' seconds')::interval, 'agent'::actor_plane,
       '33333333-3333-4333-8333-000000000002'::uuid, v.pid, v.action::action_kind,
       'crawl', '11111111-1111-4111-8111-111111111111'::uuid, 0,
       'none', 'reverse_chron', '{"ua":"SeedCrawler/1.0"}'::jsonb, 'seed-agent-' || v.n
from (values
  ('99999999-9999-4999-8999-00000000001f'::uuid, 31, '44444444-4444-4444-8444-000000000001'::uuid, 'agent_crawl'),
  ('99999999-9999-4999-8999-000000000020'::uuid, 32, '44444444-4444-4444-8444-000000000002'::uuid, 'agent_crawl'),
  ('99999999-9999-4999-8999-000000000021'::uuid, 33, '44444444-4444-4444-8444-000000000003'::uuid, 'agent_crawl'),
  ('99999999-9999-4999-8999-000000000022'::uuid, 34, '44444444-4444-4444-8444-000000000004'::uuid, 'agent_crawl'),
  ('99999999-9999-4999-8999-000000000023'::uuid, 35, '44444444-4444-4444-8444-000000000005'::uuid, 'agent_crawl'),
  ('99999999-9999-4999-8999-000000000024'::uuid, 36, '44444444-4444-4444-8444-000000000006'::uuid, 'agent_crawl'),
  ('99999999-9999-4999-8999-000000000025'::uuid, 37, '44444444-4444-4444-8444-000000000007'::uuid, 'agent_crawl'),
  ('99999999-9999-4999-8999-000000000026'::uuid, 38, '44444444-4444-4444-8444-000000000008'::uuid, 'agent_crawl'),
  ('99999999-9999-4999-8999-000000000027'::uuid, 39, '44444444-4444-4444-8444-000000000009'::uuid, 'agent_crawl'),
  ('99999999-9999-4999-8999-000000000028'::uuid, 40, '44444444-4444-4444-8444-00000000000a'::uuid, 'x402_pay')
) as v(id, n, pid, action),
     seed_const c
on conflict do nothing;
-- ── money ─────────────────────────────────────────────────────────────────
-- One settled purchase bound to the human_free_agent_paid article's
-- content_hash: "a grant holder gets 200" is testable without a facilitator.
insert into public.x402_quotes
  (id, resource_url, post_id, content_hash, requested_by_agent, transport,
   x402_version, scheme, network, asset, pay_to, amount_atomic,
   max_timeout_seconds, rate_source, requirements, issued_at, expires_at, consumed_at)
select 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001'::uuid, 'https://musebook.dev/p/seed-article-hfap',
       '44444444-4444-4444-8444-000000000005'::uuid, p.content_hash, '33333333-3333-4333-8333-000000000002'::uuid, 'http',
       2, 'exact', 'eip155:8453', '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', '0x2222222222222222222222222222222222222222', 2000,
       60, 'direct_usdc', '{"scheme":"exact","network":"eip155:8453"}'::jsonb,
       c.epoch, c.epoch + interval '60 seconds', c.epoch + interval '70 seconds'
from public.posts p, seed_const c
where p.id = '44444444-4444-4444-8444-000000000005'::uuid
on conflict (id) do nothing;

insert into public.x402_settlements
  (id, quote_id, post_id, content_hash, network, asset, payer, nonce,
   amount_atomic, pay_to, transaction, status, facilitator_url,
   verify_response, settle_response, revenue_share_version, created_at, settled_at)
select 'aaaaaaaa-aaaa-4aaa-8aaa-000000000002'::uuid, 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001'::uuid, '44444444-4444-4444-8444-000000000005'::uuid, p.content_hash,
       'eip155:8453', '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', '0x3333333333333333333333333333333333333333',
       '0x' || repeat('0', 56) || 'feed0001',
       2000, '0x2222222222222222222222222222222222222222',
       '0x' || repeat('0', 56) || 'feed0001',
       'settled'::settlement_status, 'https://x402.org/facilitator',
       '{"valid":true}'::jsonb, '{"settled":true}'::jsonb, 'rs_2026_09_v1',
       c.epoch + interval '72 seconds', c.epoch + interval '75 seconds'
from public.posts p, seed_const c
where p.id = '44444444-4444-4444-8444-000000000005'::uuid
on conflict (id) do nothing;

insert into public.access_grants
  (id, settlement_id, content_hash, post_id, payer, subject_agent_id, granted_at)
select 'aaaaaaaa-aaaa-4aaa-8aaa-000000000003'::uuid, 'aaaaaaaa-aaaa-4aaa-8aaa-000000000002'::uuid, p.content_hash, '44444444-4444-4444-8444-000000000005'::uuid,
       '0x3333333333333333333333333333333333333333', '33333333-3333-4333-8333-000000000002'::uuid, c.epoch + interval '80 seconds'
from public.posts p, seed_const c
where p.id = '44444444-4444-4444-8444-000000000005'::uuid
on conflict (id) do nothing;
-- ── agents ────────────────────────────────────────────────────────────────
insert into public.connectors
  (id, slug, display_name, vendor, transport, base_url, auth_kind, manifest,
   default_scopes, is_verified, is_enabled, created_at, updated_at)
select 'bbbbbbbb-bbbb-4bbb-8bbb-000000000001'::uuid, 'seed-echo-mcp', 'Seed Echo MCP', 'musebook', 'mcp_http',
       'https://seed-connector.musebook.dev/mcp', 'bearer',
       '{"name":"seed-echo-mcp","version":"0.0.0","tools":["echo"]}'::jsonb,
       '{feed:read,post:read}'::text[], false, true, c.epoch, c.epoch
from seed_const c
on conflict (id) do nothing;

-- Active delegation; token_sha256 is the hash of the committed preimage
-- 'mb_dlg_seed_delegation_token_0001', so connector contract tests can
-- authenticate without a plaintext secret in the repo beyond the fixture.
-- (The preimage MUST match DELEGATION_RE's mb_dlg_ prefix or resolve-actor
-- row 1 never reaches app.resolve_delegation.)
insert into public.delegations
  (id, owner_user_id, connector_id, agent_identity_id, state, scopes,
   token_sha256, spend_cap_atomic, spend_window, rate_limit_per_hour,
   requires_approval, per_action_cap_atomic, requires_approval_over_atomic,
   generations_per_day, reputation, strikes, clean_approvals,
   first_publish_at, created_at, expires_at)
select 'bbbbbbbb-bbbb-4bbb-8bbb-000000000002'::uuid, '11111111-1111-4111-8111-000000000003'::uuid, 'bbbbbbbb-bbbb-4bbb-8bbb-000000000001'::uuid, '33333333-3333-4333-8333-000000000001'::uuid,
       'active'::delegation_state, '{feed:read,post:read,post:write}'::text[],
       app.sha256_hex('mb_dlg_seed_delegation_token_0001'),
       1000000, interval '1 day', 120, false, 100000, 500000, 10,
       50, 0, 0, c.epoch, c.epoch, c.epoch + interval '90 days'
from seed_const c
on conflict (id) do nothing;

-- A live human session; token_sha256 is the hash of the committed preimage
-- 'musebook-seed-session-token-0001', so resolve-actor row 2 can be exercised
-- end to end without a SIWE round trip in the fixture.
insert into public.sessions
  (id, user_id, actor, token_sha256, expires_at, ip_hash, user_agent, issued_at)
select '11111111-1111-4111-8111-0000000000f1'::uuid, '11111111-1111-4111-8111-000000000001'::uuid,
       'human_creator'::actor_class,
       app.sha256_hex('musebook-seed-session-token-0001'),
       c.epoch + interval '365 days',
       app.sha256_hex('127.0.0.1'), 'seed', c.epoch
from seed_const c
on conflict (id) do nothing;
-- ── distribution (pre-M10 safe) ───────────────────────────────────────────
-- platforms has zero rows until M10's 20260922091901_platform_seed.sql; both
-- inserts below are `where exists` so the file replays cleanly before and after.
insert into public.channels
  (id, owner_user_id, platform, postiz_channel_id, handle, display_name,
   connected_at, created_at, updated_at)
select v.id, '11111111-1111-4111-8111-000000000001'::uuid, v.plat, v.ext, v.handle, v.dn, c.epoch, c.epoch, c.epoch
from (values
  ('cccccccc-cccc-4ccc-8ccc-000000000001'::uuid, 'x',       'postiz-x-1',       '@seed_creator', 'Seed Creator (X)'),
  ('cccccccc-cccc-4ccc-8ccc-000000000002'::uuid, 'discord', 'postiz-discord-1', 'seed_creator',  'Seed Creator (Discord)')
) as v(id, plat, ext, handle, dn),
     seed_const c
where exists (select 1 from public.platforms where slug = v.plat)
on conflict (id) do nothing;

insert into public.platform_variants
  (id, post_id, post_version_id, platform, body, media, generated_by,
   validator_report, is_valid, created_at)
select v.id, '44444444-4444-4444-8444-000000000004'::uuid, '55555555-5555-4555-8555-000000000004'::uuid, v.plat, v.body, '{}'::jsonb,
       'deterministic', '{"checks":[]}'::jsonb, true, c.epoch
from (values
  ('cccccccc-cccc-4ccc-8ccc-00000000000b'::uuid, 'x',       'Seed Article (Free) — short variant for the feed card.'),
  ('cccccccc-cccc-4ccc-8ccc-00000000000c'::uuid, 'discord', '**Seed Article (Free)** — embed-ready summary.'),
  ('cccccccc-cccc-4ccc-8ccc-00000000000d'::uuid, 'mastodon','Seed Article (Free) — 500-char variant.')
) as v(id, plat, body),
     seed_const c
where exists (select 1 from public.platforms where slug = v.plat)
on conflict (id) do nothing;

commit;
