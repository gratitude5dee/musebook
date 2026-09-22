-- 04. Content: posts, post_versions, post_bodies, artifacts, assets, post_counters.

-- Immutable, content-addressed body store. The CHECK is spine invariant 1, enforced by Postgres.
create table public.post_bodies (
  content_hash      text primary key,
  canonical_markdown text not null,
  byte_len          integer not null,
  created_at        timestamptz not null default now(),
  constraint post_bodies_hash_len check (length(content_hash) = 64),
  constraint post_bodies_hash_matches
    check (content_hash = app.sha256_hex(canonical_markdown)),
  constraint post_bodies_byte_len_matches
    check (byte_len = octet_length(canonical_markdown))
);

create table public.posts (
  id                uuid primary key default gen_random_uuid(),
  author_user_id    uuid not null references public.users(id) on delete restrict,
  posted_by_agent_id uuid references public.agent_identities(id) on delete set null,
  kind              post_kind not null,
  status            post_status not null default 'draft',
  publish_mode      publish_mode not null default 'free',
  slug              text not null,    -- GLOBALLY unique; the public URL is /p/{slug}
  title             text,
  summary           text,
  canonical_url     text,
  og_image_url      text,             -- 1200x630 preview read by section 7.12's generateMetadata
  language_code     text not null default 'en',
  tags              text[] not null default '{}',
  content_hash      text not null references public.post_bodies(content_hash) on delete restrict,
  current_version   integer not null default 1,
  price_atomic      numeric(78,0) not null default 0,
  price_asset       text,            -- ERC-20 address; null when price_atomic = 0
  price_network     text,            -- CAIP-2, e.g. 'eip155:8453'
  -- License is first-class. Seeded from creator_publishing_defaults at compose time;
  -- read by section 6.8 usageHeadersFor, 7.5 get_post, 7.12 JSON-LD license/usageInfo,
  -- 7.13 llms-full.txt and 7.17 get_license_terms. Never derived from publish_mode.
  license_spdx      text not null default 'CC-BY-4.0',
  license_url       text,
  train_ai          boolean not null default false,
  ai_use            boolean not null default false,
  search_indexable  boolean not null default true,
  attribution_required boolean not null default true,
  citation_template text,
  parent_post_id    uuid references public.posts(id) on delete set null,  -- thread member
  scheduled_for     timestamptz,
  published_at      timestamptz,
  deleted_at        timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  search_tsv tsvector generated always as (
    setweight(to_tsvector('english'::regconfig, coalesce(title, '')),   'A') ||
    setweight(to_tsvector('english'::regconfig, coalesce(summary, '')), 'B')
  ) stored,
  constraint posts_slug_shape check (slug ~ '^[a-z0-9][a-z0-9-]{1,79}$'),
  constraint posts_article_needs_title check (kind <> 'article' or title is not null),
  constraint posts_price_consistency check (
    (price_atomic = 0 and price_asset is null and price_network is null) or
    (price_atomic > 0 and price_asset is not null and price_network is not null)
  ),
  constraint posts_paid_modes_have_price check (
    publish_mode = 'free' or price_atomic > 0
  ),
  constraint posts_published_has_timestamp check (
    status <> 'published' or published_at is not null
  ),
  constraint posts_lang_shape check (language_code ~ '^[a-z]{2}(-[A-Z]{2})?$'),
  -- Same enum section 11.11's artifact manifest uses. 'ARR' = all rights reserved.
  constraint posts_license_spdx_allowed check (license_spdx in
    ('CC0-1.0','CC-BY-4.0','CC-BY-SA-4.0','CC-BY-NC-4.0','CC-BY-ND-4.0','ARR','MIT','Apache-2.0'))
);

-- The slug is globally unique among live posts, because the canonical URL is /p/{slug}
-- and the x402 grant, the JSON-LD @id and the Link: rel=canonical header all bind to it.
-- The composer's slug generator appends a 4-char base32 disambiguator on conflict.
create unique index posts_slug_uniq on public.posts (slug) where deleted_at is null;
create index posts_feed_idx on public.posts (published_at desc, id desc)
  where status = 'published' and deleted_at is null;
create index posts_author_recent_idx on public.posts (author_user_id, published_at desc)
  where status = 'published' and deleted_at is null;
create index posts_content_hash_idx on public.posts (content_hash);
create index posts_kind_published_idx on public.posts (kind, published_at desc)
  where status = 'published' and deleted_at is null;
create index posts_tags_gin on public.posts using gin (tags);
create index posts_search_gin on public.posts using gin (search_tsv);
create index posts_scheduled_idx on public.posts (scheduled_for)
  where status = 'scheduled';

create table public.post_versions (
  id            uuid primary key default gen_random_uuid(),
  post_id       uuid not null references public.posts(id) on delete cascade,
  version       integer not null,
  content_hash  text not null references public.post_bodies(content_hash) on delete restrict,
  title         text,
  summary       text,
  editor_user_id uuid references public.users(id) on delete set null,
  editor_agent_id uuid references public.agent_identities(id) on delete set null,
  change_note   text,
  created_at    timestamptz not null default now(),
  constraint post_versions_version_positive check (version >= 1)
);
create unique index post_versions_post_version_uniq on public.post_versions (post_id, version);
create index post_versions_hash_idx on public.post_versions (content_hash);
create index post_versions_post_recent_idx on public.post_versions (post_id, version desc);

create table public.artifacts (
  id          uuid primary key default gen_random_uuid(),
  post_id     uuid not null references public.posts(id) on delete cascade,
  kind        text not null,      -- bundle format: 'html_bundle' | 'react_app' (post_kind 'app'),
                                  -- 'glb' (post_kind 'model3d'), 'image_set'
  bundle_url  text not null,      -- artifacts.musebook.dev/a/<id>/
  entry_path  text not null default 'index.html',
  sha256      text not null,
  byte_len    bigint not null,
  csp_profile text not null default 'strict',
  poster_asset_id uuid,
  created_at  timestamptz not null default now(),
  constraint artifacts_kind_allowed check (kind in ('html_bundle','glb','image_set','react_app')),
  constraint artifacts_sha_len check (length(sha256) = 64)
);
create index artifacts_post_idx on public.artifacts (post_id);
create unique index artifacts_sha_uniq on public.artifacts (sha256);

create table public.assets (
  id            uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references public.users(id) on delete cascade,
  -- WHICH R2 BUCKET. This column is the paywall's storage-side invariant:
  -- 'r2_public' is the ONLY value reachable without a Worker, because
  -- cdn.musebook.dev is a bucket-wide, unconditionally public R2 custom domain
  -- (CF-spine §5). An asset attached to a paid post must never be 'r2_public'.
  storage       text not null,
  object_key    text not null,   -- key within that bucket; <= 1024 bytes (R2 limit)
  url           text not null,   -- resolved public/serving URL; see the note below
  content_type  text not null,
  byte_len      bigint not null,
  sha256        text not null,
  width         integer,
  height        integer,
  duration_ms   integer,
  alt_text      text,
  c2pa_manifest jsonb,
  created_at    timestamptz not null default now(),
  constraint assets_storage_allowed
    check (storage in ('r2_public','r2_paid','r2_artifacts')),
  constraint assets_object_key_len check (length(object_key) between 1 and 1024),
  -- A public asset resolves on the R2 custom domain and nowhere else; a paid asset
  -- resolves on the Worker route and MUST NOT carry a cdn.musebook.dev URL, which
  -- would be publicly fetchable by anyone who guessed the key.
  constraint assets_url_matches_bucket check (
    (storage = 'r2_public'    and url like 'https://cdn.musebook.dev/%') or
    (storage = 'r2_paid'      and url like 'https://media.musebook.dev/%') or
    (storage = 'r2_artifacts' and url like 'https://artifacts.musebook.dev/%')
  ),
  constraint assets_sha_len check (length(sha256) = 64)
);
create index assets_storage_key_idx on public.assets (storage, object_key);
create unique index assets_sha_owner_uniq on public.assets (owner_user_id, sha256);
create index assets_owner_recent_idx on public.assets (owner_user_id, created_at desc);

alter table public.artifacts
  add constraint artifacts_poster_fk
  foreign key (poster_asset_id) references public.assets(id) on delete set null;

create table public.post_assets (
  post_id  uuid not null references public.posts(id) on delete cascade,
  asset_id uuid not null references public.assets(id) on delete restrict,
  position smallint not null default 0,
  primary key (post_id, asset_id)
);
create index post_assets_asset_idx on public.post_assets (asset_id);

-- SPINE INVARIANT 4: counters NEVER live on the post row.
create table public.post_counters (
  post_id        uuid primary key references public.posts(id) on delete cascade,
  likes          bigint not null default 0,
  comments       bigint not null default 0,
  reposts        bigint not null default 0,
  bookmarks      bigint not null default 0,
  impressions    bigint not null default 0,
  opens          bigint not null default 0,
  dwell_ms_total bigint not null default 0,
  paid_fetches   bigint not null default 0,
  updated_at     timestamptz not null default now(),
  constraint post_counters_non_negative check (
    likes >= 0 and comments >= 0 and reposts >= 0 and bookmarks >= 0
    and impressions >= 0 and opens >= 0 and dwell_ms_total >= 0 and paid_fetches >= 0
  )
);
create index post_counters_likes_idx on public.post_counters (likes desc);
create index post_counters_impressions_idx on public.post_counters (impressions desc);

-- Atomic counter adjustment. Ports the shape of MogBook's adjust_mog_post_metric
-- (/home/user/mog/supabase/migrations/20260204231433_9e81d178-149a-4b1a-a25b-0d78b7f3efc5.sql),
-- which correctly replaces read-modify-write races with one UPDATE and clamps at zero.
create or replace function public.adjust_post_counter(
  p_post_id uuid,
  p_metric  text,
  p_delta   bigint
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_metric not in ('likes','comments','reposts','bookmarks',
                      'impressions','opens','dwell_ms_total','paid_fetches') then
    raise exception 'adjust_post_counter: unknown metric %', p_metric using errcode = '22023';
  end if;
  execute format(
    'insert into public.post_counters (post_id, %1$I, updated_at)
       values ($1, greatest($2, 0), now())
     on conflict (post_id) do update
       set %1$I = greatest(post_counters.%1$I + $2, 0),
           updated_at = now()',
    p_metric
  ) using p_post_id, p_delta;
end;
$$;
-- The old project fires anon_security_definer_function_executable on 55 functions.
-- Do not repeat that: no client may execute this. 4.14 grants it to musebook_jobs
-- and to nobody else, so a counter is only ever moved by a queue consumer.
revoke all on function public.adjust_post_counter(uuid, text, bigint) from public, anon, authenticated;

-- Per-creator defaults that seed every new posts row. The composer (section 14.4.9)
-- copies these onto the post at compose time; the post then owns its own values and
-- a later change to the defaults is never retroactive.
create table public.creator_publishing_defaults (
  user_id      uuid primary key references public.users(id) on delete cascade,
  publish_mode publish_mode not null default 'free',
  license_spdx text not null default 'CC-BY-4.0',
  train_ai     boolean not null default false,
  ai_use       boolean not null default false,
  -- USD cents. The composer converts to atomic units for posts.price_atomic
  -- (USDC, 6 decimals: cents * 10000). This is the only non-atomic money column
  -- in the schema, and it is a creator preference, not a ledger value.
  price_cents  integer not null default 0,
  updated_at   timestamptz not null default now(),
  constraint creator_publishing_defaults_price_non_negative check (price_cents >= 0),
  constraint creator_publishing_defaults_paid_modes_have_price check (
    publish_mode = 'free' or price_cents > 0
  ),
  constraint creator_publishing_defaults_license_allowed check (license_spdx in
    ('CC0-1.0','CC-BY-4.0','CC-BY-SA-4.0','CC-BY-NC-4.0','CC-BY-ND-4.0','ARR','MIT','Apache-2.0'))
);

-- The platform-wide fallback price. Exactly one row (id is a singleton boolean),
-- seeded in 4.15. Section 10.10.3 reads it when a forced publish_mode change finds
-- no creator_publishing_defaults.price_cents to copy; section 6.7's accepts[] builder
-- reads price_asset / price_network for a post whose own columns are null.
create table public.platform_publishing_defaults (
  id                 boolean primary key default true,
  read_price_atomic  numeric(78,0) not null default 250000,  -- $0.25, USDC 6 decimals
  crawl_price_atomic numeric(78,0) not null default 2000,    -- $0.002, USDC 6 decimals
  price_asset        text not null,                          -- ERC-20 contract address
  price_network      text not null default 'eip155:8453',    -- CAIP-2, Base mainnet
  updated_at         timestamptz not null default now(),
  constraint platform_publishing_defaults_singleton check (id),
  constraint platform_publishing_defaults_prices_positive
    check (read_price_atomic > 0 and crawl_price_atomic > 0),
  constraint platform_publishing_defaults_asset_shape check (app.is_evm_address(price_asset)),
  constraint platform_publishing_defaults_network_caip2
    check (price_network ~ '^[a-z0-9-]{3,8}:[a-zA-Z0-9_-]{1,32}$')
);

create trigger posts_set_updated_at before update on public.posts for each row execute function app.set_updated_at();
create trigger creator_publishing_defaults_set_updated_at before update on public.creator_publishing_defaults
  for each row execute function app.set_updated_at();
create trigger platform_publishing_defaults_set_updated_at before update on public.platform_publishing_defaults
  for each row execute function app.set_updated_at();

-- RLS
alter table public.post_bodies    enable row level security;  -- KERNEL PLANE ONLY (4.14). No paywall bypass path exists.
alter table public.post_versions  enable row level security;  -- kernel plane only (4.14)
alter table public.assets         enable row level security;
alter table public.posts          enable row level security;
alter table public.artifacts      enable row level security;
alter table public.post_assets    enable row level security;
alter table public.post_counters  enable row level security;
alter table public.creator_publishing_defaults enable row level security;
alter table public.platform_publishing_defaults enable row level security;

grant select on public.posts, public.artifacts, public.post_assets, public.post_counters to anon, authenticated;

create policy posts_public_read on public.posts
  for select to anon, authenticated
  using (status = 'published' and deleted_at is null);

create policy artifacts_public_read on public.artifacts
  for select to anon, authenticated
  using (exists (
    select 1 from public.posts p
    where p.id = artifacts.post_id and p.status = 'published' and p.deleted_at is null
  ));

create policy post_assets_public_read on public.post_assets
  for select to anon, authenticated
  using (exists (
    select 1 from public.posts p
    where p.id = post_assets.post_id and p.status = 'published' and p.deleted_at is null
  ));

create policy post_counters_public_read on public.post_counters
  for select to anon, authenticated using (true);

grant select on public.assets to authenticated;
create policy assets_owner_read on public.assets
  for select to authenticated
  using (owner_user_id = (select auth.uid()));

grant select on public.creator_publishing_defaults to authenticated;
create policy creator_publishing_defaults_owner_read on public.creator_publishing_defaults
  for select to authenticated
  using (user_id = (select auth.uid()));

-- The fallback price is public: the composer's mode picker and the landing copy
-- both render it, and it contains nothing private.
grant select on public.platform_publishing_defaults to anon, authenticated;
create policy platform_publishing_defaults_public_read on public.platform_publishing_defaults
  for select to anon, authenticated using (true);
