-- §12.3.4-§12.3.7: the variant stage reads a post's PUBLIC media. `assets`
-- sits in the §4.14 owner-scoped class — musebook_jobs cannot select it — so
-- the consumer goes through this function, which enters musebook_kernel with
-- the post's author as the actor and returns only r2_public rows. Only
-- musebook-public objects may ever be syndicated (§12.2.5); storage is the
-- storage-side invariant of that rule.
create or replace function app.distribution_media(p_post_id uuid)
returns table (
  asset_id uuid,
  url text,
  content_type text,
  alt_text text,
  width integer,
  height integer,
  duration_ms integer
)
language plpgsql stable
set search_path = public, pg_temp
as $$
declare v_author uuid;
begin
  -- musebook_worker is NOINHERIT against the plane roles: entering the reader
  -- plane is what makes public.posts (class 1) visible at all.
  perform app.enter('musebook_public_reader');
  select p.author_user_id into v_author
    from public.posts p where p.id = p_post_id;
  if v_author is null then
    return;
  end if;
  perform app.enter('musebook_kernel', v_author);
  return query
    select a.id, a.url, a.content_type, a.alt_text, a.width, a.height, a.duration_ms
      from public.post_assets pa
      join public.assets a on a.id = pa.asset_id
     where pa.post_id = p_post_id
       and a.storage = 'r2_public'
     order by pa.asset_id;
end;
$$;

revoke all on function app.distribution_media(uuid) from public, anon, authenticated;
grant execute on function app.distribution_media(uuid) to musebook_worker;

-- 91900's verbatim grants skip the jobs plane, and FORCE RLS would then filter
-- the worker's rows to zero. Add the plane grant + policy the matrix would have
-- emitted had the table existed in 91300.
grant select, insert, update on public.channel_constraint_overrides to musebook_jobs;
create policy channel_constraint_overrides_jobs_all on public.channel_constraint_overrides
  for all to musebook_jobs using (true) with check (true);
