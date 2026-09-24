-- artifacts_versioning (M16): §11.13/§11.17 — artifact_versions, artifact_forks,
-- and the artifacts columns including remix_root_id, backfilled to the root of
-- each existing fork chain.
-- No licence column here: the licence is posts.license_spdx (section 4.4), one
-- column for every post_kind. See the note in 11.11 about section 4.18's
-- registry line.

alter table public.artifacts
  add column if not exists current_version     text,
  add column if not exists fork_of_artifact_id uuid references public.artifacts(id) on delete set null,
  add column if not exists fork_of_version     text,
  add column if not exists fork_count          integer not null default 0,
  -- The transitive root of the fork chain, materialised on write. Section 9.5's
  -- RemixDedupFilter and section 9.7's candidate SQL select this column; a
  -- recursive CTE per candidate does not fit the mixer's source budget.
  add column if not exists remix_root_id       uuid references public.artifacts(id) on delete set null,
  add column if not exists remix_allowed       boolean not null default true,
  add column if not exists status              text not null default 'live',
  add constraint artifacts_status_allowed check (status in ('live','quarantined','removed')),
  add constraint artifacts_version_shape
    check (current_version is null or current_version ~ '^[0-9a-f]{16}$'),
  add constraint artifacts_fork_not_self check (fork_of_artifact_id is null or fork_of_artifact_id <> id);

-- Backfill: remix_root_id = the root of the fork chain, or the artifact's own id
-- when it forks nothing. Runs once, over whatever M16 finds already present.
with recursive chain as (
  select a.id as artifact_id, a.id as node_id, a.fork_of_artifact_id
    from public.artifacts a
  union all
  select c.artifact_id, p.id, p.fork_of_artifact_id
    from chain c
    join public.artifacts p on p.id = c.fork_of_artifact_id
)
update public.artifacts a
   set remix_root_id = r.node_id
  from chain r
 where r.artifact_id = a.id
   and r.fork_of_artifact_id is null
   and a.remix_root_id is distinct from r.node_id;

-- And on every insert thereafter: a fork inherits its parent's root, a non-fork
-- becomes its own root. Never computed at read time.
create or replace function app.set_artifact_remix_root() returns trigger
language plpgsql as $$
begin
  if new.remix_root_id is null then
    if new.fork_of_artifact_id is null then
      new.remix_root_id := new.id;
    else
      select coalesce(p.remix_root_id, p.id)
        into new.remix_root_id
        from public.artifacts p
       where p.id = new.fork_of_artifact_id;
    end if;
  end if;
  return new;
end;
$$;

create trigger artifacts_set_remix_root
  before insert on public.artifacts
  for each row execute function app.set_artifact_remix_root();

create index artifacts_remix_root_idx on public.artifacts (remix_root_id)
  where remix_root_id is not null;

create table public.artifact_versions (
  artifact_id      uuid not null references public.artifacts(id) on delete cascade,
  version          text not null,
  manifest         jsonb not null,
  -- The R2 key prefix inside musebook-artifacts: 'a/public/{version}/' or
  -- 'a/private/{version}/'. Content-addressed, so two artifacts at the same
  -- version share one set of objects (11.12). It is a KEY, never a URL.
  base_path        text not null,
  visibility       text not null default 'public',
  entry_path       text not null,
  -- Always a cdn.musebook.dev URL: a poster is a teaser and is never gated (11.11).
  poster_url       text not null,
  total_bytes      bigint not null,
  file_count       integer not null,
  gzip_bytes       bigint,
  triangle_count   integer,                -- glb only
  texture_bytes    bigint,                 -- glb only
  draw_call_estimate integer,              -- glb only
  ingest_report    jsonb not null default '{}'::jsonb,
  created_by_user_id uuid references public.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  primary key (artifact_id, version),
  constraint artifact_versions_version_shape check (version ~ '^[0-9a-f]{16}$'),
  constraint artifact_versions_visibility_allowed check (visibility in ('public','private')),
  -- The prefix and the visibility must agree, or /a/ and /t/ route to the wrong
  -- place. Making it a CHECK means a bad pair cannot be written at all.
  constraint artifact_versions_base_path_matches
    check (base_path = 'a/' || visibility || '/' || version || '/'),
  constraint artifact_versions_poster_is_public
    check (poster_url like 'https://cdn.musebook.dev/%'),
  constraint artifact_versions_bytes_positive check (total_bytes > 0 and file_count > 0),
  -- 11.13's caps, restated where they cannot be forgotten.
  constraint artifact_versions_file_count_bounded check (file_count <= 64)
);
create index artifact_versions_recent_idx on public.artifact_versions (artifact_id, created_at desc);

create table public.artifact_forks (
  id                 uuid primary key default gen_random_uuid(),
  source_artifact_id uuid not null references public.artifacts(id) on delete cascade,
  source_version     text not null,
  fork_artifact_id   uuid not null unique references public.artifacts(id) on delete cascade,
  forked_by_user_id  uuid not null references public.users(id) on delete cascade,
  forked_by_agent_id uuid references public.agent_identities(id) on delete set null,
  created_at         timestamptz not null default now()
);
create index artifact_forks_source_idx on public.artifact_forks (source_artifact_id, created_at desc);
create index artifact_forks_user_idx on public.artifact_forks (forked_by_user_id, created_at desc);

alter table public.artifact_versions enable row level security;
alter table public.artifact_forks    enable row level security;
alter table public.artifact_versions force row level security;   -- CF-spine §2
alter table public.artifact_forks    force row level security;
grant select on public.artifact_versions, public.artifact_forks to anon, authenticated;

-- Version metadata for a published post is public; the BYTES of a private version
-- are not reachable from here, because base_path is an R2 key, not a URL, and
-- musebook-artifacts has no custom domain and no dev URL.
create policy artifact_versions_public_read on public.artifact_versions
  for select to anon, authenticated
  using (exists (
    select 1 from public.artifacts a join public.posts p on p.id = a.post_id
     where a.id = artifact_versions.artifact_id
       and a.status = 'live' and p.status = 'published' and p.deleted_at is null
  ));
create policy artifact_forks_public_read on public.artifact_forks
  for select to anon, authenticated using (true);

-- §11.17's one-call write path for a published version: the version row and the
-- current_version bump commit together, because a half-published artifact has a
-- row pointing at objects that may not exist (or vice versa).
create or replace function app.publish_artifact_version(
  p_artifact_id        uuid,
  p_version            text,
  p_manifest           jsonb,
  p_base_path          text,
  p_visibility         text,
  p_entry_path         text,
  p_poster_url         text,
  p_total_bytes        bigint,
  p_file_count         integer,
  p_gzip_bytes         bigint,
  p_triangle_count     integer,
  p_texture_bytes      bigint,
  p_draw_call_estimate integer,
  p_ingest_report      jsonb,
  p_created_by_user_id uuid
)
returns void
language plpgsql security definer
set search_path = pg_catalog, public, app
as $$
begin
  insert into public.artifact_versions (
    artifact_id, version, manifest, base_path, visibility, entry_path,
    poster_url, total_bytes, file_count, gzip_bytes,
    triangle_count, texture_bytes, draw_call_estimate,
    ingest_report, created_by_user_id
  ) values (
    p_artifact_id, p_version, p_manifest, p_base_path, p_visibility, p_entry_path,
    p_poster_url, p_total_bytes, p_file_count, p_gzip_bytes,
    p_triangle_count, p_texture_bytes, p_draw_call_estimate,
    p_ingest_report, p_created_by_user_id
  );
  update public.artifacts
     set current_version = p_version
   where id = p_artifact_id;
  if not found then
    raise exception 'artifact_not_found' using errcode = 'P0002';
  end if;
end;
$$;

revoke all on function app.publish_artifact_version(uuid, text, jsonb, text, text,
  text, text, bigint, integer, bigint, integer, bigint, integer, jsonb, uuid)
  from public, anon, authenticated;
grant execute on function app.publish_artifact_version(uuid, text, jsonb, text, text,
  text, text, bigint, integer, bigint, integer, bigint, integer, jsonb, uuid)
  to musebook_jobs;

-- §11.17 forking, steps 2–4 in one call: permission check, the fork post +
-- artifacts rows, the same-version pointer row, and the lineage row + count.
-- remix_root_id stays null on the insert: artifacts_set_remix_root fills it
-- from the parent's root, so lineage is right without the caller knowing the
-- chain. A fork whose visibility differs from the source's is a later
-- read-and-re-put (11.12); this call writes the pointer rows only.
create or replace function app.fork_artifact(
  p_source_artifact_id uuid,
  p_forker_user_id     uuid,
  p_forker_agent_id    uuid,
  p_slug               text,
  p_title              text,
  p_markdown           text
)
returns table (post_id uuid, artifact_id uuid)
language plpgsql security definer
set search_path = pg_catalog, public, app
as $$
declare
  v_source   public.artifacts%rowtype;
  v_post     public.posts%rowtype;
  v_version  public.artifact_versions%rowtype;
  v_post_id  uuid;
  v_art_id   uuid;
  v_hash     text;
begin
  select a.* into v_source from public.artifacts a where a.id = p_source_artifact_id;
  if v_source.id is null then
    raise exception 'artifact_not_found' using errcode = 'P0002';
  end if;
  select p.* into v_post from public.posts p
    where p.id = v_source.post_id and p.deleted_at is null;
  if v_post.id is null then
    raise exception 'artifact_post_not_found' using errcode = 'P0002';
  end if;
  if v_source.remix_allowed = false or v_source.status <> 'live' then
    raise exception 'remix_not_allowed' using errcode = '42501';
  end if;
  if v_post.license_spdx in ('ARR','CC-BY-ND-4.0')
     and v_post.author_user_id <> p_forker_user_id then
    raise exception 'license_forbids_fork' using errcode = '42501';
  end if;
  select v.* into v_version from public.artifact_versions v
    where v.artifact_id = v_source.id and v.version = v_source.current_version;
  if v_version.artifact_id is null then
    raise exception 'artifact_version_not_found' using errcode = 'P0002';
  end if;

  v_hash := app.sha256_hex(p_markdown);
  insert into public.post_bodies (content_hash, canonical_markdown, byte_len)
  values (v_hash, p_markdown, octet_length(p_markdown))
  on conflict do nothing;

  insert into public.posts (
    author_user_id, posted_by_agent_id, kind, status, publish_mode, slug, title,
    content_hash, license_spdx, attribution_required, published_at
  ) values (
    p_forker_user_id, p_forker_agent_id, v_post.kind, 'published', 'free',
    p_slug, p_title, v_hash, v_post.license_spdx, v_post.attribution_required, now()
  ) returning posts.id into v_post_id;

  insert into public.artifacts (
    post_id, kind, bundle_url, entry_path, sha256, byte_len,
    current_version, fork_of_artifact_id, fork_of_version, status
  ) values (
    v_post_id, v_source.kind, v_source.bundle_url, v_source.entry_path,
    v_source.sha256, v_source.byte_len,
    v_version.version, v_source.id, v_version.version, 'live'
  ) returning artifacts.id into v_art_id;

  -- Same version, same base_path: a pointer row, zero bytes moved (11.17.3).
  insert into public.artifact_versions (
    artifact_id, version, manifest, base_path, visibility, entry_path,
    poster_url, total_bytes, file_count, gzip_bytes,
    triangle_count, texture_bytes, draw_call_estimate,
    ingest_report, created_by_user_id
  ) values (
    v_art_id, v_version.version, v_version.manifest, v_version.base_path,
    v_version.visibility, v_version.entry_path,
    v_version.poster_url, v_version.total_bytes, v_version.file_count,
    v_version.gzip_bytes, v_version.triangle_count, v_version.texture_bytes,
    v_version.draw_call_estimate, v_version.ingest_report, p_forker_user_id
  );

  insert into public.artifact_forks (
    source_artifact_id, source_version, fork_artifact_id,
    forked_by_user_id, forked_by_agent_id
  ) values (
    v_source.id, v_version.version, v_art_id, p_forker_user_id, p_forker_agent_id
  );

  update public.artifacts set fork_count = fork_count + 1 where id = v_source.id;

  return query select v_post_id, v_art_id;
end;
$$;

revoke all on function app.fork_artifact(uuid, uuid, uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function app.fork_artifact(uuid, uuid, uuid, text, text, text)
  to musebook_worker, musebook_jobs;

-- §11.18 step 3: the ticket endpoint's one metadata read — post_id for
-- loadResource, current_version for the URL, visibility+entry_path to shape it.
create or replace function app.load_artifact_for_ticket(
  p_artifact_id uuid,
  p_actor      uuid default null
)
returns table (
  post_id uuid, artifact_id uuid, kind text, status text,
  current_version text, visibility text, entry_path text
)
language plpgsql stable
set search_path = pg_catalog, public, app
as $$
begin
  perform app.enter('musebook_kernel', p_actor);
  return query
    select a.post_id, a.id, a.kind::text, a.status::text, a.current_version,
           v.visibility, v.entry_path
      from public.artifacts a
      left join public.artifact_versions v
        on v.artifact_id = a.id and v.version = a.current_version
     where a.id = p_artifact_id;
end;
$$;

revoke all on function app.load_artifact_for_ticket(uuid, uuid)
  from public, anon, authenticated;
grant execute on function app.load_artifact_for_ticket(uuid, uuid)
  to musebook_worker, musebook_jobs;

-- §11.12 step 3: the r2-events consumer's one metadata read for a staged
-- bundle.tar.gz — artifact identity + kind (which sets the size cap) + the
-- post's publish_mode, mapped to visibility in SQL so the kernel-plane
-- vocabulary never crosses into worker code (§6.3's containment rule, same as
-- staged_upload_target's target_storage).
create or replace function app.staged_artifact_target(p_object_key text)
returns table (
  post_id          uuid,
  artifact_id      uuid,
  kind             text,
  uploader_user_id uuid,
  visibility       text
)
language plpgsql security definer
set search_path = pg_catalog, public, app
as $$
begin
  return query
    select s.post_id, a.id, a.kind::text, s.uploader_user_id,
           case when p.publish_mode = 'free' or p.publish_mode is null
                then 'public' else 'private' end
      from public.staged_uploads s
      join public.posts p on p.id = s.post_id and p.deleted_at is null
      join public.artifacts a on a.post_id = p.id
     where s.object_key = p_object_key;
end;
$$;
revoke all on function app.staged_artifact_target(text)
  from public, anon, authenticated;
grant execute on function app.staged_artifact_target(text) to musebook_jobs;

-- The artifact ingest path clears its staging row itself — record_uploaded_asset
-- is asset-shaped and does not apply to a bundle.tar.gz.
create or replace function app.clear_staged_upload(p_object_key text)
returns void
language plpgsql security definer
set search_path = pg_catalog, public, app
as $$
begin
  delete from public.staged_uploads where object_key = p_object_key;
end;
$$;
revoke all on function app.clear_staged_upload(text)
  from public, anon, authenticated;
grant execute on function app.clear_staged_upload(text) to musebook_jobs;

-- §15.5.3's single-use nonce claim, callable from the Vercel plane: signature
-- verification happens in code first (an unauthenticated flood cannot fill
-- the table), then this insert turns a replay into `found = false`.
create or replace function app.claim_internal_nonce(
  p_nonce      text,
  p_key_id     text,
  p_method     text,
  p_path       text,
  p_expires_at timestamptz
)
returns boolean
language plpgsql security definer
set search_path = pg_catalog, public, app
as $$
begin
  insert into public.internal_request_nonces (nonce, key_id, method, path, expires_at)
  values (p_nonce, p_key_id, p_method, p_path, p_expires_at)
  on conflict (nonce) do nothing;
  return found;
end;
$$;
revoke all on function app.claim_internal_nonce(text, text, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function app.claim_internal_nonce(text, text, text, text, timestamptz)
  to service_role, musebook_jobs;
