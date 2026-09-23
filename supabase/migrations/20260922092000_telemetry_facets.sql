-- telemetry_facets (M11). Additive to 20260922090800_action_events.sql (4.9).
-- MUST run before production traffic: ADD COLUMN on a partitioned table takes
-- ACCESS EXCLUSIVE on the parent and every leaf partition.

alter table public.action_events
  add column anon_id              text,          -- human plane only; rotating, 24 h
  add column view_session_id      uuid,          -- human plane only; one per page view
  add column content_hash         text,          -- spine invariant 1: exact bytes read
  add column outcome              text not null default 'ok',
  add column max_scroll_pct       smallint,      -- human plane only
  add column completion_pct       smallint,      -- human plane only (media)
  add column agent_key_thumbprint text,          -- agent plane only; Web Bot Auth keyid
  add column mcp_tool             text,          -- agent plane only
  add column bytes_served         integer,       -- agent plane only
  add column settlement_id        uuid,          -- no FK, per 4.9's asymmetry rule
  add column amount_atomic        numeric(78,0);

alter table public.action_events
  add constraint action_events_outcome_allowed check (
    outcome in ('ok','payment_required','input_required','denied','error','partial')
  ),
  add constraint action_events_hash_len check (
    content_hash is null or length(content_hash) = 64
  ),
  add constraint action_events_pct_range check (
    (max_scroll_pct  is null or max_scroll_pct  between 0 and 100) and
    (completion_pct  is null or completion_pct  between 0 and 100)
  ),
  add constraint action_events_amount_nonneg check (
    amount_atomic is null or amount_atomic >= 0
  );

-- GAP A + GAP B in one constraint. Replaces action_events_plane_actor from 4.9.
alter table public.action_events drop constraint action_events_plane_actor;

alter table public.action_events
  add constraint action_events_plane_purity check (
    (actor_plane = 'human'
       and (viewer_user_id is not null or anon_id is not null)
       and actor_agent_id       is null
       and agent_key_thumbprint is null
       and mcp_tool             is null)
    or
    (actor_plane = 'agent'
       and actor_agent_id  is not null
       and viewer_user_id  is null
       and anon_id         is null
       and view_session_id is null)
  );

-- Plane-local indexes. Creating these on the LEVEL-1 partition, not the parent,
-- means the human leaves never carry an index for a column they can never hold.
create index action_events_agent_thumbprint_idx
  on public.action_events_agent (agent_key_thumbprint, occurred_at desc)
  where agent_key_thumbprint is not null;
create index action_events_agent_tool_idx
  on public.action_events_agent (mcp_tool, occurred_at desc)
  where mcp_tool is not null;
create index action_events_human_anon_idx
  on public.action_events_human (anon_id, occurred_at desc)
  where anon_id is not null;
create index action_events_human_session_idx
  on public.action_events_human (view_session_id)
  where view_session_id is not null;

-- Rollup driver: every rollup scans one day of one plane by post.
create index action_events_hash_idx on public.action_events (content_hash, occurred_at desc)
  where content_hash is not null;
