-- supabase/migrations/20260922091900_platform_constraints.sql   (M10; section 16.8)
-- Extends section 4.12's public.platforms with the columns the reformatter
-- reads, and section 4.9's action_events_daily with a provenance column so
-- off-platform signal never collides with on-platform signal. Section 4.18 is
-- the registry row for this file.

alter table public.platforms
  add column postiz_identifier   text,
  add column count_method        text    not null default 'utf16',
  add column editor              text    not null default 'normal',
  add column min_media           smallint not null default 0,
  add column max_videos          smallint not null default 0,
  add column max_title_chars     integer,
  add column max_thread_parts    smallint,
  add column max_hashtags        smallint,
  add column hashtag_style       text    not null default 'inline',
  add column requires_alt_text   boolean not null default false,
  add column media_rules         jsonb   not null default '{}'::jsonb,
  add column stagger_seconds     integer not null default 0,
  add column concurrency_ceiling integer,
  add column analytics_supported boolean not null default false,
  add column limits_source       text    not null default 'unverified',
  add column limits_checked_at   date;

-- The launch set's 'x' slug is one character; §4.12's shape demanded >= 2.
-- Deviation: widen the bound to {0,30} so the verbatim seed applies.
alter table public.platforms drop constraint platforms_slug_shape;
alter table public.platforms
  add constraint platforms_slug_shape check (slug ~ '^[a-z0-9][a-z0-9_-]{0,30}$');

alter table public.platforms
  add constraint platforms_count_method_allowed
    check (count_method in ('utf16','utf8_bytes','graphemes','x_weighted')),
  add constraint platforms_editor_allowed
    check (editor in ('none','normal','markdown','html')),
  add constraint platforms_hashtag_style_allowed
    check (hashtag_style in ('inline','trailing','none','field')),
  add constraint platforms_media_bounds
    check (min_media >= 0 and max_images >= 0 and max_videos >= 0
           and min_media <= greatest(max_images, max_videos)),
  add constraint platforms_limits_source_allowed
    check (limits_source in ('postiz@v1.47.0','primary','unverified'));

comment on column public.platforms.count_method is
  'How the platform counts length. x_weighted = twitter-text parseTweet().weightedLength; '
  'utf8_bytes = TextEncoder().encode(s).length; graphemes = Intl.Segmenter grapheme clusters; '
  'utf16 = String.prototype.length. Getting this wrong is the #1 cause of accepted-then-rejected.';
comment on column public.platforms.limits_source is
  'Provenance. postiz@v1.47.0 = read from the running sidecar''s enforcement code. '
  'primary = read from the platform''s own spec/source. unverified = training data; '
  'the executor MUST confirm before first send.';

-- Provenance for aggregated engagement, so the rollup writer (source = ''musebook'')
-- and the distribution collector (source = <platform slug>) cannot overwrite each
-- other. See 12.3.10.
alter table public.action_events_daily add column source text not null default 'musebook';
alter table public.action_events_daily drop constraint action_events_daily_pkey;
alter table public.action_events_daily
  add constraint action_events_daily_pkey
  primary key (day, actor_plane, source, post_id, action);
alter table public.action_events_daily
  add constraint action_events_daily_source_shape
  check (source = 'musebook' or source ~ '^[a-z0-9][a-z0-9_-]{1,30}$');

-- Two counters Postiz reports that section 4.12's platform_analytics has no home for.
alter table public.platform_analytics
  add column saves   bigint not null default 0,
  add column reposts bigint not null default 0;

-- §12.3.1's per-channel override cache: Postiz's live maxLength + @Rules text,
-- refreshed weekly (0 4 * * 1) and once at channel connect. The reformatter
-- prefers these over the platforms row.
create table public.channel_constraint_overrides (
  channel_id     uuid primary key references public.channels(id) on delete cascade,
  max_chars      integer,
  rules_text     text,
  settings_schema jsonb,
  tools          jsonb not null default '[]'::jsonb,
  refreshed_at   timestamptz not null default now()
);
alter table public.channel_constraint_overrides enable row level security;
alter table public.channel_constraint_overrides force row level security;
grant select on public.channel_constraint_overrides to authenticated;
-- worker-plane access reaches this table through musebook_jobs (91902);
-- musebook_worker is never granted directly on tables (assert-rls axis A).
create policy cco_owner_read on public.channel_constraint_overrides
  for select to authenticated
  using (exists (select 1 from public.channels c
                 where c.id = channel_constraint_overrides.channel_id
                   and c.owner_user_id = (select auth.uid())));
