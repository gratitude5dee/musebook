-- telemetry_rollups (M11). Rollup tables. Written by TWO halves: the pg_cron
-- functions below (Postgres-sourced columns) and the Analytics Engine pass in
-- musebook-worker (AE-sourced columns). Read by the ranker and the creator
-- dashboard. NEVER materialized views: see 13.7.1.
-- creator_id on every rollup row is posts.author_user_id (4.4), copied at
-- rollup time so the dashboard never joins posts for the common case.

-- Fixed-width dwell histogram so a true pooled percentile is computable
-- without ever reading action_events. 12 buckets, upper edges in ms.
-- [0,1s) [1,2) [2,5) [5,10) [10,20) [20,30) [30,60) [60,120) [120,300)
-- [300,600) [600,1800) [1800,inf)
-- The same twelve edges are hard-coded in the Analytics Engine query in 13.7.3.
-- If they ever change, both sides change in the same commit or the histogram
-- silently mixes two bucketings.
create or replace function app.dwell_bucket(p_ms integer) returns smallint
language sql immutable strict as $$
  select case
    when p_ms <    1000 then 1::smallint when p_ms <    2000 then 2::smallint
    when p_ms <    5000 then 3::smallint when p_ms <   10000 then 4::smallint
    when p_ms <   20000 then 5::smallint when p_ms <   30000 then 6::smallint
    when p_ms <   60000 then 7::smallint when p_ms <  120000 then 8::smallint
    when p_ms <  300000 then 9::smallint when p_ms <  600000 then 10::smallint
    when p_ms < 1800000 then 11::smallint else 12::smallint end;
$$;

create or replace function app.hist_add(a bigint[], b bigint[]) returns bigint[]
language sql immutable as $$
  select array(select coalesce(a[i], 0) + coalesce(b[i], 0)
                 from generate_series(1, 12) as g(i));
$$;

create aggregate app.hist_sum(bigint[]) (
  sfunc    = app.hist_add,
  stype    = bigint[],
  initcond = '{0,0,0,0,0,0,0,0,0,0,0,0}'
);

create or replace function app.hist_percentile(p_hist bigint[], p_p double precision)
returns integer
language plpgsql immutable as $$
declare
  edges  bigint[] := array[0,1000,2000,5000,10000,20000,30000,60000,
                           120000,300000,600000,1800000];
  total  bigint := 0;
  cum    bigint := 0;
  target numeric;
  i      integer;
begin
  if p_hist is null then return 0; end if;
  for i in 1 .. 12 loop total := total + coalesce(p_hist[i], 0); end loop;
  if total = 0 then return 0; end if;
  target := total::numeric * p_p;
  for i in 1 .. 12 loop
    cum := cum + coalesce(p_hist[i], 0);
    if cum >= target then
      return (edges[i] +
              (edges[least(i + 1, 12)] - edges[i])::numeric *
              ((target - (cum - coalesce(p_hist[i], 0))::numeric)
               / greatest(coalesce(p_hist[i], 1), 1)::numeric))::integer;
    end if;
  end loop;
  return edges[12]::integer;
end;
$$;

-- ---------------------------------------------------------------- human daily
-- Columns are grouped by WHICH HALF WRITES THEM. Neither half may touch the
-- other's columns in its ON CONFLICT DO UPDATE list; 13.11 check 19 asserts it.
create table public.post_stats_daily (
  day              date   not null,
  post_id          uuid   not null,
  creator_id       uuid   not null,                  -- = posts.author_user_id

  -- ANALYTICS ENGINE half (13.7.3, apply_ae_post_stats_daily)
  impressions      bigint not null default 0,
  dwell_events     bigint not null default 0,
  dwell_ms_total   bigint not null default 0,
  dwell_hist       bigint[] not null default '{0,0,0,0,0,0,0,0,0,0,0,0}',
  scroll_completes bigint not null default 0,        -- dwell points, max_scroll_pct >= 90
  media_q25        bigint not null default 0,        -- dwell points, completion_pct >= 25
  media_q50        bigint not null default 0,
  media_q75        bigint not null default 0,
  ae_applied_at    timestamptz,                      -- null => the AE half has not run

  -- POSTGRES half (13.7.3, rollup_post_stats_daily)
  opens            bigint not null default 0,        -- action = 'view'
  media_plays      bigint not null default 0,        -- 'play' rows with play_index 0
  media_completes  bigint not null default 0,        -- 'play_through' rows (>= 85 % or ended)
  replays          bigint not null default 0,        -- 'play' rows with play_index >= 1
  likes            bigint not null default 0,
  comments         bigint not null default 0,
  reposts          bigint not null default 0,
  bookmarks        bigint not null default 0,
  shares           bigint not null default 0,
  distinct_readers bigint not null default 0,        -- OVER THE LABEL SAMPLE; see below
  -- The effective TELEMETRY_IMPRESSION_SAMPLE for this day. distinct_readers and
  -- any other count derived from action_events_human must be read as
  -- value / label_sample_rate, and 13.8.4 requires the dashboard to label it.
  label_sample_rate real not null default 1,

  computed_at      timestamptz not null default now(),
  primary key (day, post_id),
  constraint post_stats_daily_hist_len check (array_length(dwell_hist, 1) = 12),
  constraint post_stats_daily_sample check (label_sample_rate > 0 and label_sample_rate <= 1)
);
create index post_stats_daily_creator_idx on public.post_stats_daily (creator_id, day desc);

-- ---------------------------------------------------------------- agent daily
create table public.post_agent_stats_daily (
  day                date   not null,
  post_id            uuid   not null,
  creator_id         uuid   not null,               -- = posts.author_user_id

  -- ANALYTICS ENGINE half
  fetches            bigint not null default 0,     -- 'agent_crawl' + 'impression'
  distinct_agents    bigint not null default 0,
  signed_agents      bigint not null default 0,     -- evidence = 'web_bot_auth' only
  mcp_calls          bigint not null default 0,
  paywall_hits       bigint not null default 0,     -- 'agent_crawl', outcome 'payment_required'
  bytes_served       bigint not null default 0,
  by_tool            jsonb  not null default '{}'::jsonb,  -- {"get_post": 41, ...}
  ae_applied_at      timestamptz,

  -- POSTGRES half
  purchases          bigint not null default 0,     -- 'x402_pay'
  revenue_atomic     numeric(78,0) not null default 0,
  citations_declared bigint not null default 0,     -- 'agent_cite'

  computed_at        timestamptz not null default now(),
  primary key (day, post_id)
);
create index post_agent_stats_daily_creator_idx
  on public.post_agent_stats_daily (creator_id, day desc);

-- --------------------------------------------- the Analytics Engine watermark
-- One row per (day, pass). This is the ONLY thing that makes a silent 3-month
-- data loss visible: AE forgets, and if nobody noticed the rollup stopped, the
-- window is gone. 15.19 alerts on a missing 'succeeded' row older than 48 h.
create table public.telemetry_ae_runs (
  day        date not null,
  pass       text not null check (pass in ('post_stats', 'agent_stats')),
  status     text not null check (status in ('succeeded', 'failed')),
  rows       bigint not null default 0,
  detail     text,
  ran_at     timestamptz not null default now(),
  primary key (day, pass)
);

-- ------------------------------------------------- the ranker's feature row
-- ONE row per post. This, post_counters and the embedding tables are the ONLY
-- engagement state the serve path may read. See 13.7.5.
create table public.post_stats_rolling (
  post_id                  uuid primary key,
  human_impressions_24h    bigint  not null default 0,
  human_opens_24h          bigint  not null default 0,
  dwell_ms_p50_24h         integer not null default 0,
  dwell_ms_p90_24h         integer not null default 0,
  completion_rate_24h      real    not null default 0,
  replays_24h              bigint  not null default 0,
  engagements_24h          bigint  not null default 0,
  agent_fetches_24h        bigint  not null default 0,
  distinct_agents_24h      integer not null default 0,
  signed_agent_fetches_24h bigint  not null default 0,
  citations_7d             integer not null default 0,
  purchases_24h            integer not null default 0,
  revenue_7d_atomic        numeric(78,0) not null default 0,
  velocity_24h             real    not null default 0,
  computed_at              timestamptz not null default now(),
  constraint post_stats_rolling_rates check (
    completion_rate_24h between 0 and 1 and velocity_24h >= 0
  )
);
create index post_stats_rolling_velocity_idx on public.post_stats_rolling (velocity_24h desc);
create index post_stats_rolling_agent_idx on public.post_stats_rolling (agent_fetches_24h desc);

-- ------------------------------------------------------------- creator daily
create table public.creator_stats_daily (
  day               date not null,
  creator_id        uuid not null,                  -- = posts.author_user_id
  posts_published   integer not null default 0,
  impressions       bigint not null default 0,
  opens             bigint not null default 0,
  dwell_hist        bigint[] not null default '{0,0,0,0,0,0,0,0,0,0,0,0}',
  engagements       bigint not null default 0,
  followers_gained  integer not null default 0,
  agent_fetches     bigint not null default 0,
  distinct_agents   integer not null default 0,
  purchases         integer not null default 0,
  revenue_atomic    numeric(78,0) not null default 0,   -- from payout_ledger, not telemetry
  computed_at       timestamptz not null default now(),
  primary key (day, creator_id)
);

-- ------------------------------ per-viewer sequence, for §9's query hydrators
-- This is what ScoringSequenceQueryHydrator / RetrievalSequenceQueryHydrator /
-- InferredTopicsQueryHydrator read. They do NOT read action_events. See 13.12.
-- It is built from the LABELLED subset, which is correct: it is a sequence of
-- actions a viewer took, and every action is always a Postgres row.
create table public.viewer_recent_actions (
  viewer_user_id uuid primary key references public.users(id) on delete cascade,
  actions        jsonb not null default '[]'::jsonb,  -- newest first, ≤128 entries
  topic_counts   jsonb not null default '{}'::jsonb,  -- {"<topic_id>": 7, ...}
  action_count   integer not null default 0,
  window_start   timestamptz not null default now(),
  computed_at    timestamptz not null default now(),
  constraint viewer_recent_actions_len check (jsonb_array_length(actions) <= 128)
);
create index viewer_recent_actions_stale_idx on public.viewer_recent_actions (computed_at);

alter table public.post_stats_daily        enable row level security;
alter table public.post_agent_stats_daily  enable row level security;
alter table public.post_stats_rolling      enable row level security;
alter table public.creator_stats_daily     enable row level security;
alter table public.viewer_recent_actions   enable row level security;
alter table public.telemetry_ae_runs       enable row level security;
alter table public.post_stats_daily        force row level security;
alter table public.post_agent_stats_daily  force row level security;
alter table public.post_stats_rolling      force row level security;
alter table public.creator_stats_daily     force row level security;
alter table public.viewer_recent_actions   force row level security;
alter table public.telemetry_ae_runs       force row level security;

-- Jobs plane only (§4.14): the creator dashboard reads them through a Worker
-- route that has already resolved the creator, not through PostgREST.
grant select, insert, update, delete on
  public.post_stats_daily, public.post_agent_stats_daily,
  public.post_stats_rolling, public.creator_stats_daily,
  public.viewer_recent_actions, public.telemetry_ae_runs
  to musebook_jobs;
create policy post_stats_daily_jobs       on public.post_stats_daily       for all to musebook_jobs using (true) with check (true);
create policy post_agent_stats_daily_jobs on public.post_agent_stats_daily for all to musebook_jobs using (true) with check (true);
create policy post_stats_rolling_jobs     on public.post_stats_rolling     for all to musebook_jobs using (true) with check (true);
create policy creator_stats_daily_jobs    on public.creator_stats_daily    for all to musebook_jobs using (true) with check (true);
create policy viewer_recent_actions_jobs  on public.viewer_recent_actions  for all to musebook_jobs using (true) with check (true);
create policy telemetry_ae_runs_jobs      on public.telemetry_ae_runs      for all to musebook_jobs using (true) with check (true);

-- The serve-plane read (musebook_serve over post_stats_rolling /
-- viewer_recent_actions) is §13.7.5's layer 3, which ships as a CI assertion
-- only: no third Hyperdrive login exists yet (§13 open question 7), so there is
-- no role to grant here.

-- ============================================================ rollup procedures
-- Every one of these is idempotent for a given day, and each half touches only
-- its own columns.

-- NOTE ON A SECTION 4 DEFECT: action_events_daily's primary key — re-keyed by
-- section 12's 20260922091900_platform_constraints.sql (M10) to
-- (day, actor_plane, source, post_id, action) — makes post_id implicitly
-- NOT NULL, but action_events.post_id is nullable (a search that returned
-- nothing, a follow with no post). Rows with a null post_id are counted into
-- ops_events and excluded here rather than crashing the rollup. First-party
-- rows carry source = 'musebook'; section 12.3.10's projection writes the
-- platform slug, so the two writers never collide on the key.
create or replace function app.rollup_action_events_daily(
  p_day   date        default (current_date - 1),
  p_plane actor_plane default null
) returns bigint
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_rows    bigint := 0;
  v_orphans bigint := 0;
begin
  select count(*) into v_orphans
  from public.action_events e
  where e.occurred_at >= p_day::timestamptz
    and e.occurred_at <  (p_day + 1)::timestamptz
    and (p_plane is null or e.actor_plane = p_plane)
    and e.post_id is null;

  insert into public.action_events_daily (day, actor_plane, source, post_id, action, n, dwell_ms)
  select p_day, e.actor_plane, 'musebook', e.post_id, e.action,
         count(*), coalesce(sum(e.dwell_ms), 0)
  from public.action_events e
  where e.occurred_at >= p_day::timestamptz
    and e.occurred_at <  (p_day + 1)::timestamptz
    and (p_plane is null or e.actor_plane = p_plane)
    and e.post_id is not null
  group by 2, 4, 5
  on conflict (day, actor_plane, source, post_id, action) do update
    set n = excluded.n, dwell_ms = excluded.dwell_ms;

  get diagnostics v_rows = row_count;

  insert into public.ops_events (component, event_name, level, outcome, metadata)
  values ('telemetry', 'rollup_daily', 'info', 'ok',
          jsonb_build_object('day', p_day, 'plane', p_plane,
                             'rows', v_rows, 'null_post_rows', v_orphans));
  return v_rows;
end;
$$;

-- Human daily stats, POSTGRES HALF. Reads ONE leaf partition tree; the planner
-- prunes to the single day's leaf because occurred_at is the range key. It
-- CREATES the row and never touches an AE-sourced column.
create or replace function app.rollup_post_stats_daily(p_day date default (current_date - 1))
returns bigint
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare v_rows bigint;
begin
  insert into public.post_stats_daily as t (
    day, post_id, creator_id, opens, media_plays, media_completes, replays,
    likes, comments, reposts, bookmarks, shares, distinct_readers,
    label_sample_rate, computed_at
  )
  select
    p_day,
    e.post_id,
    p.author_user_id,
    count(*) filter (where e.action = 'view'),
    count(*) filter (where e.action = 'play'
                       and coalesce((e.client->'media'->>'play_index')::int, 0) = 0),
    count(*) filter (where e.action = 'play_through'),
    count(*) filter (where e.action = 'play'
                       and coalesce((e.client->'media'->>'play_index')::int, 0) >= 1),
    count(*) filter (where e.action = 'like'),
    count(*) filter (where e.action = 'comment'),
    count(*) filter (where e.action = 'repost'),
    count(*) filter (where e.action = 'bookmark'),
    count(*) filter (where e.action = 'share'),
    count(distinct coalesce(e.viewer_user_id::text, e.anon_id)),
    -- The day's effective label sample rate, taken from the rows themselves so
    -- a mid-day change is visible rather than assumed. max(), not avg(): a day
    -- that straddles a change is reported at the higher rate and 13.8.4's
    -- "approx" label covers it either way.
    coalesce(max((e.client->>'sample_rate')::real), 1.0),
    now()
  from public.action_events_human e
  join public.posts p on p.id = e.post_id
  where e.occurred_at >= p_day::timestamptz
    and e.occurred_at <  (p_day + 1)::timestamptz
    and e.post_id is not null
  group by e.post_id, p.author_user_id
  on conflict (day, post_id) do update set
    opens = excluded.opens, media_plays = excluded.media_plays,
    media_completes = excluded.media_completes, replays = excluded.replays,
    likes = excluded.likes, comments = excluded.comments, reposts = excluded.reposts,
    bookmarks = excluded.bookmarks, shares = excluded.shares,
    distinct_readers = excluded.distinct_readers,
    label_sample_rate = excluded.label_sample_rate,
    computed_at = now();

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

-- Human daily stats, ANALYTICS ENGINE HALF. Called by the Cron Worker with the
-- query result as one jsonb array. It is a plain UPSERT so a post that had
-- impressions but no Postgres-side activity still gets a row; creator_id is
-- resolved here because the AE point does not carry it (one index, and it is
-- post_id). Chunked at 1,000 posts per call by the caller.
create or replace function app.apply_ae_post_stats_daily(p_day date, p_rows jsonb)
returns bigint
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare v_rows bigint;
begin
  insert into public.post_stats_daily as t (
    day, post_id, creator_id, impressions, dwell_events, dwell_ms_total,
    dwell_hist, scroll_completes, media_q25, media_q50, media_q75,
    ae_applied_at, computed_at
  )
  select
    p_day,
    (r->>'post_id')::uuid,
    p.author_user_id,
    (r->>'impressions')::bigint,
    (r->>'dwell_events')::bigint,
    (r->>'dwell_ms_total')::bigint,
    array(select ((r->'hist')->>i)::bigint from generate_series(0, 11) as g(i)),
    (r->>'scroll_completes')::bigint,
    (r->>'media_q25')::bigint,
    (r->>'media_q50')::bigint,
    (r->>'media_q75')::bigint,
    now(), now()
  from jsonb_array_elements(p_rows) as r
  join public.posts p on p.id = (r->>'post_id')::uuid
  on conflict (day, post_id) do update set
    impressions = excluded.impressions, dwell_events = excluded.dwell_events,
    dwell_ms_total = excluded.dwell_ms_total, dwell_hist = excluded.dwell_hist,
    scroll_completes = excluded.scroll_completes,
    media_q25 = excluded.media_q25, media_q50 = excluded.media_q50,
    media_q75 = excluded.media_q75,
    ae_applied_at = now(), computed_at = now();

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

-- Agent daily stats, POSTGRES HALF — same shape as the human half on the agent
-- plane (§13.7.3). purchases/revenue_atomic are accounting facts read from the
-- events table's settlement facets, never from a count of fetches.
create or replace function app.rollup_post_agent_stats_daily(p_day date default (current_date - 1))
returns bigint
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare v_rows bigint;
begin
  insert into public.post_agent_stats_daily as t (
    day, post_id, creator_id, purchases, revenue_atomic, citations_declared,
    computed_at
  )
  select
    p_day,
    e.post_id,
    p.author_user_id,
    count(*) filter (where e.action = 'x402_pay'),
    coalesce(sum(e.amount_atomic) filter (where e.action = 'x402_pay'), 0),
    count(*) filter (where e.action = 'agent_cite'),
    now()
  from public.action_events_agent e
  join public.posts p on p.id = e.post_id
  where e.occurred_at >= p_day::timestamptz
    and e.occurred_at <  (p_day + 1)::timestamptz
    and e.post_id is not null
  group by e.post_id, p.author_user_id
  on conflict (day, post_id) do update set
    purchases = excluded.purchases,
    revenue_atomic = excluded.revenue_atomic,
    citations_declared = excluded.citations_declared,
    computed_at = now();

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

-- Agent daily stats, ANALYTICS ENGINE HALF (§13.7.3). by_tool arrives pre-built
-- by the Worker from a second query grouped by (index1, blob12); the fan-out
-- bug of the pre-split lateral join cannot recur.
create or replace function app.apply_ae_agent_stats_daily(p_day date, p_rows jsonb)
returns bigint
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare v_rows bigint;
begin
  insert into public.post_agent_stats_daily as t (
    day, post_id, creator_id, fetches, distinct_agents, signed_agents,
    mcp_calls, paywall_hits, bytes_served, by_tool, ae_applied_at, computed_at
  )
  select
    p_day,
    (r->>'post_id')::uuid,
    p.author_user_id,
    (r->>'fetches')::bigint,
    (r->>'distinct_agents')::bigint,
    (r->>'signed_agents')::bigint,
    (r->>'mcp_calls')::bigint,
    (r->>'paywall_hits')::bigint,
    (r->>'bytes_served')::bigint,
    coalesce(r->'by_tool', '{}'::jsonb),
    now(), now()
  from jsonb_array_elements(p_rows) as r
  join public.posts p on p.id = (r->>'post_id')::uuid
  on conflict (day, post_id) do update set
    fetches = excluded.fetches, distinct_agents = excluded.distinct_agents,
    signed_agents = excluded.signed_agents, mcp_calls = excluded.mcp_calls,
    paywall_hits = excluded.paywall_hits, bytes_served = excluded.bytes_served,
    by_tool = excluded.by_tool,
    ae_applied_at = now(), computed_at = now();

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

-- Creator daily stats. Reads the two per-post rollups plus posts + follows +
-- payout_ledger — NEVER action_events (§13.7.3). revenue_atomic is an
-- accounting fact joined through the ledger, not a telemetry count.
create or replace function app.rollup_creator_stats_daily(p_day date default (current_date - 1))
returns bigint
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare v_rows bigint;
begin
  with per_creator as (
    select
      h.creator_id,
      sum(h.impressions)        as impressions,
      sum(h.opens)              as opens,
      app.hist_sum(h.dwell_hist) as dwell_hist,
      sum(h.likes + h.comments + h.reposts + h.bookmarks + h.shares) as engagements,
      sum(a.fetches)            as agent_fetches,
      max(a.distinct_agents)    as distinct_agents,   -- lower bound, "at least" (13.8.4)
      sum(a.purchases)          as purchases
    from public.post_stats_daily h
    left join public.post_agent_stats_daily a
      on a.day = h.day and a.post_id = h.post_id
    where h.day = p_day
    group by h.creator_id
  ),
  published as (
    select author_user_id as creator_id, count(*) as posts_published
      from public.posts
     where created_at >= p_day::timestamptz
       and created_at <  (p_day + 1)::timestamptz
       and status = 'published' and deleted_at is null
     group by author_user_id
  ),
  follows_gained as (
    select followee_user_id as creator_id, count(*) as followers_gained
      from public.follows
     where created_at >= p_day::timestamptz
       and created_at <  (p_day + 1)::timestamptz
       and followee_user_id is not null
     group by followee_user_id
  ),
  revenue as (
    select l.account_user_id as creator_id, sum(l.amount_atomic) as revenue_atomic
      from public.payout_ledger l
     where l.created_at >= p_day::timestamptz
       and l.created_at <  (p_day + 1)::timestamptz
       and l.account_kind = 'creator' and l.amount_atomic > 0
     group by l.account_user_id
  )
  insert into public.creator_stats_daily as t (
    day, creator_id, posts_published, impressions, opens, dwell_hist,
    engagements, followers_gained, agent_fetches, distinct_agents,
    purchases, revenue_atomic, computed_at
  )
  select
    p_day,
    c.creator_id,
      coalesce(pb.posts_published, 0),
      coalesce(pc.impressions, 0),
      coalesce(pc.opens, 0),
      coalesce(pc.dwell_hist, '{0,0,0,0,0,0,0,0,0,0,0,0}'::bigint[]),
      coalesce(pc.engagements, 0),
      coalesce(fg.followers_gained, 0),
      coalesce(pc.agent_fetches, 0),
      coalesce(pc.distinct_agents, 0),
      coalesce(pc.purchases, 0),
      coalesce(rv.revenue_atomic, 0),
      now()
    from (select creator_id from per_creator
          union select creator_id from published
          union select creator_id from follows_gained
          union select creator_id from revenue) c
    left join per_creator pc  on pc.creator_id = c.creator_id
    left join published pb    on pb.creator_id = c.creator_id
    left join follows_gained fg on fg.creator_id = c.creator_id
    left join revenue rv      on rv.creator_id = c.creator_id
  on conflict (day, creator_id) do update set
    posts_published = excluded.posts_published,
    impressions = excluded.impressions,
    opens = excluded.opens,
    dwell_hist = excluded.dwell_hist,
    engagements = excluded.engagements,
    followers_gained = excluded.followers_gained,
    agent_fetches = excluded.agent_fetches,
    distinct_agents = excluded.distinct_agents,
    purchases = excluded.purchases,
    revenue_atomic = excluded.revenue_atomic,
    computed_at = now();

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

-- Hourly rolling features. Reads ONLY the two daily rollups — never
-- action_events, never Analytics Engine (§13.7.3).
create or replace function app.refresh_post_stats_rolling()
returns bigint
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare v_rows bigint;
begin
  insert into public.post_stats_rolling as t (
    post_id, human_impressions_24h, human_opens_24h,
    dwell_ms_p50_24h, dwell_ms_p90_24h, completion_rate_24h,
    replays_24h, engagements_24h,
    agent_fetches_24h, distinct_agents_24h, signed_agent_fetches_24h,
    citations_7d, purchases_24h, revenue_7d_atomic, velocity_24h, computed_at
  )
  select
    h.post_id,
    sum(h.impressions),
    sum(h.opens),
      app.hist_percentile(app.hist_sum(h.dwell_hist), 0.5),
      app.hist_percentile(app.hist_sum(h.dwell_hist), 0.9),
      case when sum(h.media_plays) > 0
           then least(sum(h.media_completes)::real / sum(h.media_plays), 1.0)
           else 0 end,
      sum(h.replays),
      sum(h.likes + h.comments + h.reposts + h.bookmarks + h.shares),
      coalesce(sum(a.fetches), 0),
      coalesce(max(a.distinct_agents), 0),
      coalesce(sum(a.signed_agents), 0),
      coalesce((select sum(a7.citations_declared)
                  from public.post_agent_stats_daily a7
                 where a7.post_id = h.post_id
                   and a7.day > current_date - 7), 0)::integer,
      coalesce(sum(a.purchases), 0)::integer,
      coalesce((select sum(a7.revenue_atomic)
                  from public.post_agent_stats_daily a7
                 where a7.post_id = h.post_id
                   and a7.day > current_date - 7), 0),
      -- velocity: opens per impression vs the same ratio 7 days back, floored 0.
      greatest(case when sum(h.impressions) > 0
                    then sum(h.opens)::real / sum(h.impressions) else 0 end -
               coalesce((select case when sum(h7.impressions) > 0
                                     then sum(h7.opens)::real / sum(h7.impressions)
                                     else 0 end
                           from public.post_stats_daily h7
                          where h7.post_id = h.post_id
                            and h7.day between current_date - 8 and current_date - 7), 0),
               0),
      now()
    from public.post_stats_daily h
    left join public.post_agent_stats_daily a
      on a.day = h.day and a.post_id = h.post_id
   where h.day >= current_date - 1
   group by h.post_id
  on conflict (post_id) do update set
    human_impressions_24h    = excluded.human_impressions_24h,
    human_opens_24h          = excluded.human_opens_24h,
    dwell_ms_p50_24h         = excluded.dwell_ms_p50_24h,
    dwell_ms_p90_24h         = excluded.dwell_ms_p90_24h,
    completion_rate_24h      = excluded.completion_rate_24h,
    replays_24h              = excluded.replays_24h,
    engagements_24h          = excluded.engagements_24h,
    agent_fetches_24h        = excluded.agent_fetches_24h,
    distinct_agents_24h      = excluded.distinct_agents_24h,
    signed_agent_fetches_24h = excluded.signed_agent_fetches_24h,
    citations_7d             = excluded.citations_7d,
    purchases_24h            = excluded.purchases_24h,
    revenue_7d_atomic        = excluded.revenue_7d_atomic,
    velocity_24h             = excluded.velocity_24h,
    computed_at              = now();

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

-- ------------------------------------------------------------- privacy jobs
-- §13.7.4's schedule. All pure SQL on pg_cron; the ONE job that leaves the
-- database (rollup-daily-ae) is a Cron Trigger on musebook-worker.

create or replace function app.telemetry_rotate_salt()
returns void
language sql
security definer
set search_path = public, app, pg_temp
as $$
  insert into public.telemetry_salts (day) values (current_date)
  on conflict (day) do nothing;
  delete from public.telemetry_salts where day < current_date - 1;
$$;

create or replace function app.telemetry_scrub()
returns bigint
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare v_ip bigint; v_anon bigint;
begin
  update public.action_events
     set ip_hash = null
   where ip_hash is not null
     and occurred_at < now() - interval '7 days';
  get diagnostics v_ip = row_count;
  update public.action_events_human
     set anon_id = null
   where anon_id is not null
     and occurred_at < now() - interval '30 days';
  get diagnostics v_anon = row_count;
  insert into public.ops_events (component, event_name, level, outcome, metadata)
  values ('telemetry', 'scrub', 'info', 'ok',
          jsonb_build_object('ip_nulled', v_ip, 'anon_nulled', v_anon));
  return v_ip + v_anon;
end;
$$;

-- Delete 'impression' rows inside human leaves 120-121 days old, then vacuum
-- that leaf. Runs once per partition, ever.
create or replace function app.telemetry_compact()
returns bigint
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_leaf   text;
  v_day    date := current_date - 120;
  v_n      bigint := 0;
begin
  v_leaf := format('public.action_events_human_%s', to_char(v_day, 'YYYYMMDD'));
  if to_regclass(v_leaf) is null then
    return 0;
  end if;
  execute format('delete from %s where action = ''impression''', v_leaf);
  get diagnostics v_n = row_count;
  execute format('vacuum (analyze) %s', v_leaf);
  insert into public.ops_events (component, event_name, level, outcome, metadata)
  values ('telemetry', 'compact', 'info', 'ok',
          jsonb_build_object('leaf', v_leaf, 'deleted', v_n));
  return v_n;
end;
$$;

-- THE ONLY thing that drops an action_events leaf (§13.7.4). Retention windows:
-- agent leaves 90 days, human leaves 400 days (§13.6.2). A leaf is dropped ONLY
-- when that day's action_events_daily rows exist — a missing rollup refuses
-- the drop and alerts instead (gate check 6 / §13.11 check 14).
create or replace function app.telemetry_retention()
returns bigint
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  r        record;
  v_dropped bigint := 0;
  v_window  interval;
  v_has_rollup boolean;
begin
  for r in
    select c.relname as leaf, n.nspname as nsp,
           substring(c.relname from 'action_events_(human|agent)_(\d{8})') as plane,
           to_date(substring(c.relname from '(\d{8})$'), 'YYYYMMDD') as day
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_inherits i on i.inhrelid = c.oid
      join pg_class p on p.oid = i.inhparent
     where p.relname in ('action_events_human', 'action_events_agent')
       and c.relispartition
  loop
    v_window := case r.plane when 'agent' then interval '90 days'
                             else interval '400 days' end;
    if r.day >= current_date - v_window then
      continue;                                        -- inside the window: keep
    end if;

    select exists (
      select 1 from public.action_events_daily d
       where d.day = r.day and d.actor_plane::text = r.plane
    ) into v_has_rollup;

    if not v_has_rollup then
      insert into public.ops_events (component, event_name, level, outcome, metadata)
      values ('telemetry', 'retention_refused', 'error', 'blocked',
              jsonb_build_object('leaf', r.leaf, 'day', r.day,
                                 'reason', 'action_events_daily rows missing'));
      continue;                                        -- NEVER drop unsummarized data
    end if;

    execute format('drop table %s.%s', r.nsp, r.leaf);
    v_dropped := v_dropped + 1;
    insert into public.ops_events (component, event_name, level, outcome, metadata)
    values ('telemetry', 'retention_drop', 'info', 'ok',
            jsonb_build_object('leaf', r.leaf, 'day', r.day));
  end loop;
  return v_dropped;
end;
$$;

-- viewer-sequences: rebuild viewer_recent_actions for viewers with events in
-- the last hour (§13.7.4). Newest-first action list capped at 128.
create or replace function app.rollup_viewer_recent_actions()
returns bigint
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare v_rows bigint;
begin
  with touched as (
    select distinct e.viewer_user_id
      from public.action_events_human e
     where e.occurred_at > now() - interval '1 hour'
       and e.viewer_user_id is not null
  ),
  seq as (
    select e.viewer_user_id,
           jsonb_agg(jsonb_build_object(
             'action', e.action, 'post_id', e.post_id,
             'surface', e.surface, 'at', e.occurred_at,
             'dwell_ms', e.dwell_ms)
             order by e.occurred_at desc) as actions,
           count(*) as action_count,
           min(e.occurred_at) as window_start
      from public.action_events_human e
     where e.viewer_user_id in (select viewer_user_id from touched)
       and e.occurred_at > now() - interval '30 days'
     group by e.viewer_user_id
  )
  insert into public.viewer_recent_actions as t
    (viewer_user_id, actions, topic_counts, action_count, window_start, computed_at)
  select viewer_user_id,
         (select jsonb_agg(v) from (select v from jsonb_array_elements(actions) v limit 128) s),
         '{}'::jsonb,
         action_count, window_start, now()
    from seq
  on conflict (viewer_user_id) do update set
    actions = excluded.actions, action_count = excluded.action_count,
    window_start = excluded.window_start, computed_at = now();
  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

revoke execute on function app.rollup_action_events_daily(date, actor_plane) from public, anon, authenticated;
revoke execute on function app.rollup_post_stats_daily(date) from public, anon, authenticated;
revoke execute on function app.apply_ae_post_stats_daily(date, jsonb) from public, anon, authenticated;
revoke execute on function app.rollup_post_agent_stats_daily(date) from public, anon, authenticated;
revoke execute on function app.apply_ae_agent_stats_daily(date, jsonb) from public, anon, authenticated;
revoke execute on function app.rollup_creator_stats_daily(date) from public, anon, authenticated;
revoke execute on function app.refresh_post_stats_rolling() from public, anon, authenticated;
revoke execute on function app.telemetry_rotate_salt() from public, anon, authenticated;
revoke execute on function app.telemetry_scrub() from public, anon, authenticated;
revoke execute on function app.telemetry_compact() from public, anon, authenticated;
revoke execute on function app.telemetry_retention() from public, anon, authenticated;
revoke execute on function app.rollup_viewer_recent_actions() from public, anon, authenticated;
grant execute on function app.rollup_action_events_daily(date, actor_plane) to musebook_jobs;
grant execute on function app.rollup_post_stats_daily(date) to musebook_jobs;
grant execute on function app.apply_ae_post_stats_daily(date, jsonb) to musebook_jobs;
grant execute on function app.rollup_post_agent_stats_daily(date) to musebook_jobs;
grant execute on function app.apply_ae_agent_stats_daily(date, jsonb) to musebook_jobs;
grant execute on function app.rollup_creator_stats_daily(date) to musebook_jobs;
grant execute on function app.refresh_post_stats_rolling() to musebook_jobs;
grant execute on function app.telemetry_rotate_salt() to musebook_jobs;
grant execute on function app.telemetry_scrub() to musebook_jobs;
grant execute on function app.telemetry_compact() to musebook_jobs;
grant execute on function app.telemetry_retention() to musebook_jobs;
grant execute on function app.rollup_viewer_recent_actions() to musebook_jobs;

-- The Cron Trigger calls apply_ae_* as bare statements (one per chunk — no
-- explicit tx, §13.7.3), so there is no app.enter() in the call path. Like
-- write_ops_event, the verb itself is granted to the worker login; the
-- security-definer body still writes only rollup columns.
grant execute on function app.apply_ae_post_stats_daily(date, jsonb) to musebook_worker;
grant execute on function app.apply_ae_agent_stats_daily(date, jsonb) to musebook_worker;

-- The watermark row is jobs-plane data, but the Cron Trigger writes it as a
-- bare statement like the apply_ae_* calls above — so it gets a verb too.
create or replace function app.record_ae_run(
  p_day    date,
  p_pass   text,
  p_status text,
  p_rows   bigint default 0,
  p_detail text   default null
) returns void
language sql
security definer
set search_path = public, app, pg_temp
as $$
  insert into public.telemetry_ae_runs (day, pass, status, rows, detail)
  values (p_day, p_pass, p_status, p_rows, p_detail)
  on conflict (day, pass) do update
    set status = excluded.status, rows = excluded.rows,
        detail = excluded.detail, ran_at = now();
$$;
grant execute on function app.record_ae_run(date, text, text, bigint, text) to musebook_worker;

-- §13.7.4's schedule — pure SQL on pg_cron; rollup-daily-ae is the lone Cron
-- Trigger (musebook-worker, hourly, gated on hour === 4).
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('telemetry-salt', '5 0 * * *',
      $cmd$select app.telemetry_rotate_salt()$cmd$);
    perform cron.schedule('viewer-sequences', '*/5 * * * *',
      $cmd$select app.rollup_viewer_recent_actions()$cmd$);
    perform cron.schedule('rollup-daily-pg', '25 3 * * *',
      $cmd$select app.rollup_action_events_daily(current_date - 1, 'human'),
               app.rollup_action_events_daily(current_date - 1, 'agent'),
               app.rollup_post_stats_daily(current_date - 1),
               app.rollup_post_agent_stats_daily(current_date - 1)$cmd$);
    perform cron.schedule('telemetry-scrub', '40 3 * * *',
      $cmd$select app.telemetry_scrub()$cmd$);
    perform cron.schedule('telemetry-compact', '50 3 * * *',
      $cmd$select app.telemetry_compact()$cmd$);
    perform cron.schedule('rollup-creator', '40 4 * * *',
      $cmd$select app.rollup_creator_stats_daily(current_date - 1)$cmd$);
    perform cron.schedule('rollup-hourly', '0 * * * *',
      $cmd$select app.refresh_post_stats_rolling()$cmd$);
    perform cron.schedule('telemetry-retention', '10 5 * * *',
      $cmd$select app.telemetry_retention()$cmd$);
  end if;
end $$;
