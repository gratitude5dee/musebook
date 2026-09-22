-- 08. Ranking: ranking_weights, model_registry, slates, slate_items.

create table public.ranking_weights (
  weights_version text primary key,
  cohort          text not null default 'default',
  weights         jsonb not null,
  is_active       boolean not null default false,
  notes           text,
  created_at      timestamptz not null default now(),
  activated_at    timestamptz,
  constraint ranking_weights_version_shape check (weights_version ~ '^[a-z0-9._-]{1,64}$')
);
create unique index ranking_weights_one_active_per_cohort
  on public.ranking_weights (cohort) where is_active;
create index ranking_weights_cohort_idx on public.ranking_weights (cohort, created_at desc);

create table public.model_registry (
  model_version text primary key,
  family        text not null,       -- 'reverse_chron' | 'linear' | 'gbdt' | 'transformer'
  artifact_url  text,
  input_dim     integer,
  trained_at    timestamptz,
  metrics       jsonb not null default '{}'::jsonb,
  status        text not null default 'candidate',
  created_at    timestamptz not null default now(),
  constraint model_registry_status_allowed check (status in ('candidate','shadow','active','retired')),
  constraint model_registry_version_shape check (model_version ~ '^[a-z0-9._-]{1,64}$')
);
create unique index model_registry_one_active on public.model_registry (family) where status = 'active';

create table public.slates (
  id              uuid primary key default gen_random_uuid(),
  viewer_user_id  uuid references public.users(id) on delete cascade,
  viewer_agent_id uuid references public.agent_identities(id) on delete cascade,
  -- One surface vocabulary for the whole plan: SURFACES in
  -- packages/schema/src/surface.ts, printed once in 13.3 and imported by 4.2
  -- including 'reels'. Stored as text rather than a Postgres enum because
  -- `syndicated:<platform>` grows with the platforms table; the TypeScript union
  -- is the closed set, validated before insert.
  surface         text not null,
  weights_version text not null references public.ranking_weights(weights_version),
  model_version   text not null references public.model_registry(model_version),
  candidate_count integer not null default 0,
  params          jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null default (now() + interval '30 minutes')
);
create index slates_viewer_recent_idx on public.slates (viewer_user_id, created_at desc)
  where viewer_user_id is not null;
create index slates_expires_idx on public.slates (expires_at);

create table public.slate_items (
  slate_id       uuid not null references public.slates(id) on delete cascade,
  position       integer not null,
  post_id        uuid not null references public.posts(id) on delete cascade,
  source         text not null,      -- 'in_network' | 'embedding_nn' | 'trending' | 'topic'
  action_scores  jsonb not null default '{}'::jsonb,  -- pure, cacheable, per viewer-post
  weighted_score double precision,                     -- pure, runtime-weighted
  score          double precision,                     -- post-diversity, slate-dependent
  primary key (slate_id, position),
  constraint slate_items_position_non_negative check (position >= 0)
);
create unique index slate_items_slate_post_uniq on public.slate_items (slate_id, post_id);
create index slate_items_post_idx on public.slate_items (post_id);

alter table public.ranking_weights enable row level security;  -- jobs plane only (4.14)
alter table public.model_registry  enable row level security;  -- jobs plane only (4.14)
alter table public.slates          enable row level security;  -- jobs plane only (4.14)
alter table public.slate_items     enable row level security;  -- jobs plane only (4.14)
