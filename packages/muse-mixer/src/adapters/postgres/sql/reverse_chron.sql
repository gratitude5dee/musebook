-- §9.7 ReverseChronSource: the MogBook mog-feed keyset port, ordered by
-- posts_feed_idx (published_at desc, id desc). $1 = viewerId (excludes self),
-- $2 = kinds filter, $3 = limit. In-network marks are caller-side, so the
-- followedCreatorIds list never reaches the query — Postgres rejects a
-- supplied parameter that has no text reference.
select p.id as post_id, p.content_hash, p.author_user_id,
       case when p.posted_by_agent_id is null then 'human' else 'agent' end as creator_kind,
       p.kind,
       (extract(epoch from p.published_at) * 1000)::double precision as published_at_ms,
       null::uuid as remix_root_id  -- artifacts.remix_root_id lands at M16 (§11.13); constant NULL until then
  from public.posts p
 where p.status = 'published'
   and p.deleted_at is null
   and ($1::uuid is null or p.author_user_id <> $1)
   and ($2::post_kind[] is null or p.kind = any($2))
 order by p.published_at desc, p.id desc
 limit $3;
