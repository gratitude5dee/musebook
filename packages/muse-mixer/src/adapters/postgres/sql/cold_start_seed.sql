-- §9.7 ColdStartSeedSource: last 48 h, post_counters.impressions below threshold.
select p.id as post_id, p.content_hash, p.author_user_id,
       case when p.posted_by_agent_id is null then 'human' else 'agent' end as creator_kind,
       p.kind,
       (extract(epoch from p.published_at) * 1000)::double precision as published_at_ms,
       null::uuid as remix_root_id  -- artifacts.remix_root_id lands at M16 (§11.13); constant NULL until then
  from public.posts p
  join public.post_counters pc on pc.post_id = p.id
 where p.status = 'published'
   and p.deleted_at is null
   and p.published_at > now() - interval '48 hours'
   and pc.impressions < $1::int
   and ($2::post_kind[] is null or p.kind = any($2))
 order by p.published_at desc
 limit $3;
