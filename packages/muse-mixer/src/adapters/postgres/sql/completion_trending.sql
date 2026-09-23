-- §9.24 CompletionTrendingSource: velocity top-N (caller passes 500) over media
-- kinds; the SOURCE re-ranks in memory by completion_rate_24h after loading stats.
select p.id as post_id, p.content_hash, p.author_user_id,
       case when p.posted_by_agent_id is null then 'human' else 'agent' end as creator_kind,
       p.kind,
       (extract(epoch from p.published_at) * 1000)::double precision as published_at_ms,
       null::uuid as remix_root_id  -- artifacts.remix_root_id lands at M16 (§11.13); constant NULL until then
  from public.posts p
  join public.post_stats_rolling r on r.post_id = p.id
 where p.status = 'published'
   and p.deleted_at is null
   and p.kind = any($1::post_kind[])        -- reels: {video, audio}
   and p.published_at > now() - interval '7 days'
 order by r.velocity_24h desc, p.published_at desc
 limit $2;
