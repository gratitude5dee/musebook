-- supabase/migrations/20261103090300_muse_mixer.sql  (M13)
-- Owned by section 9. Two tables, two dimension rows, two functions.
-- Everything else the ranker reads belongs to section 4 or section 13.

-- SimClusters analog: creator -> cluster memberships, rebuilt daily by the
-- creator-clusters Cron handler in apps/worker (below).
create table public.creator_clusters (
  creator_user_id uuid not null references public.users(id) on delete cascade,
  cluster_id      integer not null,
  weight          real not null,
  computed_at     timestamptz not null default now(),
  primary key (creator_user_id, cluster_id),
  constraint creator_clusters_weight_range check (weight >= 0 and weight <= 1)
);
create index creator_clusters_cluster_idx on public.creator_clusters (cluster_id, weight desc);

-- Previously-seen state, one row per human viewer. The current and previous
-- week's serialized bloom filter (section 9.16) plus an exact ring buffer of the
-- last MUSE_SEEN_EXACT_WINDOW served ids. Agent viewers have no row: MCP feeds
-- dedupe on the ids the previous slate carried.
create table public.viewer_seen_bloom (
  viewer_user_id   uuid primary key references public.users(id) on delete cascade,
  iso_week         text not null,                       -- '2026-W38', the week filter_json covers
  filter_json      jsonb not null,
  prev_filter_json jsonb,                               -- last week's filter; null after the first week
  recent_ids       uuid[] not null default '{}',
  updated_at       timestamptz not null default now(),
  constraint viewer_seen_bloom_week_shape check (iso_week ~ '^\d{4}-W\d{2}$'),
  constraint viewer_seen_bloom_recent_len check (cardinality(recent_ids) <= 500)
);

-- Both are jobs-plane only, exactly like slates and slate_items in 4.14's matrix:
-- written by the mixer's side effects and the Cron handlers, read by the mixer.
alter table public.creator_clusters  enable row level security;
alter table public.viewer_seen_bloom enable row level security;
alter table public.creator_clusters  force  row level security;
alter table public.viewer_seen_bloom force  row level security;
grant select, insert, update, delete on public.creator_clusters  to musebook_jobs;
grant select, insert, update, delete on public.viewer_seen_bloom to musebook_jobs;
create policy creator_clusters_jobs_all on public.creator_clusters
  for all to musebook_jobs using (true) with check (true);
create policy viewer_seen_bloom_jobs_all on public.viewer_seen_bloom
  for all to musebook_jobs using (true) with check (true);

-- Degradation ladder rung B3 (section 9.20) sorts by sourceScore without weights and
-- must still satisfy the FKs on slates and action_events. One row in each dimension.
insert into public.ranking_weights (weights_version, cohort, weights, is_active, notes, created_at)
values ('degraded', 'degraded',
        '{"discrete":{},"continuous":{},"gates":{}}'::jsonb, false,
        'Sentinel: slate served by sourceScore only. Never activated, never deleted.',
        timestamptz '2026-09-22 12:00:00+00')
on conflict (weights_version) do nothing;
-- `status` is 'retired', not a bespoke 'sentinel': section 4.8's
-- model_registry_status_allowed admits only candidate|shadow|active|retired, and a
-- retired row still satisfies the foreign keys on slates and action_events while
-- model_registry_one_active (unique on family where status = 'active') stays free for
-- the live 'reverse_chron' row section 4.15 seeds.
insert into public.model_registry (model_version, family, status, created_at)
values ('degraded', 'reverse_chron', 'retired', timestamptz '2026-09-22 12:00:00+00')
on conflict (model_version) do nothing;

-- ---------------------------------------------------------------- read_slate
-- THE ONE READ the request path performs. It exists because 4.14's grant matrix
-- admits ONLY musebook_jobs to slates and slate_items, and the surface that has to
-- read a slate is musebook-edge, which connects as the kernel plane. The choice is
-- between widening that matrix and shipping one narrow capability; this is the
-- narrow capability. It returns a rendered page of a slate and nothing else -- no
-- grant rows, no bodies, no scores for posts it did not return.
--
-- `viewer_entitled` here is PRESENTATIONAL: it decides whether a card draws a
-- paywall badge. It is never an authorization. Bytes are still gated by
-- resolveAccess() in the Worker, on HYPERDRIVE_FRESH (section 6, spine invariant 9).
create or replace function app.read_slate(
  p_viewer_user_id  uuid,
  p_viewer_agent_id uuid,
  p_surface         text,
  p_slate_id        uuid,      -- from the cursor; null selects the viewer's newest
  p_after_position  integer,
  p_limit           integer
) returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with s as (
    select *
      from public.slates
     where surface = p_surface
       and (p_slate_id is not null and id = p_slate_id
            or p_slate_id is null
               and (p_viewer_user_id is not null and viewer_user_id = p_viewer_user_id
                    or p_viewer_agent_id is not null and viewer_agent_id = p_viewer_agent_id
                    or p_viewer_user_id is null and p_viewer_agent_id is null
                       and viewer_user_id is null and viewer_agent_id is null))
     order by created_at desc
     limit 1
  ), items as (
    select i.position, i.post_id, i.source, i.score,
           p.content_hash, p.kind, p.slug, p.title, p.published_at,
           p.author_user_id,
           (p.posted_by_agent_id is not null) as creator_is_agent,
           exists (
             select 1 from public.access_grants g
              where g.content_hash = p.content_hash
                and g.revoked_at is null
                and (g.expires_at is null or g.expires_at > now())
                and g.subject_user_id = p_viewer_user_id
           ) as viewer_entitled
      from public.slate_items i
      join s on s.id = i.slate_id
      join public.posts p on p.id = i.post_id
     where i.position > p_after_position
       and p.status = 'published'
       and p.deleted_at is null
     order by i.position
     limit least(greatest(p_limit, 1), 100)
  )
  select jsonb_build_object(
    'slate_id',        (select id from s),
    'surface',         (select surface from s),
    'weights_version', (select weights_version from s),
    'model_version',   (select model_version from s),
    'created_at',      (select created_at from s),
    'expires_at',      (select expires_at from s),
    'candidate_count', (select candidate_count from s),
    'items',           coalesce((select jsonb_agg(to_jsonb(items) order by position) from items),
                                '[]'::jsonb))
  where exists (select 1 from s);
$$;
revoke all on function app.read_slate(uuid, uuid, text, uuid, integer, integer)
  from public, anon, authenticated;
grant execute on function app.read_slate(uuid, uuid, text, uuid, integer, integer)
  to musebook_kernel, musebook_jobs;

-- ------------------------------------------------------- retrieve_similar_posts
-- ANN retrieval, wrapped in a function for ONE reason: hnsw.ef_search has to be set
-- for the statement, and neither way of doing that inline works here. A bare
-- `set local` outside a transaction is a no-op with a warning; an explicit
-- BEGIN/COMMIT across round trips pins a Hyperdrive pooled connection and degrades
-- a ~100-connection pool (4.13, CF-spine §2); and pg's extended query protocol --
-- which is what a parameterised client.query() uses -- refuses a multi-statement
-- string. A function body runs in its own implicit transaction, so set_config with
-- is_local = true is scoped to exactly this call and reset when it returns.
create or replace function app.retrieve_similar_posts(
  p_probe      extensions.vector(1536),
  p_hours      integer,
  p_kinds      post_kind[],
  p_exclude    uuid[],
  p_limit      integer,
  p_ef_search  integer default 200
) returns table (
  post_id uuid, content_hash text, author_user_id uuid, creator_kind text,
  kind post_kind, published_at_ms double precision, remix_root_id uuid, sim double precision
)
language plpgsql
stable
security invoker
set search_path = public, extensions, pg_temp
as $$
begin
  perform set_config('hnsw.ef_search', p_ef_search::text, true);   -- true = SET LOCAL
  return query
    select p.id,
           p.content_hash,
           p.author_user_id,
           case when p.posted_by_agent_id is null then 'human' else 'agent' end,
           p.kind,
           (extract(epoch from p.published_at) * 1000)::double precision,
           -- artifacts.remix_root_id (section 11.13's 20261103090200_artifacts_versioning.sql,
           -- M16): the materialised root of the fork chain RemixDedupFilter dedupes on.
           -- Scalar subquery, not a join: a post may carry more than one artifacts row
           -- and the candidate set must not fan out. Null before M16 and for every
           -- non-artifact post. The column does not exist until M16's migration, so
           -- this lands as the constant NULL and §11.13 swaps in the subquery verbatim.
           null::uuid,
           1 - (e.embedding <=> p_probe)
      from public.post_embeddings e
      join public.posts p on p.content_hash = e.content_hash
      left join public.post_classifications c on c.content_hash = p.content_hash
     where p.status = 'published'
       and p.deleted_at is null
       and coalesce(c.is_nsfw, false) = false
       and p.published_at > now() - make_interval(hours => p_hours)
       and (p_kinds is null or p.kind = any(p_kinds))
       and not (p.author_user_id = any(p_exclude))
     order by e.embedding <=> p_probe
     limit p_limit;
end;
$$;
grant execute on function app.retrieve_similar_posts(
  extensions.vector, integer, post_kind[], uuid[], integer, integer) to musebook_jobs;

-- No cron.schedule here. Slate reaping is section 4.13's single `reap-slates` job
-- ('23 * * * *', expires_at < now() - interval '2 hours'); slate_items cascades.

-- §9.15: v1.0 serves HeuristicMuseRanker — its registry row must exist before a
-- scored slate can carry model_version='v1.model-heuristic' (slates FK).
-- family 'linear' (logistic priors = linear family); 'active' for that family —
-- the one_active index is per-family, so 'reverse_chron' stays untouched.
insert into public.model_registry (model_version, family, status, metrics, trained_at, created_at)
values ('v1.model-heuristic', 'linear', 'active', '{}'::jsonb,
        timestamptz '2026-09-22 12:00:00+00', timestamptz '2026-09-22 12:00:00+00')
on conflict (model_version) do nothing;

-- §9.23: the embed consumer's body read. post_bodies is kernel-plane (§4.14)
-- so a direct select is impossible under musebook_jobs — this narrow definer
-- is the capability, same pattern as D39's list_resource helpers. It returns
-- canonical_markdown for EVERY published body, paid included: a paywalled
-- body still feeds the embedding the paywall page ranks on.
create or replace function app.embed_post_bodies(p_content_hashes text[])
returns table (content_hash text, canonical_markdown text)
language plpgsql stable
security definer
set search_path = public, app, pg_temp
as $$
begin
  return query
    select b.content_hash, b.canonical_markdown
      from public.post_bodies b
     where b.content_hash = any(p_content_hashes);
end;
$$;
revoke all on function app.embed_post_bodies(text[]) from public, anon, authenticated;
grant execute on function app.embed_post_bodies(text[]) to musebook_worker;

-- ------------------------------------------- load_resources_by_post_ids
-- §9.8: MonetizationPort is one call per BATCH — the mixer's
-- MonetizationHydrator feeds a whole candidate set through the kernel
-- projection surface. post_bodies is kernel-plane, so the batch resource
-- read needs a narrow definer, same shape as
-- app.load_resource_by_post_id (20260922092004_edge_helpers.sql).
create or replace function app.load_resources_by_post_ids(
  p_post_ids uuid[],
  p_actor    uuid default null
)
returns table (
  post_id uuid, author_user_id uuid, author_display_name text, author_handle text,
  author_wallet text, kind text, status text, publish_mode text, slug text,
  title text, summary text, canonical_url text, language_code text, tags text[],
  content_hash text, canonical_markdown text, price_atomic text, price_asset text,
  price_network text, revenue_share_version text, license_spdx text, license_url text,
  train_ai boolean, ai_use boolean, search_indexable boolean,
  attribution_required boolean, citation_template text,
  published_at text, updated_at text
)
language plpgsql stable
set search_path = public, pg_temp
as $$
begin
  perform app.enter('musebook_kernel', p_actor);
  return query
    select
      p.id, p.author_user_id, pr.display_name, pr.handle, w.address,
      p.kind::text, p.status::text, p.publish_mode::text, p.slug, p.title,
      p.summary, p.canonical_url, p.language_code, p.tags, p.content_hash,
      b.canonical_markdown, p.price_atomic::text, p.price_asset, p.price_network,
      p.revenue_share_version,
      p.license_spdx, p.license_url, p.train_ai,
      p.ai_use, p.search_indexable, p.attribution_required, p.citation_template,
      to_char(p.published_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      to_char(p.updated_at   at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
    from public.posts p
    join public.post_bodies b on b.content_hash = p.content_hash
    join public.profiles   pr on pr.user_id = p.author_user_id
    left join lateral (
      select address from public.wallets
       where user_id = p.author_user_id and is_primary
       limit 1
    ) w on true
    where p.id = any(p_post_ids) and p.deleted_at is null;
end;
$$;
revoke all on function app.load_resources_by_post_ids(uuid[], uuid)
  from public, anon, authenticated;
grant execute on function app.load_resources_by_post_ids(uuid[], uuid)
  to musebook_worker;
-- Under the slate build's jobs-scoped session (`set role musebook_jobs`)
-- EXECUTE binds to the current role, not the session user — the same
-- capability reaches the mixer through the plane role (precedent:
-- app.staged_upload_target / app.delegation_for_drafting / rollups).
grant execute on function app.load_resources_by_post_ids(uuid[], uuid)
  to musebook_jobs;

-- ---------------------------------------- viewer_paid_content_hashes
-- The mixer's entitlements read: access_grants is kernel-plane (§4.14), so
-- the jobs-scoped feed build cannot select it raw. Same sanctioned shape as
-- app.load_resources_by_post_ids — one plpgsql call that enters the kernel
-- plane internally, returns every content_hash the viewer (or their wallet)
-- holds a live grant for. Filter by subject user OR payer wallet (either arm
-- satisfied is entitled — the same OR the M6 grant check uses).
create or replace function app.viewer_paid_content_hashes(
  p_subject_user_id uuid default null,
  p_payer_wallet     text default null
)
returns table (content_hash text)
language plpgsql stable
set search_path = public, pg_temp
as $$
begin
  perform app.enter('musebook_kernel', p_subject_user_id);
  return query
    select distinct g.content_hash
      from public.access_grants g
     where (g.subject_user_id = p_subject_user_id or g.payer = p_payer_wallet)
       and g.revoked_at is null
       and (g.expires_at is null or g.expires_at > now());
end;
$$;
revoke all on function app.viewer_paid_content_hashes(uuid, text)
  from public, anon, authenticated;
grant execute on function app.viewer_paid_content_hashes(uuid, text)
  to musebook_worker;
grant execute on function app.viewer_paid_content_hashes(uuid, text)
  to musebook_jobs;

-- ---------------------------------------- viewer block/mute capabilities
-- BlockMuteFilter needs the viewer's own block/mute sets. blocks/mutes are
-- deliberately user-facing-only — the sole policies are `*_owner_read` to
-- authenticated via auth.uid() — so no worker plane may hold a table grant,
-- and an invoker function can't read them under any plane either. The
-- sanctioned capability is therefore SECURITY DEFINER (the DSAR precedent):
-- the function is the boundary, and its predicate returns exactly the rows
-- the viewer's own policy would expose — live mutes only, matching the
-- adapter's predicate. Revoking EXECUTE from the app roles keeps it
-- worker-internal; no other caller can enumerate blocks through it.
create or replace function app.viewer_blocked_user_ids(p_viewer uuid)
returns table (blocked_user_id uuid)
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
begin
  return query
    select b.blocked_user_id
      from public.blocks b
     where b.blocker_user_id = p_viewer;
end;
$$;
revoke all on function app.viewer_blocked_user_ids(uuid)
  from public, anon, authenticated;
grant execute on function app.viewer_blocked_user_ids(uuid)
  to musebook_worker, musebook_jobs;

create or replace function app.viewer_mutes(p_viewer uuid)
returns table (muted_user_id uuid, muted_keyword text)
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
begin
  return query
    select m.muted_user_id, m.muted_keyword
      from public.mutes m
     where m.muter_user_id = p_viewer
       and (m.expires_at is null or m.expires_at > now());
end;
$$;
revoke all on function app.viewer_mutes(uuid)
  from public, anon, authenticated;
grant execute on function app.viewer_mutes(uuid)
  to musebook_worker, musebook_jobs;

-- assets is public-reader-visible already (musebook_public_reader holds
-- SELECT); the jobs plane needs the same read for CoreDataHydration's media
-- join — a strict-subset expansion of an already-public grant.
grant select on public.assets to musebook_jobs;

-- The hourly anon-slate mirror calls app.read_slate_doc under `set role
-- musebook_jobs`; EXECUTE binds to the current role there.
grant execute on function app.read_slate_doc(uuid, uuid, text, uuid, integer, integer, uuid)
  to musebook_jobs;

-- Grants alone don't pass RLS: assets has no jobs-plane read policy, so
-- MediaHydrator's loadMedia join returned zero rows for reels candidates.
-- Every row is already `using (true)` public to musebook_public_reader;
-- opening the same read to musebook_jobs expands nothing beyond that.
create policy assets_jobs_read on public.assets
  for select to musebook_jobs
  using (true);
