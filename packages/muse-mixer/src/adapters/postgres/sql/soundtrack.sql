-- §9.24 SoundtrackSource (reels): other posts sharing an assets row the viewer
-- played through. Play-throughs come from the worker-maintained
-- viewer_recent_actions projection — never action_events on this path.
select p.id as post_id, p.content_hash, p.author_user_id,
       case when p.posted_by_agent_id is null then 'human' else 'agent' end as creator_kind,
       p.kind,
       (extract(epoch from p.published_at) * 1000)::double precision as published_at_ms,
       null::uuid as remix_root_id  -- artifacts.remix_root_id lands at M16 (§11.13); constant NULL until then
  from public.posts p
  join public.post_assets pa on pa.post_id = p.id
 where p.status = 'published'
   and p.deleted_at is null
   and p.author_user_id <> $1::uuid
   and pa.asset_id in (
     select distinct pa2.asset_id
       from public.post_assets pa2
      where pa2.post_id in (
        select (a.elem ->> 'post_id')::uuid
          from public.viewer_recent_actions v
               cross join lateral jsonb_array_elements(v.actions) as a(elem)
         where v.viewer_user_id = $1::uuid
           and a.elem ->> 'action' = 'play_through'
           and a.elem ? 'post_id'))
 order by p.published_at desc
 limit $2;
