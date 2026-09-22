-- 13. Ops: idempotency_keys, job_outbox, ops_events, reapers.

-- Shape ported from MogBook's api_idempotency_keys
-- (/home/user/mog/supabase/migrations/20260305120000_phase3_bot_scheduler.sql:41-54),
-- which is one of the few designs in that repo worth keeping verbatim.
create table public.idempotency_keys (
  id              uuid primary key default gen_random_uuid(),
  endpoint        text not null,
  idempotency_key text not null,
  actor           text not null,          -- user id, agent id, or payer address
  request_sha256  text,
  state           text not null default 'in_flight',
  response_status integer,
  response_body   jsonb,
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null default (now() + interval '24 hours'),
  constraint idempotency_keys_state_allowed check (state in ('in_flight','complete')),
  constraint idempotency_keys_complete_has_status
    check (state <> 'complete' or response_status is not null)
);
create unique index idempotency_keys_triple_uniq
  on public.idempotency_keys (endpoint, idempotency_key, actor);
create index idempotency_keys_expires_idx on public.idempotency_keys (expires_at);

-- Lightweight structured ops log. Fails open at the application layer: a failed
-- insert here must never fail the request it describes.
create table public.ops_events (
  id         bigint generated always as identity primary key,
  at         timestamptz not null default now(),
  component  text not null,
  event_name text not null,
  level      text not null default 'info',
  outcome    text,
  request_id text,
  metadata   jsonb not null default '{}'::jsonb,
  constraint ops_events_level_allowed check (level in ('debug','info','warn','error'))
);
create index ops_events_at_idx on public.ops_events (at desc);
create index ops_events_component_idx on public.ops_events (component, event_name, at desc);
create index ops_events_errors_idx on public.ops_events (at desc) where level = 'error';

-- THE TRANSACTIONAL OUTBOX. The single durable record that a job is owed.
-- A Cloudflare Queues message is a fast path over this table, never the record itself.
create table public.job_outbox (
  id          bigint generated always as identity primary key,
  kind        text not null,
  -- Natural key of the work. Makes a double-enqueue a no-op at the storage engine
  -- rather than a duplicate GPU charge or a duplicate tweet.
  dedupe_key  text not null,
  -- Bounded because the whole row must fit a 128 KB Queues message with room to
  -- spare. R2 keys and row ids only; never a body, a transcript or media bytes.
  payload     jsonb not null,
  state       job_state not null default 'queued',
  attempts    integer not null default 0,
  last_error  text,
  enqueued_at timestamptz,          -- when send() last succeeded; null = never sent
  claimed_at  timestamptz,
  done_at     timestamptz,
  created_at  timestamptz not null default now(),
  constraint job_outbox_kind_allowed check (kind in (
    'classify','embed','distribute','media','media_finalize','agent_cancel')),
  constraint job_outbox_dedupe_uniq unique (kind, dedupe_key),
  constraint job_outbox_attempts_bounded check (attempts between 0 and 100),
  -- octet_length(payload::text), not pg_column_size(): jsonb_out is IMMUTABLE and
  -- pg_column_size is STABLE, and a CHECK rejects a non-immutable function outright.
  constraint job_outbox_payload_size check (octet_length(payload::text) <= 65536),
  constraint job_outbox_terminal_has_time
    check (state not in ('succeeded','dead') or done_at is not null)
);
-- The sweeper's only index. Partial, so it holds the work list and nothing else:
-- under healthy operation it is empty. The predicate is state alone, not
-- "enqueued_at is null", so it also recovers a row whose message was sent and then
-- lost (retention expiry, DLQ discard). A redundant re-send is free: claim_job()
-- returns zero rows and the consumer acks.
create index job_outbox_pending_idx on public.job_outbox (created_at)
  where state = 'queued';
-- The DLQ consumer and the ops dashboard read these two.
create index job_outbox_dead_idx on public.job_outbox (created_at desc) where state = 'dead';
create index job_outbox_running_idx on public.job_outbox (claimed_at) where state = 'running';

-- Atomic claim. Returns zero rows if another delivery already claimed or finished
-- this job, which is the idempotency gate every consumer needs because Queues is
-- at-least-once with no exactly-once mode. Called once per message.
create or replace function public.claim_job(p_job_id bigint)
returns table (kind text, payload jsonb, attempts integer)
language sql
as $$
  update public.job_outbox
     set state = 'running', attempts = attempts + 1, claimed_at = now()
   where id = p_job_id and state = 'queued'
  returning job_outbox.kind, job_outbox.payload, job_outbox.attempts;
$$;

alter table public.idempotency_keys enable row level security;
alter table public.job_outbox       enable row level security;
alter table public.ops_events       enable row level security;

-- Reapers. These stay in pg_cron: pure SQL on a schedule, no external service,
-- no Hyperdrive round trip, no Queues operation billed.
-- This is the ONLY reap-slates schedule in the plan. Section 9 does not schedule one;
-- section 9.17 cites this line. A slate is kept for two hours past its 30-minute
-- expiry so that a late telemetry batch can still resolve its slate_id (section 13.7.3).
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('reap-idempotency', '*/15 * * * *',
      'delete from public.idempotency_keys where expires_at < now()');
    perform cron.schedule('reap-wallet-nonces', '*/15 * * * *',
      'delete from public.wallet_nonces where expires_at < now() - interval ''1 day''');
    perform cron.schedule('reap-slates', '23 * * * *',
      'delete from public.slates where expires_at < now() - interval ''2 hours''');
    perform cron.schedule('reap-job-outbox', '7 * * * *',
      'delete from public.job_outbox
         where state = ''succeeded'' and done_at < now() - interval ''7 days''');
  else
    raise notice 'pg_cron not enabled; reaper schedules skipped';
  end if;
end $$;

create or replace function public.publish_post(
  p_post_id uuid,
  p_platforms text[] default '{}'
) returns table (post_id uuid, job_ids bigint[])
language plpgsql
-- SECURITY DEFINER so the kernel plane does not need blanket UPDATE on posts or
-- INSERT on job_outbox (4.14 grants it neither). The function is the capability;
-- the grant below is the only way to reach it.
security definer
set search_path = public, pg_temp
as $$
declare v_hash text; v_version uuid; v_jobs bigint[];
begin
  update public.posts
     set status = 'published', published_at = coalesce(published_at, now())
   where id = p_post_id and deleted_at is null
  returning content_hash into v_hash;

  if v_hash is null then
    raise exception 'publish_post: no publishable post %', p_post_id using errcode = '22023';
  end if;

  select id into v_version
    from public.post_versions
   where post_id = p_post_id
   order by version desc
   limit 1;

  with ins as (
    insert into public.job_outbox (kind, dedupe_key, payload)
    values
      ('classify',  'classify:' || v_hash,
       jsonb_build_object('post_id', p_post_id, 'content_hash', v_hash)),
      ('embed',     'embed:' || v_hash,
       jsonb_build_object('post_id', p_post_id, 'content_hash', v_hash)),
      ('distribute','distribute:' || v_version::text,
       jsonb_build_object('post_id', p_post_id,
                          'post_version_id', v_version,
                          'platforms', to_jsonb(p_platforms),
                          'source', 'composer'))
    on conflict (kind, dedupe_key) do nothing
    returning id
  )
  select array_agg(id) from ins into v_jobs;

  return query select p_post_id, coalesce(v_jobs, '{}'::bigint[]);
end;
$$;
revoke all on function public.publish_post(uuid, text[]) from public, anon, authenticated;
