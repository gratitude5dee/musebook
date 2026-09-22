-- 02. Enumerated types. Closed sets only.

-- The ONE kind vocabulary. @musebook/schema exports it as PostKind; section 9's
-- diversity floor counts "eight kinds"; section 11.17 maps generated media and
-- artifacts onto it directly. There is no separate MediaKind.
create type post_kind as enum (
  'note',      -- short-form post
  'article',   -- long-form blog; crawl-optimized surface
  'image',
  'video',
  'audio',
  'app',       -- 2D artifact: iframe-sandboxed bundle hosted on artifacts.musebook.dev
  'model3d',   -- 3D artifact: glTF, rendered by <model-viewer> / react-three-fiber
  'thread'     -- ordered sequence of notes under one root
);

create type publish_mode as enum ('free', 'human_free_agent_paid', 'x402_always');

-- 'pending_approval' is written by the scheduled agent drafter (section 10.15)
-- while a delegation's approvals remain; the owner's approval flips it to 'published'.
create type post_status as enum (
  'draft', 'pending_approval', 'scheduled', 'published', 'unlisted', 'removed'
);

create type actor_class as enum ('human_creator', 'human_reader', 'owner_agent', 'crawler_agent');

-- Level-1 partition key on action_events. Two values, permanently.
create type actor_plane as enum ('human', 'agent');

-- The FULL Musebook action set, from day one. This is the closed set section 9's
-- MUSE_ACTIONS array indexes into (array order is the model's output-vector index),
-- section 12's analytics projection inserts, and section 13 rolls up. No later
-- section extends it by migration. The last five are the negative heads.
create type action_kind as enum (
  'impression', 'view', 'dwell', 'play', 'play_through',
  'like', 'comment', 'repost', 'bookmark', 'share', 'follow',
  'remix', 'fork_app', 'install_app',
  'tip', 'x402_pay', 'agent_crawl', 'agent_cite',
  'not_interested', 'mute_creator', 'block_creator', 'report', 'not_dwelled'
);

create type settlement_status as enum ('pending', 'settled', 'failed', 'refunded');

create type job_state as enum ('queued', 'running', 'succeeded', 'failed', 'dead');

create type delegation_state as enum ('active', 'paused', 'revoked', 'expired');

create type approval_state as enum ('pending', 'approved', 'rejected', 'expired');

create type agent_verification as enum (
  'none',            -- self-declared, no proof
  'web_bot_auth',    -- RFC 9421 signature verified against the agent's key directory
  'verified_crawler',-- forward-confirmed reverse DNS + published IP range
  'owner_delegated', -- a Musebook user minted this agent a delegation token
  'moltbook'         -- verified against moltbook.com/api/v1/agents/verify-identity
);
