-- 05. Social graph: follows, blocks, mutes, likes, comments, bookmarks, reposts.

-- One table for both edge kinds. A topic follow is a follows row with
-- target_kind = 'topic'; there is no separate topic-follow table (section 9's
-- TopicSource / FollowedTopicsQueryHydrator read this table filtered on target_kind).
create table public.follows (
  id               uuid primary key default gen_random_uuid(),
  follower_user_id uuid not null references public.users(id) on delete cascade,
  target_kind      text not null default 'user' check (target_kind in ('user','topic')),
  followee_user_id uuid references public.users(id) on delete cascade,  -- target_kind = 'user'
  topic_id         text,   -- target_kind = 'topic'; a post_classifications.topics value (section 8)
  actor_agent_id   uuid references public.agent_identities(id) on delete set null,
  created_at       timestamptz not null default now(),
  constraint follows_no_self check (followee_user_id is null or follower_user_id <> followee_user_id),
  constraint follows_target_exactly_one check (
    (target_kind = 'user'  and followee_user_id is not null and topic_id is null) or
    (target_kind = 'topic' and topic_id is not null and followee_user_id is null)
  ),
  constraint follows_topic_shape check (topic_id is null or topic_id ~ '^[a-z0-9][a-z0-9_-]{1,62}$')
);
-- Forward edges: "who / what do I follow". One partial unique index per target kind
-- replaces the composite PK a nullable followee column cannot carry.
create unique index follows_user_edge_uniq  on public.follows (follower_user_id, followee_user_id)
  where target_kind = 'user';
create unique index follows_topic_edge_uniq on public.follows (follower_user_id, topic_id)
  where target_kind = 'topic';
-- Reverse edge: "who follows me", and the in-network fan-out read.
create index follows_followee_idx on public.follows (followee_user_id, created_at desc)
  where target_kind = 'user';
create index follows_topic_idx on public.follows (topic_id, created_at desc)
  where target_kind = 'topic';

create table public.blocks (
  blocker_user_id uuid not null references public.users(id) on delete cascade,
  blocked_user_id uuid not null references public.users(id) on delete cascade,
  reason          text,
  created_at      timestamptz not null default now(),
  primary key (blocker_user_id, blocked_user_id),
  constraint blocks_no_self check (blocker_user_id <> blocked_user_id)
);
create index blocks_blocked_idx on public.blocks (blocked_user_id);

create table public.mutes (
  id            uuid primary key default gen_random_uuid(),
  muter_user_id uuid not null references public.users(id) on delete cascade,
  muted_user_id uuid references public.users(id) on delete cascade,
  muted_keyword text,
  expires_at    timestamptz,
  created_at    timestamptz not null default now(),
  constraint mutes_target_exactly_one check (
    (muted_user_id is not null and muted_keyword is null) or
    (muted_user_id is null and muted_keyword is not null)
  ),
  constraint mutes_no_self check (muted_user_id is null or muted_user_id <> muter_user_id),
  constraint mutes_keyword_len check (muted_keyword is null or length(muted_keyword) between 2 and 60)
);
create unique index mutes_user_target_uniq on public.mutes (muter_user_id, muted_user_id)
  where muted_user_id is not null;
create unique index mutes_user_keyword_uniq on public.mutes (muter_user_id, lower(muted_keyword))
  where muted_keyword is not null;
create index mutes_muter_idx on public.mutes (muter_user_id);

create table public.likes (
  post_id        uuid not null references public.posts(id) on delete cascade,
  user_id        uuid not null references public.users(id) on delete cascade,
  actor_agent_id uuid references public.agent_identities(id) on delete set null,
  created_at     timestamptz not null default now(),
  primary key (post_id, user_id)
);
create index likes_user_recent_idx on public.likes (user_id, created_at desc);

create table public.bookmarks (
  post_id        uuid not null references public.posts(id) on delete cascade,
  user_id        uuid not null references public.users(id) on delete cascade,
  actor_agent_id uuid references public.agent_identities(id) on delete set null,
  collection     text,
  created_at     timestamptz not null default now(),
  primary key (post_id, user_id)
);
create index bookmarks_user_recent_idx on public.bookmarks (user_id, created_at desc);

create table public.reposts (
  id             uuid primary key default gen_random_uuid(),
  post_id        uuid not null references public.posts(id) on delete cascade,
  user_id        uuid not null references public.users(id) on delete cascade,
  actor_agent_id uuid references public.agent_identities(id) on delete set null,
  quote_body     text,
  created_at     timestamptz not null default now(),
  constraint reposts_quote_len check (quote_body is null or length(quote_body) <= 2000)
);
-- One plain repost per user per post; unlimited quote-reposts.
create unique index reposts_plain_uniq on public.reposts (post_id, user_id) where quote_body is null;
create index reposts_user_recent_idx on public.reposts (user_id, created_at desc);
create index reposts_post_idx on public.reposts (post_id, created_at desc);

create table public.comments (
  id                uuid primary key default gen_random_uuid(),
  post_id           uuid not null references public.posts(id) on delete cascade,
  author_user_id    uuid not null references public.users(id) on delete cascade,
  actor_agent_id    uuid references public.agent_identities(id) on delete set null,
  parent_comment_id uuid references public.comments(id) on delete cascade,
  thread_root_id    uuid references public.comments(id) on delete cascade,
  depth             smallint not null default 0,
  body_markdown     text not null,
  content_hash      text not null,
  status            post_status not null default 'published',
  edited_at         timestamptz,
  deleted_at        timestamptz,
  created_at        timestamptz not null default now(),
  constraint comments_depth_bounded check (depth between 0 and 6),
  constraint comments_body_len check (length(body_markdown) between 1 and 10000),
  constraint comments_hash_len check (length(content_hash) = 64),
  constraint comments_root_consistency check (
    (parent_comment_id is null and thread_root_id is null and depth = 0) or
    (parent_comment_id is not null and thread_root_id is not null and depth > 0)
  )
);
create index comments_post_thread_idx on public.comments (post_id, thread_root_id nulls first, created_at)
  where deleted_at is null;
create index comments_author_recent_idx on public.comments (author_user_id, created_at desc);
create index comments_parent_idx on public.comments (parent_comment_id) where parent_comment_id is not null;

-- RLS
alter table public.follows   enable row level security;
alter table public.likes     enable row level security;
alter table public.reposts   enable row level security;
alter table public.comments  enable row level security;
alter table public.blocks    enable row level security;  -- owner-readable only
alter table public.mutes     enable row level security;  -- owner-readable only
alter table public.bookmarks enable row level security;  -- owner-readable only

grant select on public.follows, public.likes, public.reposts, public.comments to anon, authenticated;
create policy follows_public_read  on public.follows  for select to anon, authenticated using (true);
create policy likes_public_read    on public.likes    for select to anon, authenticated using (true);
create policy reposts_public_read  on public.reposts  for select to anon, authenticated using (true);
create policy comments_public_read on public.comments for select to anon, authenticated
  using (deleted_at is null and status = 'published');

grant select on public.blocks, public.mutes, public.bookmarks to authenticated;
create policy blocks_owner_read    on public.blocks    for select to authenticated
  using (blocker_user_id = (select auth.uid()));
create policy mutes_owner_read     on public.mutes     for select to authenticated
  using (muter_user_id = (select auth.uid()));
create policy bookmarks_owner_read on public.bookmarks for select to authenticated
  using (user_id = (select auth.uid()));
