-- M7 — composer draft write path (§14.4.3) and staged-upload linkage (§11.7.3).
-- Drafts write over PostgREST: the creator's own rows under RLS, and the kernel
-- has no opinion about them. Since §4.14(f) bars any writable policy for
-- anon/authenticated, the draft write rides two security-definer RPCs —
-- public.save_draft / public.load_draft — bound to auth.uid().
--
-- staged_uploads is the key→post map the presign route writes at init and the
-- musebook-r2-events consumer reads at promotion; an assets row cannot exist
-- before promotion because assets_url_matches_bucket rejects a staging URL.

create or replace function public.save_draft(
  p_post_id             uuid    default null,
  p_markdown            text    default '',
  p_title               text    default null,
  p_summary             text    default null,
  p_kind                post_kind    default 'note',
  p_access_mode         publish_mode default 'free',
  p_price_atomic        numeric default 0,
  p_price_asset         text    default null,
  p_price_network       text    default null,
  p_license_spdx        text    default 'CC-BY-4.0',
  p_license_url         text    default null,
  p_train_ai            boolean default false,
  p_ai_use              boolean default false,
  p_search_indexable    boolean default true,
  p_attribution_required boolean default true,
  p_citation_template   text    default null,
  p_tags                text[]  default '{}',
  p_slug_hint           text    default null
)
returns table (post_id uuid, slug text, version integer, content_hash text)
language plpgsql security definer
set search_path = pg_catalog, public, app
as $$
declare
  v_uid uuid := auth.uid();
  v_asset text;
  v_network text;
  v_post_id uuid;
  v_hash text;
  v_slug text;
  v_base text;
  v_version integer;
  v_suffix text;
  v_attempt integer;
  i integer;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  if p_access_mode <> 'free' and p_price_atomic <= 0 then
    raise exception 'paid_mode_needs_price' using errcode = '22023';
  end if;

  -- Bodies are content-addressed and immutable; the row exists once per bytes.
  v_hash := app.sha256_hex(p_markdown);
  -- posts_price_consistency: a priced post needs the asset+network pair. The
  -- composer never names them (defaults come from §6.10's USDC-on-Base tuple);
  -- a caller MAY override (a USDC-on-Sepolia test harness).
  v_asset := case when p_price_atomic > 0
                  then coalesce(p_price_asset, '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913')
                  else null end;
  v_network := case when p_price_atomic > 0
                    then coalesce(p_price_network, 'eip155:8453')
                    else null end;

  insert into public.post_bodies (content_hash, canonical_markdown, byte_len)
  values (v_hash, p_markdown, octet_length(p_markdown))
  on conflict do nothing;

  if p_post_id is not null then
    -- Edit: author-only bump of current_version; the previous body stays put.
    update public.posts p
       set title = p_title, summary = p_summary, kind = p_kind,
           publish_mode = p_access_mode, price_atomic = p_price_atomic,
           price_asset = v_asset, price_network = v_network,
           license_spdx = p_license_spdx, license_url = p_license_url,
           train_ai = p_train_ai, ai_use = p_ai_use,
           search_indexable = p_search_indexable,
           attribution_required = p_attribution_required,
           citation_template = p_citation_template, tags = p_tags,
           content_hash = v_hash,
           current_version = p.current_version + 1,
           updated_at = now()
     where p.id = p_post_id
       and p.author_user_id = v_uid
       and p.deleted_at is null
    returning p.id, p.slug, p.current_version
         into v_post_id, v_slug, v_version;
    if v_post_id is null then
      raise exception 'draft_not_found' using errcode = 'P0002';
    end if;
  else
    -- New draft: mint the slug from the hint (or title) and append a 4-char
    -- base32 disambiguator on conflict (posts_slug_uniq is global).
    v_base := lower(regexp_replace(
                regexp_replace(trim(coalesce(nullif(p_slug_hint, ''), p_title, 'post')),
                               '[^a-zA-Z0-9]+', '-', 'g'),
                '(^-+|-+$)', '', 'g'));
    if v_base !~ '^[a-z0-9]' or length(v_base) < 2 then
      v_base := 'post-' || v_base;
    end if;
    v_base := left(v_base, 74);

    v_post_id := null;
    for v_attempt in 1..8 loop
      if v_attempt = 1 then
        v_slug := v_base;
      else
        v_suffix := '';
        for i in 1..4 loop
          v_suffix := v_suffix || substr('abcdefghijklmnopqrstuvwxyz234567',
                                         floor(random() * 32)::integer + 1, 1);
        end loop;
        v_slug := left(v_base, 74) || '-' || v_suffix;
      end if;
      begin
        insert into public.posts (
          author_user_id, kind, status, publish_mode, slug, title, summary,
          content_hash, current_version, price_atomic, price_asset, price_network,
          license_spdx, license_url, train_ai, ai_use, search_indexable,
          attribution_required, citation_template, tags)
        values (
          v_uid, p_kind, 'draft', p_access_mode, v_slug, p_title, p_summary,
          v_hash, 1, p_price_atomic, v_asset, v_network,
          p_license_spdx, p_license_url, p_train_ai, p_ai_use, p_search_indexable,
          p_attribution_required, p_citation_template, p_tags)
        returning id into v_post_id;
        v_version := 1;
        exit;
      exception when unique_violation then
        continue;
      end;
    end loop;
    if v_post_id is null then
      raise exception 'slug_conflict' using errcode = 'P0002';
    end if;
  end if;

  insert into public.post_versions
        (post_id, version, content_hash, title, summary, editor_user_id)
  values (v_post_id, v_version, v_hash, p_title, p_summary, v_uid);

  return query select v_post_id, v_slug, v_version, v_hash;
end;
$$;
revoke all on function public.save_draft(
  uuid, text, text, text, post_kind, publish_mode, numeric, text, text, text,
  text, boolean, boolean, boolean, boolean, text, text[], text)
from public, anon;
grant execute on function public.save_draft(
  uuid, text, text, text, post_kind, publish_mode, numeric, text, text, text,
  text, boolean, boolean, boolean, boolean, text, text[], text)
to authenticated;


create or replace function public.load_draft(p_post_id uuid)
returns table (
  post_id              uuid,
  slug                 text,
  title                text,
  summary              text,
  kind                 post_kind,
  status               post_status,
  access_mode          publish_mode,
  price_atomic         numeric,
  price_asset          text,
  price_network        text,
  license_spdx         text,
  license_url          text,
  train_ai             boolean,
  ai_use               boolean,
  search_indexable     boolean,
  attribution_required boolean,
  citation_template    text,
  tags                 text[],
  canonical_markdown   text,
  content_hash         text,
  current_version      integer,
  live_grant_count     bigint,
  updated_at           timestamptz
)
language plpgsql security definer
set search_path = pg_catalog, public, app
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  if not exists (select 1 from public.posts p
                  where p.id = p_post_id
                    and p.author_user_id = v_uid
                    and p.deleted_at is null) then
    raise exception 'draft_not_found' using errcode = 'P0002';
  end if;
  return query
    select p.id, p.slug, p.title, p.summary, p.kind, p.status, p.publish_mode as access_mode,
           p.price_atomic, p.price_asset, p.price_network, p.license_spdx,
           p.license_url, p.train_ai, p.ai_use, p.search_indexable,
           p.attribution_required, p.citation_template, p.tags,
           b.canonical_markdown, p.content_hash, p.current_version,
           (select count(distinct g.payer)
              from public.access_grants g
             where g.revoked_at is null
               and (g.post_id = p.id
                    or g.content_hash in (select pv.content_hash
                                            from public.post_versions pv
                                           where pv.post_id = p.id))),
           p.updated_at
      from public.posts p
      join public.post_bodies b on b.content_hash = p.content_hash
     where p.id = p_post_id;
end;
$$;
revoke all on function public.load_draft(uuid) from public, anon;
grant execute on function public.load_draft(uuid) to authenticated;


-- The edge publish route's author check: definer so the kernel plane reads
-- author_user_id without a blanket select-on-posts policy shaping.
create or replace function app.can_write_post(p_user uuid, p_post_id uuid)
returns boolean
language plpgsql security definer
set search_path = pg_catalog, public, app
as $$
begin
  return exists (select 1 from public.posts
                  where id = p_post_id and author_user_id = p_user
                    and deleted_at is null);
end;
$$;
revoke all on function app.can_write_post(uuid, uuid) from public, anon, authenticated;
grant execute on function app.can_write_post(uuid, uuid) to musebook_kernel;
alter function app.can_write_post(uuid, uuid) set search_path = pg_catalog, public, app;


-- ── Staged-upload linkage (§11.7.3) ───────────────────────────────────────────

create table public.staged_uploads (
  object_key        text primary key,
  uploader_user_id  uuid not null references public.users(id) on delete cascade,
  post_id           uuid references public.posts(id) on delete cascade,
  content_type      text not null,
  byte_len          bigint not null check (byte_len >= 0),
  upload_id         text,          -- R2 multipart id once init completes
  created_at        timestamptz not null default now(),
  constraint staged_uploads_key_shape check (object_key like 'staging/%'),
  constraint staged_uploads_key_len   check (length(object_key) between 9 and 1024)
);
alter table public.staged_uploads enable row level security;
alter table public.staged_uploads force row level security;

-- Written at presign-init by the edge (kernel plane), so the upload can exist
-- before its post does; post_id backfills via link_staged_upload at complete.
create or replace function app.init_staged_upload(
  p_user         uuid,
  p_post_id      uuid,
  p_object_key   text,
  p_upload_id    text,
  p_content_type text,
  p_byte_len     bigint
)
returns void
language plpgsql security definer
set search_path = pg_catalog, public, app
as $$
begin
  if p_post_id is not null and not exists (
    select 1 from public.posts
     where id = p_post_id and author_user_id = p_user and deleted_at is null
  ) then
    raise exception 'post_not_found' using errcode = 'P0002';
  end if;
  insert into public.staged_uploads
        (object_key, uploader_user_id, post_id, upload_id, content_type, byte_len)
  values (p_object_key, p_user, p_post_id, p_upload_id, p_content_type, p_byte_len)
  on conflict (object_key) do update
    set post_id = excluded.post_id,
        upload_id = excluded.upload_id,
        content_type = excluded.content_type,
        byte_len = excluded.byte_len;
end;
$$;
revoke all on function app.init_staged_upload(uuid, uuid, text, text, text, bigint)
  from public, anon, authenticated;
grant execute on function app.init_staged_upload(uuid, uuid, text, text, text, bigint)
  to musebook_kernel, musebook_worker;


create or replace function app.link_staged_upload(
  p_user       uuid,
  p_object_key text,
  p_post_id    uuid
)
returns void
language plpgsql security definer
set search_path = pg_catalog, public, app
as $$
begin
  if not exists (select 1 from public.posts
                  where id = p_post_id and author_user_id = p_user
                    and deleted_at is null) then
    raise exception 'post_not_found' using errcode = 'P0002';
  end if;
  update public.staged_uploads
     set post_id = p_post_id
   where object_key = p_object_key
     and uploader_user_id = p_user;
  if not found then
    raise exception 'staged_upload_not_found' using errcode = 'P0002';
  end if;
end;
$$;
revoke all on function app.link_staged_upload(uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function app.link_staged_upload(uuid, text, uuid)
  to musebook_kernel;


-- The r2-events consumer reads the staged row plus the resolved storage tier
-- to pick the destination bucket (definer: jobs plane holds no staged_uploads
-- grant). The tier is mapped here in SQL so publish_mode never crosses the
-- kernel-plane boundary into worker code (§6.3's containment rule).
create or replace function app.staged_upload_target(p_object_key text)
returns table (
  post_id          uuid,
  uploader_user_id uuid,
  content_type     text,
  byte_len         bigint,
  target_storage   text
)
language plpgsql security definer
set search_path = pg_catalog, public, app
as $$
begin
  return query
    select s.post_id, s.uploader_user_id, s.content_type, s.byte_len,
           case when p.publish_mode = 'free' or p.publish_mode is null
                then 'r2_public' else 'r2_paid' end
      from public.staged_uploads s
      left join public.posts p on p.id = s.post_id and p.deleted_at is null
     where s.object_key = p_object_key;
end;
$$;
revoke all on function app.staged_upload_target(text)
  from public, anon, authenticated;
grant execute on function app.staged_upload_target(text) to musebook_jobs;

-- The sign-part route reads the staged row directly on the Worker plane before
-- re-signing (uploads.ts does not hold a jobs-plane grant), so musebook_worker
-- needs the same execute.
grant execute on function app.staged_upload_target(text) to musebook_worker;


-- Called after the object is copied + hashed: writes the assets row (the CHECK
-- enforces url matches bucket), links it to the post, and clears the staging row.
create or replace function app.record_uploaded_asset(
  p_object_key   text,
  p_storage      text,
  p_dest_key     text,
  p_url          text,
  p_content_type text,
  p_byte_len     bigint,
  p_sha256       text
)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, public, app
as $$
declare
  v_staged public.staged_uploads%rowtype;
  v_asset_id uuid;
begin
  select * into v_staged from public.staged_uploads where object_key = p_object_key;
  if not found then
    raise exception 'staged_upload_not_found' using errcode = 'P0002';
  end if;

  insert into public.assets
        (owner_user_id, storage, object_key, url, content_type, byte_len, sha256)
  values (v_staged.uploader_user_id, p_storage, p_dest_key, p_url,
          p_content_type, p_byte_len, p_sha256)
  on conflict do nothing
  returning id into v_asset_id;

  if v_asset_id is null then
    -- Idempotent redelivery: the asset row for this promoted object exists.
    select id into v_asset_id from public.assets
     where storage = p_storage and object_key = p_dest_key;
  end if;

  if v_staged.post_id is not null and v_asset_id is not null then
    insert into public.post_assets (post_id, asset_id)
    values (v_staged.post_id, v_asset_id)
    on conflict do nothing;
  end if;

  delete from public.staged_uploads where object_key = p_object_key;
  return v_asset_id;
end;
$$;
revoke all on function app.record_uploaded_asset(text, text, text, text, text, bigint, text)
  from public, anon, authenticated;
grant execute on function app.record_uploaded_asset(text, text, text, text, text, bigint, text)
  to musebook_jobs, musebook_worker;

-- The creator's defaults row, read back for the composer's prefill (§14.4.5).
-- Same RPC shape as load_draft: the column's name stays inside the SQL.
create or replace function public.my_publishing_defaults()
returns table (
  access_mode          publish_mode,
  license_spdx         text,
  train_ai             boolean,
  ai_use               boolean,
  price_cents          integer
)
language plpgsql security definer
set search_path = pg_catalog, public, app
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  return query
    select d.publish_mode as access_mode, d.license_spdx, d.train_ai, d.ai_use,
           d.price_cents
      from public.creator_publishing_defaults d
     where d.user_id = v_uid;
end;
$$;
revoke all on function public.my_publishing_defaults() from public, anon;
grant execute on function public.my_publishing_defaults() to authenticated;
alter function public.my_publishing_defaults() set search_path = pg_catalog, public, app;

-- search_path pins (§4.14 lint posture).
alter function public.save_draft(
  uuid, text, text, text, post_kind, publish_mode, numeric, text, text, text,
  text, boolean, boolean, boolean, boolean, text, text[], text)
  set search_path = pg_catalog, public, app;
alter function public.load_draft(uuid) set search_path = pg_catalog, public, app;
alter function app.init_staged_upload(uuid, uuid, text, text, text, bigint)
  set search_path = pg_catalog, public, app;
alter function app.link_staged_upload(uuid, text, uuid)
  set search_path = pg_catalog, public, app;
alter function app.staged_upload_target(text) set search_path = pg_catalog, public, app;
alter function app.record_uploaded_asset(text, text, text, text, text, bigint, text)
  set search_path = pg_catalog, public, app;

-- publish_post was granted to musebook_kernel in 20260922091200_ops.sql; the
-- Worker's session connects as musebook_worker (NOINHERIT), so the publish
-- path's `select * from public.publish_post($1,$2)` needs the direct grant too.
grant execute on function public.publish_post(uuid, text[]) to musebook_worker;
grant execute on function app.can_write_post(uuid, uuid) to musebook_worker;
grant execute on function app.link_staged_upload(uuid, text, uuid) to musebook_worker;
