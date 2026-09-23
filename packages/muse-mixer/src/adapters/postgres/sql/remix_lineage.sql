-- §9.7 RemixLineageSource: posts in the same fork tree as artifacts the viewer
-- engaged with (remix/fork_app actions → roots resolved by the caller, $1).
select p.id as post_id, p.content_hash, p.author_user_id,
       case when p.posted_by_agent_id is null then 'human' else 'agent' end as creator_kind,
       p.kind,
       (extract(epoch from p.published_at) * 1000)::double precision as published_at_ms,
       null::uuid as remix_root_id  -- artifacts.remix_root_id lands at M16 (§11.13); constant NULL until then
  from public.posts p
  join public.artifacts a0 on a0.post_id = p.id
 where p.status = 'published'
   and p.deleted_at is null
   and null::uuid = any($1::uuid[])  -- never matches until M16 restores `a0.remix_root_id`
   and ($2::post_kind[] is null or p.kind = any($2))
 order by p.published_at desc
 limit $3;
