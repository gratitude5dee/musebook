-- §9.7 CoEngagementSource: recent posts by a caller-resolved creator id set.
select p.id as post_id, p.content_hash, p.author_user_id,
       case when p.posted_by_agent_id is null then 'human' else 'agent' end as creator_kind,
       p.kind,
       (extract(epoch from p.published_at) * 1000)::double precision as published_at_ms,
       null::uuid as remix_root_id  -- artifacts.remix_root_id lands at M16 (§11.13); constant NULL until then
  from public.posts p
 where p.status = 'published'
   and p.deleted_at is null
   and p.author_user_id = any($1::uuid[])
   and p.published_at > now() - interval '7 days'
   and ($2::post_kind[] is null or p.kind = any($2))
 order by p.published_at desc
 limit $3;
