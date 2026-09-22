-- 12. Distribution: platforms, channels, platform_variants, distribution_jobs, platform_analytics.

create table public.platforms (
  slug              text primary key,     -- 'x' | 'linkedin' | 'mastodon' | 'bluesky' | ...
  display_name      text not null,
  max_chars         integer,
  max_images        smallint not null default 0,
  max_video_seconds integer,
  max_alt_chars     integer,
  supports_threads  boolean not null default false,
  supports_alt_text boolean not null default true,
  supports_link_preview boolean not null default true,
  aspect_ratios     jsonb not null default '[]'::jsonb,
  url_counts_as_chars integer,
  notes             text,
  updated_at        timestamptz not null default now(),
  constraint platforms_slug_shape check (slug ~ '^[a-z0-9][a-z0-9_-]{1,30}$')
);

create table public.channels (
  id                uuid primary key default gen_random_uuid(),
  owner_user_id     uuid not null references public.users(id) on delete cascade,
  platform          text not null references public.platforms(slug) on delete restrict,
  postiz_channel_id text not null,
  handle            text,
  display_name      text,
  avatar_url        text,
  credentials_ref   text,          -- Supabase Vault secret id; never a token in this row
  connected_at      timestamptz not null default now(),
  disabled_at       timestamptz,
  last_error        text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create unique index channels_owner_platform_channel_uniq
  on public.channels (owner_user_id, platform, postiz_channel_id);
create index channels_owner_idx on public.channels (owner_user_id) where disabled_at is null;

create table public.platform_variants (
  id               uuid primary key default gen_random_uuid(),
  post_id          uuid not null references public.posts(id) on delete cascade,
  post_version_id  uuid not null references public.post_versions(id) on delete cascade,
  platform         text not null references public.platforms(slug) on delete restrict,
  body             text not null,
  media            jsonb not null default '[]'::jsonb,
  thread_parts     jsonb,
  generated_by     text not null default 'llm',   -- 'llm' | 'deterministic' | 'human'
  validator_report jsonb not null default '{}'::jsonb,
  is_valid         boolean not null default false,
  approved_at      timestamptz,
  created_at       timestamptz not null default now(),
  constraint platform_variants_generated_by_allowed
    check (generated_by in ('llm','deterministic','human'))
);
create unique index platform_variants_version_platform_uniq
  on public.platform_variants (post_version_id, platform);
create index platform_variants_post_idx on public.platform_variants (post_id);

create table public.distribution_jobs (
  id               uuid primary key default gen_random_uuid(),
  post_id          uuid not null references public.posts(id) on delete cascade,
  post_version_id  uuid not null references public.post_versions(id) on delete cascade,
  channel_id       uuid not null references public.channels(id) on delete cascade,
  variant_id       uuid references public.platform_variants(id) on delete set null,
  state            job_state not null default 'queued',
  idempotency_key  text not null,
  postiz_post_id   text,
  platform_post_id text,
  platform_post_url text,
  scheduled_for    timestamptz,
  attempts         smallint not null default 0,
  last_error       text,
  request_payload  jsonb,
  response_payload jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint distribution_jobs_attempts_bounded check (attempts between 0 and 10)
);
create unique index distribution_jobs_version_channel_uniq
  on public.distribution_jobs (post_version_id, channel_id);
create unique index distribution_jobs_idem_uniq on public.distribution_jobs (idempotency_key);
create index distribution_jobs_due_idx on public.distribution_jobs (scheduled_for)
  where state = 'queued';
create index distribution_jobs_state_idx on public.distribution_jobs (state, updated_at desc);

create table public.platform_analytics (
  id               uuid primary key default gen_random_uuid(),
  channel_id       uuid not null references public.channels(id) on delete cascade,
  platform_post_id text not null,
  post_id          uuid references public.posts(id) on delete set null,
  collected_for    date not null,
  impressions      bigint not null default 0,
  likes            bigint not null default 0,
  comments         bigint not null default 0,
  shares           bigint not null default 0,
  clicks           bigint not null default 0,
  raw              jsonb not null default '{}'::jsonb,
  collected_at     timestamptz not null default now()
);
create unique index platform_analytics_daily_uniq
  on public.platform_analytics (channel_id, platform_post_id, collected_for);
create index platform_analytics_post_idx on public.platform_analytics (post_id, collected_for desc)
  where post_id is not null;

create trigger channels_set_updated_at before update on public.channels
  for each row execute function app.set_updated_at();
create trigger distribution_jobs_set_updated_at before update on public.distribution_jobs
  for each row execute function app.set_updated_at();

alter table public.platforms          enable row level security;
alter table public.channels           enable row level security;
alter table public.platform_variants  enable row level security;
alter table public.distribution_jobs  enable row level security;
alter table public.platform_analytics enable row level security;

grant select on public.platforms to anon, authenticated;
create policy platforms_public_read on public.platforms
  for select to anon, authenticated using (true);

grant select on public.channels, public.platform_variants,
               public.distribution_jobs, public.platform_analytics to authenticated;

create policy channels_owner_read on public.channels
  for select to authenticated using (owner_user_id = (select auth.uid()));

create policy platform_variants_owner_read on public.platform_variants
  for select to authenticated
  using (exists (select 1 from public.posts p
                 where p.id = platform_variants.post_id
                   and p.author_user_id = (select auth.uid())));

create policy distribution_jobs_owner_read on public.distribution_jobs
  for select to authenticated
  using (exists (select 1 from public.channels c
                 where c.id = distribution_jobs.channel_id
                   and c.owner_user_id = (select auth.uid())));

create policy platform_analytics_owner_read on public.platform_analytics
  for select to authenticated
  using (exists (select 1 from public.channels c
                 where c.id = platform_analytics.channel_id
                   and c.owner_user_id = (select auth.uid())));
