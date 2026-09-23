-- §9.7 AgentAuthoredSource: agent-authored posts whose identity is not blocked.
select p.id as post_id, p.content_hash, p.author_user_id,
       case when p.posted_by_agent_id is null then 'human' else 'agent' end as creator_kind,
       p.kind,
       (extract(epoch from p.published_at) * 1000)::double precision as published_at_ms,
       null::uuid as remix_root_id  -- artifacts.remix_root_id lands at M16 (§11.13); constant NULL until then
  from public.posts p
  join public.agent_identities ai on ai.id = p.posted_by_agent_id
 where p.status = 'published'
   and p.deleted_at is null
   and p.posted_by_agent_id is not null
   and ai.is_blocked = false
   and p.published_at > now() - interval '14 days'
   and ($1::post_kind[] is null or p.kind = any($1))
 order by p.published_at desc
 limit $2;
