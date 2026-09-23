-- §9.7 AppArtifactSource: kind in ('app','model3d'), ordered by co-install
-- collaborative filtering over the viewer's viewer_recent_actions install/fork ids.
select p.id as post_id, p.content_hash, p.author_user_id,
       'agent' as creator_kind,
       p.kind,
       (extract(epoch from p.published_at) * 1000)::double precision as published_at_ms,
       null::uuid as remix_root_id  -- artifacts.remix_root_id lands at M16 (§11.13); constant NULL until then
  from public.posts p
 where p.status = 'published'
   and p.deleted_at is null
   and p.kind in ('app', 'model3d')
 order by
   -- posts co-installed with what this viewer already installed rank first
   (select count(v.viewer_user_id)
      from public.viewer_recent_actions v
     where v.viewer_user_id = $1::uuid
       and v.actions @> jsonb_build_array(jsonb_build_object(
             'action', 'install_app', 'post_id', p.id::text))) desc,
   p.published_at desc
 limit $2;
