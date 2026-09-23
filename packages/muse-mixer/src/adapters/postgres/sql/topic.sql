-- §9.7 TopicSource: GIN index post_classifications_topics_gin, c.topics && $1.
-- distinct on post id so a post matching several topics enters once.
select distinct on (p.id)
       p.id as post_id, p.content_hash, p.author_user_id,
       case when p.posted_by_agent_id is null then 'human' else 'agent' end as creator_kind,
       p.kind,
       (extract(epoch from p.published_at) * 1000)::double precision as published_at_ms,
       null::uuid as remix_root_id  -- artifacts.remix_root_id lands at M16 (§11.13); constant NULL until then
  from public.posts p
  join public.post_classifications c on c.content_hash = p.content_hash
 where p.status = 'published'
   and p.deleted_at is null
   and c.topics && $1::text[]                           -- followed ∪ inferred ∪ requested
   and ($2::post_kind[] is null or p.kind = any($2))
 order by p.id, c.quality desc nulls last, p.published_at desc
 limit $3;
