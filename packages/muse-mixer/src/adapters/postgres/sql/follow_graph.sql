-- packages/muse-mixer/src/adapters/postgres/sql/follow_graph.sql
select p.id as post_id, p.content_hash, p.author_user_id,
       case when p.posted_by_agent_id is null then 'human' else 'agent' end as creator_kind,
       p.kind,
       (extract(epoch from p.published_at) * 1000)::double precision as published_at_ms,
       null::uuid as remix_root_id  -- artifacts.remix_root_id lands at M16 (§11.13); constant NULL until then
  from public.posts p
 where p.status = 'published'
   and p.deleted_at is null
   and p.author_user_id = any($1::uuid[])       -- followedCreatorIds
   and p.published_at > now() - interval '48 hours'
   and p.author_user_id <> $2::uuid             -- exclude self; Thunder does the same
   and ($3::post_kind[] is null or p.kind = any($3))   -- 'reels' passes {video,audio}
 order by p.published_at desc
 limit $4;
