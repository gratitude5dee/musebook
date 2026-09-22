-- 20260922092003_edge_helpers.sql — M6's per-capability statements.
--
-- RLS and table grants bind at PLAN time, so `app.enter(...)` and a privileged
-- read cannot be siblings in one SELECT (D23). The sanctioned shape is one
-- plpgsql helper that performs app.enter first, then runs its statements under
-- the plane's role — the same convention as app.read_slate / app.finish_job.
-- Every function below is SECURITY INVOKER except the two that must cross an
-- RLS boundary the planes intentionally keep: list_public_resources (post_bodies
-- is kernel-only, but free posts' canonical_markdown is exactly what
-- llms-full.txt is for) and lookup_asset_by_key (assets is owner-scoped, and the
-- media read path resolves keys for other authors' posts).
--
-- Return shapes are named `table` projections so node-postgres gives the edge
-- the snake_case rows its ResourceRow/catalog types declare.

-- ── kernel plane: the access-decision reads ─────────────────────────────────

create or replace function app.load_resource_by_slug(p_slug text, p_actor uuid default null)
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
      -- literal until 20260922091600 lands at M8: its backfill writes this
      -- same default onto every pre-M8 row, so the literal is identity-true.
      'rs_2026_09_v1'::text,
      p.license_spdx, p.license_url, p.train_ai,
      p.ai_use, p.search_indexable, p.attribution_required, p.citation_template,
      -- ISO text, not raw timestamptz: drivers hand back Date objects but
      -- ResourceRow/kernel fixtures carry "...Z" strings (zod: string).
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
    where p.slug = p_slug and p.deleted_at is null;
end;
$$;

create or replace function app.load_resource_by_post_id(p_post_id uuid, p_actor uuid default null)
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
      'rs_2026_09_v1'::text,
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
    where p.id = p_post_id and p.deleted_at is null;
end;
$$;

create or replace function app.find_live_grant(
  p_content_hash text,
  p_payer        text,
  p_agent_id     uuid,
  p_user_id      uuid,
  p_actor        uuid default null
)
returns table (
  id uuid, settlement_id uuid, content_hash text, payer text, expires_at timestamptz
)
language plpgsql stable
set search_path = public, pg_temp
as $$
begin
  perform app.enter('musebook_kernel', p_actor);
  return query
    select g.id, g.settlement_id, g.content_hash, g.payer, g.expires_at
      from public.access_grants g
     where g.content_hash = p_content_hash
       and g.revoked_at is null
       and (g.expires_at is null or g.expires_at > now())
       and ((p_payer    is not null and g.payer = lower(p_payer))
         or (p_agent_id is not null and g.subject_agent_id = p_agent_id)
         or (p_user_id  is not null and g.subject_user_id  = p_user_id))
     order by g.granted_at desc
     limit 1;
end;
$$;

create or replace function app.mint_grant(
  p_settlement_id    uuid,
  p_content_hash     text,
  p_post_id          uuid,
  p_payer            text,
  p_subject_agent_id uuid,
  p_subject_user_id  uuid,
  p_expires_at       timestamptz,
  p_actor            uuid default null
)
returns table (
  id uuid, settlement_id uuid, content_hash text, payer text, expires_at timestamptz
)
language plpgsql
set search_path = public, pg_temp
as $$
begin
  perform app.enter('musebook_kernel', p_actor);
  return query
    insert into public.access_grants
      (settlement_id, content_hash, post_id, payer,
       subject_agent_id, subject_user_id, expires_at)
    values
      (p_settlement_id, p_content_hash, p_post_id, lower(p_payer),
       p_subject_agent_id, p_subject_user_id, p_expires_at)
    -- No arbiter: the OUT param named `payer` makes a column arbiter
    -- ambiguous, and access_grants_payer_hash_uniq is the only reachable
    -- conflict anyway.
    on conflict do nothing
    returning access_grants.id, access_grants.settlement_id,
              access_grants.content_hash, access_grants.payer,
              access_grants.expires_at;
end;
$$;

-- §6.7.6 pinned quote. resource_url is the canonical /p/{slug} URL, never a
-- twin; requirements is the full PaymentRequired object as served.
create or replace function app.pin_quote(
  p_id            uuid,
  p_resource_url  text,
  p_post_id       uuid,
  p_content_hash  text,
  p_agent_id      uuid,
  p_transport     text,
  p_network       text,
  p_asset         text,
  p_pay_to        text,
  p_amount_atomic numeric,
  p_requirements  jsonb,
  p_actor         uuid default null
)
returns uuid
language plpgsql
set search_path = public, pg_temp
as $$
begin
  perform app.enter('musebook_kernel', p_actor);
  insert into public.x402_quotes
    (id, resource_url, post_id, content_hash, requested_by_agent, transport,
     network, asset, pay_to, amount_atomic, max_timeout_seconds, rate_source,
     requirements, expires_at)
  values
    (p_id, p_resource_url, p_post_id, p_content_hash, p_agent_id, p_transport,
     p_network, p_asset, p_pay_to, p_amount_atomic, 60, 'direct_usdc',
     p_requirements, now() + interval '60 seconds');
  return p_id;
end;
$$;

create or replace function app.is_agent_blocked(p_agent_id uuid, p_actor uuid default null)
returns boolean
language plpgsql stable
set search_path = public, pg_temp
as $$
declare v_blocked boolean;
begin
  perform app.enter('musebook_kernel', p_actor);
  select coalesce(ai.is_blocked, false) into v_blocked
    from public.agent_identities ai
   where ai.id = p_agent_id;
  return coalesce(v_blocked, false);
end;
$$;

-- ── catalog surface: the role-independent reads for CACHED ──────────────────

-- DEFINER on purpose (deviation D39): post_bodies is kernel-only and the bodies
-- are exactly what llms-full.txt serves — for free posts only, which the case
-- clause enforces before a gated body can cross the boundary.
create or replace function app.list_public_resources(p_limit integer)
returns table (
  post_id uuid, author_user_id uuid, author_handle text, author_display_name text,
  author_wallet text, kind text, status text, publish_mode text,
  slug text, title text, summary text, canonical_url text,
  language_code text, tags text[], content_hash text, canonical_markdown text,
  price_atomic text, price_asset text, price_network text,
  revenue_share_version text,
  license_spdx text, license_url text, train_ai boolean, ai_use boolean,
  search_indexable boolean, attribution_required boolean, citation_template text,
  published_at text, updated_at text
)
language plpgsql stable
security definer
set search_path = public, pg_temp
as $$
begin
  return query
    select
      p.id, p.author_user_id, pr.handle, pr.display_name, w.address,
      p.kind::text, p.status::text, p.publish_mode::text,
      p.slug, p.title, p.summary, p.canonical_url,
      p.language_code, p.tags, p.content_hash,
      case when p.publish_mode = 'free' then b.canonical_markdown else '' end,
      p.price_atomic::text, p.price_asset, p.price_network,
      'rs_2026_09_v1'::text,
      p.license_spdx, p.license_url, p.train_ai, p.ai_use,
      p.search_indexable, p.attribution_required, p.citation_template,
      to_char(p.published_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      to_char(p.updated_at   at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
    from public.posts p
    join public.profiles pr on pr.user_id = p.author_user_id
    left join public.post_bodies b on b.content_hash = p.content_hash
    left join lateral (
      select address from public.wallets
       where user_id = p.author_user_id and is_primary
       limit 1
    ) w on true
    where p.status in ('published', 'unlisted') and p.deleted_at is null
    order by p.published_at desc nulls last, p.id
    limit p_limit;
end;
$$;

create or replace function app.list_author_posts(p_handle text, p_limit integer)
returns table (
  post_id uuid, author_user_id uuid, author_handle text, author_display_name text,
  author_wallet text, kind text, status text, publish_mode text,
  slug text, title text, summary text, canonical_url text,
  language_code text, tags text[], content_hash text, canonical_markdown text,
  price_atomic text, price_asset text, price_network text,
  revenue_share_version text,
  license_spdx text, license_url text, train_ai boolean, ai_use boolean,
  search_indexable boolean, attribution_required boolean, citation_template text,
  published_at text, updated_at text
)
language plpgsql stable
security definer
set search_path = public, pg_temp
as $$
begin
  return query
    select
      p.id, p.author_user_id, pr.handle, pr.display_name, w.address,
      p.kind::text, p.status::text, p.publish_mode::text,
      p.slug, p.title, p.summary, p.canonical_url,
      p.language_code, p.tags, p.content_hash,
      case when p.publish_mode = 'free' then b.canonical_markdown else '' end,
      p.price_atomic::text, p.price_asset, p.price_network,
      'rs_2026_09_v1'::text,
      p.license_spdx, p.license_url, p.train_ai, p.ai_use,
      p.search_indexable, p.attribution_required, p.citation_template,
      to_char(p.published_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      to_char(p.updated_at   at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
    from public.posts p
    join public.profiles pr on pr.user_id = p.author_user_id
    left join public.post_bodies b on b.content_hash = p.content_hash
    left join lateral (
      select address from public.wallets
       where user_id = p.author_user_id and is_primary
       limit 1
    ) w on true
    where lower(pr.handle) = lower(p_handle)
      and p.status in ('published', 'unlisted') and p.deleted_at is null
    order by p.published_at desc nulls last, p.id
    limit p_limit;
end;
$$;

create or replace function app.author_profile(p_handle text)
returns table (
  user_id uuid, handle text, display_name text, bio text,
  avatar_url text, website_url text, is_verified boolean
)
language plpgsql stable
security invoker
set search_path = public, pg_temp
as $$
begin
  perform app.enter('musebook_public_reader');
  return query
    select pr.user_id, pr.handle, pr.display_name, pr.bio,
           pr.avatar_url, pr.website_url, pr.is_verified
      from public.profiles pr
     where lower(pr.handle) = lower(p_handle);
end;
$$;

create or replace function app.list_authors_count()
returns bigint
language plpgsql stable
security invoker
set search_path = public, pg_temp
as $$
declare n bigint;
begin
  perform app.enter('musebook_public_reader');
  select count(distinct p.author_user_id) into n
    from public.posts p
   where p.status in ('published', 'unlisted') and p.deleted_at is null;
  return n;
end;
$$;

-- authors.md's per-author listing: handle, display name, post count and the
-- primary wallet — the plan's authors surface publishes the wallet verbatim
-- ("handle, wallet and default license terms"), and wallets is kernel-only,
-- so this helper is security definer (D39).
create or replace function app.list_authors(p_limit integer)
returns table (
  handle text, display_name text, bio text, avatar_url text,
  post_count bigint, wallet text, license_spdx text
)
language plpgsql stable
security definer
set search_path = public, pg_temp
as $$
begin
  -- No app.enter() here: SET ROLE is illegal inside a DEFINER function, and
  -- this helper already runs as the owner — that IS the plane switch (D39).
  return query
    select pr.handle, pr.display_name, pr.bio, pr.avatar_url,
           (select count(*) from public.posts p
             where p.author_user_id = pr.user_id
               and p.status in ('published','unlisted') and p.deleted_at is null),
           (select w.address from public.wallets w
             where w.user_id = pr.user_id
             order by w.is_primary desc, w.created_at limit 1),
           (select c.license_spdx from public.creator_publishing_defaults c
             where c.user_id = pr.user_id limit 1)
      from public.profiles pr
     where exists (select 1 from public.posts p
                    where p.author_user_id = pr.user_id
                      and p.status in ('published','unlisted') and p.deleted_at is null)
     order by pr.handle
     limit p_limit;
end;
$$;

-- DEFINER (deviation D39): assets is owner-scoped under musebook_kernel
-- (assets_actor_read) but the media read path resolves object keys for posts
-- it does not own. The capability is deliberately narrow: object_key -> the
-- set of live posts the asset is attached to, plus its storage bucket.
create or replace function app.lookup_asset_by_key(p_object_key text)
returns table (asset_id uuid, post_id uuid, storage text)
language plpgsql stable
security definer
set search_path = public, pg_temp
as $$
begin
  return query
    select a.id, pa.post_id, a.storage
      from public.assets a
      join public.post_assets pa on pa.asset_id = a.id
     where a.object_key = p_object_key;
end;
$$;

-- ── jobs plane: ingest, counters, outbox, the degraded-slate writer ─────────

-- §13.4.4's single unnest INSERT: one round trip per batch, idempotent on
-- (actor_plane, occurred_at, event_id). p_events is a jsonb array of objects
-- with the action_events columns.
create or replace function app.ingest_action_events(p_events jsonb)
returns integer
language plpgsql
set search_path = public, pg_temp
as $$
declare n integer;
begin
  perform app.enter('musebook_jobs');
  with x as (
    select * from jsonb_populate_recordset(null::public.action_events, p_events)
  )
  insert into public.action_events
    (event_id, occurred_at, actor_plane, viewer_user_id, actor_agent_id,
     post_id, action, surface, slate_id, position, weights_version,
     model_version, dwell_ms, client, ip_hash, request_id)
    select event_id, occurred_at, actor_plane, viewer_user_id, actor_agent_id,
           post_id, action, surface, slate_id, position, weights_version,
           model_version, dwell_ms, client, ip_hash, request_id
      from x
    on conflict (actor_plane, occurred_at, event_id) do nothing;
  get diagnostics n = row_count;
  return n;
end;
$$;

create or replace function app.resolve_slate_versions(p_slate_ids uuid[])
returns table (id uuid, weights_version text, model_version text)
language plpgsql stable
set search_path = public, pg_temp
as $$
begin
  perform app.enter('musebook_jobs');
  return query
    select s.id, s.weights_version, s.model_version
      from public.slates s
     where s.id = any(p_slate_ids);
end;
$$;

-- §13.9.1: opted-out viewers still get the aggregate counter, never a row.
create or replace function app.adjust_counter(
  p_post_id uuid, p_metric text, p_delta bigint, p_actor uuid default null
)
returns void
language plpgsql
set search_path = public, pg_temp
as $$
begin
  perform app.enter('musebook_jobs', p_actor);
  perform public.adjust_post_counter(p_post_id, p_metric, p_delta);
end;
$$;

-- §9.20 R2: a reverse-chron page is still logged as a slate — the mixer's
-- writer shape with the seeded dimension literals, so spine invariant 3 holds
-- for the very first request a viewer ever makes.
create or replace function app.write_reverse_chron_slate(
  p_viewer_user  uuid,
  p_viewer_agent uuid,
  p_surface      text,
  p_items        jsonb,          -- [{post_id: uuid}]
  p_ttl_seconds  integer default 900,
  p_actor        uuid default null
)
returns uuid
language plpgsql
set search_path = public, pg_temp
as $$
declare v_slate uuid;
begin
  perform app.enter('musebook_jobs', p_actor);
  insert into public.slates
    (viewer_user_id, viewer_agent_id, surface,
     weights_version, model_version, candidate_count, expires_at)
  values
    (p_viewer_user, p_viewer_agent, p_surface,
     'none', 'reverse_chron', jsonb_array_length(p_items),
     now() + make_interval(secs => p_ttl_seconds))
  returning id into v_slate;

  insert into public.slate_items (slate_id, position, post_id, source)
    select v_slate, (ord - 1)::integer, (it->>'post_id')::uuid, 'reverse_chron'
      from jsonb_array_elements(p_items) with ordinality as t(it, ord);
  return v_slate;
end;
$$;

-- Producer half of §4.13: the ONE statement per enqueue. dedupe_key is the
-- natural key ('embed:'||content_hash, 'media:'||asset_id, ...).
create or replace function app.enqueue_job(
  p_kind text, p_dedupe_key text, p_payload jsonb, p_actor uuid default null
)
returns bigint
language plpgsql
set search_path = public, pg_temp
as $$
declare v_id bigint;
begin
  perform app.enter('musebook_jobs', p_actor);
  insert into public.job_outbox (kind, dedupe_key, payload)
  values (p_kind, p_dedupe_key, p_payload)
  on conflict (kind, dedupe_key) do nothing
  returning id into v_id;
  return v_id;   -- null when the dedupe_key already exists — correct
end;
$$;

-- The sweeper's scan: job_outbox_pending_idx is partial on state='queued'.
create or replace function app.sweep_outbox(p_limit integer)
returns table (id bigint, kind text, dedupe_key text, payload jsonb)
language plpgsql
set search_path = public, pg_temp
as $$
begin
  perform app.enter('musebook_jobs');
  return query
    select j.id, j.kind, j.dedupe_key, j.payload
      from public.job_outbox j
     where j.state = 'queued'
     order by j.created_at
     limit p_limit;
end;
$$;

-- claim_job's invoker wrapper — public.claim_job is SECURITY INVOKER and
-- execute-granted to musebook_jobs only.
create or replace function app.claim_outbox_job(p_job_id bigint)
returns table (kind text, payload jsonb, attempts integer)
language plpgsql
set search_path = public, pg_temp
as $$
begin
  perform app.enter('musebook_jobs');
  return query select * from public.claim_job(p_job_id);
end;
$$;

-- Table-is-cache dedupe reads for the consumers (§9.23).
create or replace function app.existing_embeddings(p_content_hashes text[])
returns table (content_hash text)
language plpgsql stable
set search_path = public, pg_temp
as $$
begin
  perform app.enter('musebook_jobs');
  return query
    select e.content_hash from public.post_embeddings e
     where e.content_hash = any(p_content_hashes);
end;
$$;

create or replace function app.existing_classifications(p_content_hashes text[])
returns table (content_hash text)
language plpgsql stable
set search_path = public, pg_temp
as $$
begin
  perform app.enter('musebook_jobs');
  return query
    select c.content_hash from public.post_classifications c
     where c.content_hash = any(p_content_hashes);
end;
$$;

-- M6 idempotent effect writes (§17.11.5): real rows, deduped on content_hash.
-- p_rows is a jsonb array of {content_hash, post_id, model, dim, embedding}.
create or replace function app.record_embeddings(p_rows jsonb)
returns integer
language plpgsql
set search_path = public, pg_temp
as $$
declare n integer;
begin
  perform app.enter('musebook_jobs');
  with x as (
    select (r->>'content_hash')::text     as content_hash,
           (r->>'post_id')::uuid          as post_id,
           (r->>'model')::text            as model,
           (r->>'dim')::smallint          as dim,
           (r->>'embedding')::extensions.vector as embedding
      from jsonb_array_elements(p_rows) as r
  )
  insert into public.post_embeddings (content_hash, post_id, model, dim, embedding)
    select content_hash, post_id, model, dim, embedding from x
    on conflict (content_hash) do nothing;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- p_rows: [{content_hash, provider, model, primary_topic, topics,
--           language_code, quality, toxicity, spam, commercial_intent,
--           is_nsfw, is_ai_generated, latency_ms}]
create or replace function app.record_classifications(p_rows jsonb)
returns integer
language plpgsql
set search_path = public, pg_temp
as $$
declare n integer;
begin
  perform app.enter('musebook_jobs');
  with x as (
    select (r->>'content_hash')::text          as content_hash,
           (r->>'provider')::text              as provider,
           (r->>'model')::text                 as model,
           (r->>'primary_topic')::text         as primary_topic,
           coalesce((select array_agg(t) from jsonb_array_elements_text(
                     coalesce(r->'topics', '[]'::jsonb)) t), '{}'::text[]) as topics,
           (r->>'language_code')::text         as language_code,
           (r->>'quality')::real               as quality,
           (r->>'toxicity')::real              as toxicity,
           (r->>'spam')::real                  as spam,
           (r->>'commercial_intent')::real     as commercial_intent,
           coalesce((r->>'is_nsfw')::boolean, false)   as is_nsfw,
           (r->>'is_ai_generated')::boolean    as is_ai_generated,
           (r->>'latency_ms')::integer         as latency_ms
      from jsonb_array_elements(p_rows) as r
  )
  insert into public.post_classifications
    (content_hash, provider, model, primary_topic, topics, language_code,
     quality, toxicity, spam, commercial_intent, is_nsfw, is_ai_generated,
     latency_ms)
    select content_hash, provider, model, primary_topic, topics, language_code,
           quality, toxicity, spam, commercial_intent, is_nsfw, is_ai_generated,
           latency_ms
      from x
    on conflict (content_hash) do nothing;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- §9.17's read: app.read_slate itself is granted only to musebook_kernel and
-- musebook_jobs, and musebook_worker is NOINHERIT — the execute grant binds
-- only after the plane is entered, inside one statement (D23's whole reason
-- for helpers). Returns the same jsonb document.
create or replace function app.read_slate_doc(
  p_viewer_user uuid,
  p_viewer_agent uuid,
  p_surface     text,
  p_slate_id    uuid,
  p_after_pos   integer,
  p_limit       integer,
  p_actor       uuid default null
) returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
begin
  perform app.enter('musebook_kernel', p_actor);
  return app.read_slate(p_viewer_user, p_viewer_agent, p_surface,
                        p_slate_id, p_after_pos, p_limit);
end;
$$;

-- R2's keyset page (§9.20): the reverse-chron read for a viewer with no slate.
-- Rows are projected in the exact item shape app.read_slate emits so a degraded
-- page is indistinguishable from a built one downstream. surface='reels'
-- restricts to kind in ('video','audio') (§9.24 — a text note in a full-bleed
-- vertical pager is a broken experience, not a degraded one). The keyset is
-- (published_at, id) over posts_feed_idx.
create or replace function app.reverse_chron_page(
  p_viewer_user uuid,
  p_surface     text,
  p_after_ts    timestamptz,
  p_after_id    uuid,
  p_limit       integer,
  p_actor       uuid default null
)
returns table (
  "position" integer, post_id uuid, source text, score double precision,
  content_hash text, kind text, slug text, title text, published_at timestamptz,
  author_user_id uuid, creator_is_agent boolean, viewer_entitled boolean
)
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
begin
  -- kernel, not jobs: the page joins access_grants for viewer_entitled, and
  -- grants are kernel-plane data (access_grants_kernel_read covers it).
  perform app.enter('musebook_kernel', p_actor);
  return query
    select
      row_number() over (order by p.published_at desc, p.id desc)::integer - 1,
      p.id, 'reverse_chron'::text, null::double precision,
      p.content_hash, p.kind::text, p.slug, p.title, p.published_at,
      p.author_user_id,
      (p.posted_by_agent_id is not null),
      exists (
        select 1 from public.access_grants g
         where g.content_hash = p.content_hash
           and g.revoked_at is null
           and (g.expires_at is null or g.expires_at > now())
           and g.subject_user_id = p_viewer_user
      )
    from public.posts p
    where p.status = 'published'
      and p.deleted_at is null
      and (p_surface <> 'reels' or p.kind in ('video', 'audio'))
      and (p_after_ts is null
           or (p.published_at, p.id) < (p_after_ts, p_after_id))
    order by p.published_at desc, p.id desc
    limit least(greatest(p_limit, 1), 100);
end;
$$;

-- R2's keyset anchor for a "cursor past the last item" page: the post sitting
-- at `position` inside the slate the cursor names. DEFINER on the same pattern
-- as app.read_slate — slate_items is jobs-plane and the feed path must not
-- carry a direct grant onto it.
create or replace function app.slate_anchor(
  p_slate_id uuid,
  p_position integer
)
returns table (published_at timestamptz, post_id uuid)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.published_at, p.id
    from public.slate_items i
    join public.posts p on p.id = i.post_id
   where i.slate_id = p_slate_id and i.position = p_position
   limit 1;
$$;

-- ops_events writer — the DLQ consumers and opsLog write through here. Fails
-- open at the call site (the caller wraps in try/catch); the insert itself is
-- one plane-scoped statement.
create or replace function app.write_ops_event(
  p_component text, p_event_name text, p_level text,
  p_outcome text, p_request_id text, p_subject_id uuid, p_metadata jsonb,
  p_actor uuid
) returns void
language plpgsql
set search_path = public, pg_temp
as $$
begin
  perform app.enter('musebook_jobs', p_actor);
  insert into public.ops_events
    (component, event_name, level, outcome, request_id, subject_id, metadata)
  values (p_component, p_event_name, p_level, p_outcome, p_request_id, p_subject_id,
          coalesce(p_metadata, '{}'::jsonb));
end;
$$;

-- p_rows: [{post_id, post_version_id, channel_id, idempotency_key}]
create or replace function app.record_distribution_jobs(p_rows jsonb)
returns integer
language plpgsql
set search_path = public, pg_temp
as $$
declare n integer;
begin
  perform app.enter('musebook_jobs');
  with x as (
    select (r->>'post_id')::uuid          as post_id,
           (r->>'post_version_id')::uuid  as post_version_id,
           (r->>'channel_id')::uuid       as channel_id,
           (r->>'idempotency_key')::text  as idempotency_key
      from jsonb_array_elements(p_rows) as r
  )
  insert into public.distribution_jobs
    (post_id, post_version_id, channel_id, idempotency_key)
    select post_id, post_version_id, channel_id, idempotency_key from x
    on conflict (idempotency_key) do nothing;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- The outbox producer's queue name -> statement mapping lives in
-- apps/edge/src/enqueue.ts; this helper is its ONE statement.
create or replace function app.mark_outbox_enqueued(p_ids bigint[])
returns integer
language plpgsql
set search_path = public, pg_temp
as $$
declare n integer;
begin
  perform app.enter('musebook_jobs');
  update public.job_outbox
     set enqueued_at = now()
   where id = any(p_ids) and state = 'queued';
  get diagnostics n = row_count;
  return n;
end;
$$;

-- ── grants ───────────────────────────────────────────────────────────────────

-- Functions default to EXECUTE for PUBLIC; nothing in app.* is client-facing
-- (§4.14: anon gets nothing, the Worker role is the only caller).
revoke all on all functions in schema app from public, anon, authenticated;

grant execute on function app.load_resource_by_slug(text, uuid)   to musebook_worker;
grant execute on function app.load_resource_by_post_id(uuid, uuid) to musebook_worker;
grant execute on function app.find_live_grant(text, text, uuid, uuid, uuid) to musebook_worker;
grant execute on function app.mint_grant(uuid, text, uuid, text, uuid, uuid, timestamptz, uuid) to musebook_worker;
grant execute on function app.pin_quote(uuid, text, uuid, text, uuid, text, text, text, text, numeric, jsonb, uuid) to musebook_worker;
grant execute on function app.is_agent_blocked(uuid, uuid)        to musebook_worker;
grant execute on function app.list_public_resources(integer)      to musebook_worker;
grant execute on function app.list_author_posts(text, integer)    to musebook_worker;
grant execute on function app.author_profile(text)                to musebook_worker;
grant execute on function app.list_authors_count()                to musebook_worker;
grant execute on function app.list_authors(integer)               to musebook_worker;
grant execute on function app.lookup_asset_by_key(text)           to musebook_worker;
grant execute on function app.ingest_action_events(jsonb)         to musebook_worker;
grant execute on function app.resolve_slate_versions(uuid[])      to musebook_worker;
grant execute on function app.adjust_counter(uuid, text, bigint, uuid) to musebook_worker;
grant execute on function app.write_reverse_chron_slate(uuid, uuid, text, jsonb, integer, uuid) to musebook_worker;
grant execute on function app.slate_anchor(uuid, integer)     to musebook_worker;
grant execute on function app.enqueue_job(text, text, jsonb, uuid) to musebook_worker;
grant execute on function app.sweep_outbox(integer)               to musebook_worker;
grant execute on function app.claim_outbox_job(bigint)            to musebook_worker;
grant execute on function app.existing_embeddings(text[])         to musebook_worker;
grant execute on function app.existing_classifications(text[])    to musebook_worker;
grant execute on function app.record_embeddings(jsonb)            to musebook_worker;
grant execute on function app.record_classifications(jsonb)       to musebook_worker;
grant execute on function app.record_distribution_jobs(jsonb)     to musebook_worker;
grant execute on function app.read_slate_doc(uuid, uuid, text, uuid, integer, integer, uuid) to musebook_worker;
grant execute on function app.reverse_chron_page(uuid, text, timestamptz, uuid, integer, uuid) to musebook_worker;
grant execute on function app.write_ops_event(text, text, text, text, text, uuid, jsonb, uuid) to musebook_worker;
grant execute on function app.mark_outbox_enqueued(bigint[])      to musebook_worker;
