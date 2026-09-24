-- supabase/migrations/20261103090100_media.sql   (M19; registered in §16.8 row 32)
-- §11.6 verbatim: media_models, media_jobs, the assets provenance columns and
-- the three functions (submit_media_job / finalize_media_job / fail_media_job).
-- Depends on: §4.4 assets/post_assets, §4.11 delegations/agent_spend_reservations/
-- approval_queue, §4.13 job_outbox, §10.7.2's spend functions
-- (20260922091700_agent_spend_reservations.sql, M9).
--
-- DEVIATION notes (full list in DEVIATIONS.md):
--  * approval_queue has no subject_id column (payload jsonb replaces it) and
--    requested_at defaults itself — the pending-approval insert below writes
--    (owner_user_id, delegation_id, kind='media', payload).
--  * SECURITY DEFINER is verbatim spec: the functions run as their owner,
--    which on this fleet is the postgres role — rol-bypasses RLS, so the caps
--    ledger stays server-authoritative. Callers need only EXECUTE.
--  * media_models gains one extra read grant for the Worker plane (the edge
--    route reads rows to compute the estimate before submit).

create type public.media_job_status as enum (
  'queued', 'pending_approval', 'running', 'succeeded', 'failed', 'cancelled', 'blocked_safety'
);

comment on type public.media_job_status is
  '§11.6 — transitions are owned, not the enum: see the writer table in §11.6.';

-- Prices and model ids are DATA. Spine invariant 5's rule applied to media:
-- never a literal in the bundle, always a row read per request.
create table public.media_models (
  id              uuid primary key default gen_random_uuid(),
  backend         text not null,
  model_id        text not null,
  kind            text not null,
  slot            text not null,                    -- 'default'|'fast'|'cheap'|'premium'|'i2v'
  price_atomic    numeric(78,0),                    -- null = disabled: reject, never free
  price_unit      text not null,                    -- 'per_asset' | 'per_second'
  max_duration_s  integer,
  preference_rank integer not null default 100,
  enabled         boolean not null default true,
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint media_models_backend_allowed check (backend in ('fal','replicate')),
  -- Generation output only: two of §4.2's post_kind values (§11.2).
  constraint media_models_kind_allowed check (kind in ('image','video')),
  constraint media_models_unit_allowed check (price_unit in ('per_asset','per_second')),
  constraint media_models_price_non_negative check (price_atomic is null or price_atomic >= 0)
);
create unique index media_models_backend_model_uniq on public.media_models (backend, model_id);
create index media_models_pick_idx on public.media_models (kind, slot, preference_rank)
  where enabled;

create table public.media_jobs (
  id                   uuid primary key default gen_random_uuid(),
  kind                 text not null,
  idempotency_key      text not null,
  requested_by_user_id uuid references public.users(id) on delete set null,
  delegation_id        uuid references public.delegations(id) on delete set null,
  post_id              uuid references public.posts(id) on delete set null,
  asset_id             uuid references public.assets(id) on delete set null,
  backend              text,                        -- null until the consumer picks one
  model_id             text,
  provider_request_id  text,
  prompt               text not null,
  prompt_sha256        text not null,
  params               jsonb not null default '{}'::jsonb,
  status               media_job_status not null default 'queued',
  attempt              smallint not null default 1,
  estimated_cost_atomic numeric(78,0) not null default 0,
  actual_cost_atomic    numeric(78,0) not null default 0,
  -- The two-phase hold from reserve_agent_spend (§10.7.2). Null only while the
  -- job is pending_approval or was rejected before a hold existed.
  reservation_id       uuid references public.agent_spend_reservations(id) on delete set null,
  spend_settled        boolean not null default false,
  safety_verdict       jsonb not null default '{}'::jsonb,
  error                text,
  webhook_first_seen_at timestamptz,
  webhook_delivery_count smallint not null default 0,
  created_at           timestamptz not null default now(),
  started_at           timestamptz,
  completed_at         timestamptz,
  constraint media_jobs_kind_allowed check (kind in ('image','video')),
  constraint media_jobs_backend_allowed check (backend is null or backend in ('fal','replicate')),
  constraint media_jobs_prompt_hash_len check (length(prompt_sha256) = 64),
  constraint media_jobs_terminal_has_completed check (
    status in ('queued','pending_approval','running') or completed_at is not null
  ),
  constraint media_jobs_succeeded_has_asset check (
    status <> 'succeeded' or asset_id is not null
  ),
  -- A job may only be settled through its reservation; succeeded without one is a bypass.
  constraint media_jobs_succeeded_has_reservation check (
    status <> 'succeeded' or reservation_id is not null
  )
);

-- THE MANDATORY CONSTRAINT. One submit per (kind, idempotency_key), globally.
create unique index media_jobs_kind_idem_uniq on public.media_jobs (kind, idempotency_key);

-- The webhook-side guard. A provider request id maps to exactly one job row,
-- so ten retried deliveries cannot create ten jobs or ten assets.
create unique index media_jobs_provider_request_uniq
  on public.media_jobs (backend, provider_request_id)
  where provider_request_id is not null;

create index media_jobs_delegation_idx on public.media_jobs (delegation_id, created_at desc);
create index media_jobs_pending_idx on public.media_jobs (created_at)
  where status in ('queued','running');
create unique index media_jobs_reservation_uniq on public.media_jobs (reservation_id)
  where reservation_id is not null;
create index media_jobs_post_idx on public.media_jobs (post_id) where post_id is not null;

-- Assets gain provenance columns. §4.4 already gave assets c2pa_manifest jsonb,
-- storage, object_key and url.
alter table public.assets
  add column if not exists c2pa_sidecar_key text,   -- R2 key, ALWAYS `${object_key}.c2pa`
  add column if not exists c2pa_signed_at   timestamptz,
  add column if not exists phash            bit(64),
  add column if not exists phash_frames     bit(64)[],
  add column if not exists generator        text,        -- model id, null for uploads
  add column if not exists source_kind      text not null default 'upload',
  add constraint assets_source_kind_allowed
    check (source_kind in ('upload','generated','derived','artifact_poster'));

create index assets_phash_idx on public.assets (phash) where phash is not null;
create index assets_generator_idx on public.assets (generator) where generator is not null;

alter table public.media_jobs   enable row level security;  -- musebook_worker only
alter table public.media_models enable row level security;
alter table public.media_jobs   force row level security;   -- CF-spine §2: rolbypassrls
alter table public.media_models force row level security;
grant select on public.media_models to anon, authenticated;
create policy media_models_public_read on public.media_models
  for select to anon, authenticated using (enabled);

create trigger media_models_set_updated_at before update on public.media_models
  for each row execute function app.set_updated_at();

-- Worker-plane grants (§16.8.2's posture): the jobs plane writes media_jobs
-- inside the consumers and reads the registry for model picks; the kernel
-- plane reads its own rows for the owner-scoped status route.
grant select on public.media_models to musebook_worker, musebook_jobs, musebook_kernel;
grant select, insert, update on public.media_jobs to musebook_jobs;
grant select, update on public.media_jobs to musebook_worker;
grant select on public.media_jobs to musebook_kernel;
create policy media_models_worker_read on public.media_models
  for select to musebook_worker, musebook_jobs, musebook_kernel using (true);
create policy media_jobs_jobs_all on public.media_jobs
  for all to musebook_jobs using (true) with check (true);
create policy media_jobs_worker_all on public.media_jobs
  for all to musebook_worker using (true) with check (true);
create policy media_jobs_kernel_read on public.media_jobs
  for select to musebook_kernel using (true);

-- approval_queue admits 'media' jobs (submit_media_job's approval arm inserts
-- one when the estimate clears the delegation's approval band).
do $$
begin
  if exists (
    select 1 from pg_constraint
     where conrelid = 'public.approval_queue'::regclass
       and conname = 'approval_queue_kind_allowed'
       and pg_get_constraintdef(oid) not like '%media%'
  ) then
    alter table public.approval_queue drop constraint approval_queue_kind_allowed;
    alter table public.approval_queue
      add constraint approval_queue_kind_allowed
        check (kind in ('publish','comment','spend','connect_channel','media'));
  end if;
end $$;

-- The three functions this migration adds. Each is one round trip and one
-- implicit transaction, which is the only transactional shape available
-- through Hyperdrive.

-- 1. SUBMIT. Caps, insert, hold, reservation_id, outbox row — atomically.
--    Returns allowed=false having contacted no provider when a cap fires.
create or replace function public.submit_media_job(
  p_delegation_id  uuid,
  p_user_id        uuid,
  p_kind           text,
  p_model_id       text,
  p_prompt         text,
  p_prompt_sha256  text,
  p_estimate_atomic numeric,
  p_idempotency_key text,
  p_params         jsonb default '{}' -- DEVIATION: spec's signature ends at the
               -- idempotency key; params carries the rest of the request
               -- (aspectRatio/quality/durationSeconds/…) one round trip later.
               -- Defaulted, so the spec's 8-arg call shape still works.
) returns table (
  allowed boolean, reason text, media_job_id uuid, job_id bigint, reservation_id uuid
) language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_job     public.media_jobs%rowtype;
  v_del     public.delegations%rowtype;
  v_hold    record;
  v_outbox  bigint;
  v_count   integer;
begin
  -- Idempotent replay: the unique index is the gate, not a prior SELECT.
  insert into public.media_jobs (kind, idempotency_key, requested_by_user_id,
                                 delegation_id, model_id, prompt, prompt_sha256,
                                 estimated_cost_atomic, params)
  values (p_kind, p_idempotency_key, p_user_id, p_delegation_id, p_model_id,
          p_prompt, p_prompt_sha256, p_estimate_atomic, coalesce(p_params,'{}'::jsonb))
  on conflict (kind, idempotency_key) do nothing
  returning * into v_job;

  if v_job.id is null then
    select * into v_job from public.media_jobs
     where kind = p_kind and idempotency_key = p_idempotency_key;
    return query select true, 'replay'::text, v_job.id, null::bigint, v_job.reservation_id;
    return;
  end if;

  select * into v_del from public.delegations where id = p_delegation_id for share;

  if p_estimate_atomic > v_del.per_action_cap_atomic then
    update public.media_jobs set status='failed', error='per_action_cap', completed_at=now()
      where id = v_job.id;
    return query select false, 'per_action_cap'::text, v_job.id, null::bigint, null::uuid;
    return;
  end if;

  select count(*) into v_count from public.media_jobs m
   where m.delegation_id = p_delegation_id
     and m.created_at > now() - v_del.spend_window
     and m.id <> v_job.id;
  if v_count >= v_del.generations_per_day then
    update public.media_jobs set status='failed', error='generation_rate', completed_at=now()
      where id = v_job.id;
    return query select false, 'generation_rate'::text, v_job.id, null::bigint, null::uuid;
    return;
  end if;

  if p_estimate_atomic > v_del.requires_approval_over_atomic then
    -- DEVIATION: the real approval_queue carries payload jsonb, not subject_id.
    insert into public.approval_queue (owner_user_id, delegation_id, kind, payload)
    values (v_del.owner_user_id, p_delegation_id, 'media',
            jsonb_build_object('media_job_id', v_job.id));
    update public.media_jobs set status='pending_approval' where id = v_job.id;
    return query select false, 'pending_approval'::text, v_job.id, null::bigint, null::uuid;
    return;
  end if;

  select * into v_hold from public.reserve_agent_spend(
    p_delegation_id, p_estimate_atomic, 'media.generate', p_idempotency_key,
    'media_job', v_job.id::text);

  if not v_hold.allowed then
    update public.media_jobs set status='failed', error=v_hold.reason, completed_at=now()
      where id = v_job.id;
    return query select false, v_hold.reason, v_job.id, null::bigint, null::uuid;
    return;
  end if;

  update public.media_jobs set reservation_id = v_hold.reservation_id where id = v_job.id;

  insert into public.job_outbox (kind, dedupe_key, payload)
  values ('media', v_job.id::text,
          jsonb_build_object('media_job_id', v_job.id,
                             'delegation_id', p_delegation_id,
                             'reservation_id', v_hold.reservation_id))
  on conflict (kind, dedupe_key) do nothing
  returning id into v_outbox;

  return query select true, 'ok'::text, v_job.id, v_outbox, v_hold.reservation_id;
end;
$$;

comment on function public.submit_media_job(uuid,uuid,text,text,text,text,numeric,text,jsonb) is
  '§11.6 — the ONLY media_jobs writer for submit. Caps → insert → approval arm
   → reserve → outbox row, in one statement. A denial writes no provider
   contact and (except pending_approval/failed bookkeeping rows) no hold.';

-- 2. FINALIZE. The asset row, the conditional transition, the settlement and
--    the post attachment, in ONE call. See §11.8 for why the UPDATE is the lock.
create or replace function public.finalize_media_job(
  p_media_job_id uuid,
  p_storage      text,        -- 'r2_public' free / 'r2_paid' gated (§11.7.1)
  p_object_key   text,
  p_url          text,
  p_content_type text,
  p_byte_len     bigint,
  p_sha256       text,
  p_width        integer,
  p_height       integer,
  p_duration_ms  integer,
  p_sidecar_key  text,
  p_phash        bit(64),
  p_phash_frames bit(64)[],
  p_actual_cost_atomic numeric
) returns table (finalized boolean, reason text, asset_id uuid)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_job   public.media_jobs%rowtype;
  v_asset uuid;
  v_settle record;
begin
  select * into v_job from public.media_jobs where id = p_media_job_id;
  if v_job.id is null then
    return query select false, 'unknown_job'::text, null::uuid; return;
  end if;
  if v_job.spend_settled or v_job.status not in ('queued','running') then
    -- A duplicate delivery. Not an error; the caller deletes the R2 object it
    -- may have just written under a colliding key and returns 200.
    return query select false, 'already_final'::text, v_job.asset_id; return;
  end if;

  -- assets_sha_owner_uniq makes re-finalizing identical bytes a no-op insert.
  insert into public.assets (owner_user_id, storage, object_key, url, content_type,
                             byte_len, sha256, width, height, duration_ms,
                             c2pa_sidecar_key, c2pa_signed_at, phash, phash_frames,
                             generator, source_kind)
  values (v_job.requested_by_user_id, p_storage, p_object_key, p_url, p_content_type,
          p_byte_len, p_sha256, p_width, p_height, p_duration_ms,
          p_sidecar_key, case when p_sidecar_key is null then null else now() end,
          p_phash, p_phash_frames, v_job.model_id, 'generated')
  on conflict (owner_user_id, sha256) do update set object_key = excluded.object_key
  returning id into v_asset;

  -- THE LOCK. Exactly one concurrent caller gets a row back.
  update public.media_jobs
     set status='succeeded', asset_id=v_asset, actual_cost_atomic=p_actual_cost_atomic,
         spend_settled=true, completed_at=now(),
         webhook_delivery_count = webhook_delivery_count + 1
   where id = p_media_job_id and status in ('queued','running') and spend_settled = false
  returning * into v_job;

  if v_job.id is null then
    return query select false, 'already_final'::text, v_asset; return;
  end if;

  select * into v_settle
    from public.settle_agent_spend(v_job.reservation_id, p_actual_cost_atomic);

  if v_job.post_id is not null then
    insert into public.post_assets (post_id, asset_id, position)
    values (v_job.post_id, v_asset,
            coalesce((select max(position)+1 from public.post_assets
                       where post_id = v_job.post_id), 0))
    on conflict (post_id, asset_id) do nothing;
  end if;

  update public.job_outbox set state='succeeded', done_at=now()
   where kind='media_finalize' and dedupe_key = p_media_job_id::text;

  return query select true, 'ok'::text, v_asset;
end;
$$;

comment on function public.finalize_media_job(uuid,text,text,text,text,bigint,text,integer,integer,integer,text,bit,bit[],numeric) is
  '§11.6/§11.8 — THE ONLY settled-asset writer. The conditional UPDATE is the
   settlement lock; asset row, post_assets join, spend settle and the outbox
   completion all live inside the same call.';

-- 3. FAIL / BLOCK / CANCEL. Transition plus release, one call.
create or replace function public.fail_media_job(
  p_media_job_id uuid,
  p_status       media_job_status,   -- 'failed' | 'blocked_safety' | 'cancelled'
  p_reason       text,
  p_verdict      jsonb default '{}'::jsonb
) returns table (changed boolean)
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_job public.media_jobs%rowtype;
begin
  update public.media_jobs
     set status = p_status, error = p_reason, safety_verdict = p_verdict,
         completed_at = now()
   where id = p_media_job_id
     and status in ('queued','pending_approval','running')
     and spend_settled = false
  returning * into v_job;

  if v_job.id is null then return query select false; return; end if;
  if v_job.reservation_id is not null then
    perform public.release_agent_spend(v_job.reservation_id, p_reason);
  end if;
  return query select true;
end;
$$;

comment on function public.fail_media_job(uuid,media_job_status,text,jsonb) is
  '§11.6 — the single failure transition: status + error + release_agent_spend
   in one call. changed=false when the job already settled or left an open
   state.';

-- The approval-time re-entry: §11.6's state table says owner approval
-- "re-enters submit_media_job's reserve-and-enqueue tail". That tail is its
-- own one-statement function so the approval path needs nothing but a call.
create or replace function public.media_job_approved(
  p_media_job_id uuid
) returns table (allowed boolean, reason text, job_id bigint)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_job    public.media_jobs%rowtype;
  v_hold   record;
  v_outbox bigint;
begin
  select * into v_job from public.media_jobs
   where id = p_media_job_id and status = 'pending_approval' for update;
  if v_job.id is null then
    return query select false, 'not_pending'::text, null::bigint; return;
  end if;

  select * into v_hold from public.reserve_agent_spend(
    v_job.delegation_id, v_job.estimated_cost_atomic, 'media.generate',
    v_job.idempotency_key, 'media_job', v_job.id::text);
  if not v_hold.allowed then
    update public.media_jobs set status='failed', error=v_hold.reason, completed_at=now()
      where id = v_job.id;
    return query select false, v_hold.reason, null::bigint; return;
  end if;

  update public.media_jobs
     set reservation_id = v_hold.reservation_id, status = 'queued'
   where id = v_job.id;

  insert into public.job_outbox (kind, dedupe_key, payload)
  values ('media', v_job.id::text,
          jsonb_build_object('media_job_id', v_job.id,
                             'delegation_id', v_job.delegation_id,
                             'reservation_id', v_hold.reservation_id))
  on conflict (kind, dedupe_key) do nothing
  returning id into v_outbox;

  return query select true, 'ok'::text, v_outbox;
end;
$$;

-- EXECUTE — Postgres's PUBLIC-default grant would let anon call the definer
-- fns directly; revoke before granting the two plane roles.
revoke all on function public.submit_media_job(uuid,uuid,text,text,text,text,numeric,text,jsonb)
  from public, anon, authenticated;
revoke all on function public.finalize_media_job(uuid,text,text,text,text,bigint,text,integer,integer,integer,text,bit,bit[],numeric)
  from public, anon, authenticated;
revoke all on function public.fail_media_job(uuid,media_job_status,text,jsonb)
  from public, anon, authenticated;
revoke all on function public.media_job_approved(uuid)
  from public, anon, authenticated;
grant execute on function public.submit_media_job(uuid,uuid,text,text,text,text,numeric,text,jsonb)
  to musebook_worker, musebook_jobs;
grant execute on function public.finalize_media_job(uuid,text,text,text,text,bigint,text,integer,integer,integer,text,bit,bit[],numeric)
  to musebook_worker, musebook_jobs;
grant execute on function public.fail_media_job(uuid,media_job_status,text,jsonb)
  to musebook_worker, musebook_jobs;
grant execute on function public.media_job_approved(uuid)
  to musebook_worker, musebook_jobs;

-- ----------------------------------------------------------- media_models seeds
-- §11.3's endpoint ids (fal) and §11.5's indicative prices. price_atomic is
-- the seed's estimate; a null would mean "disabled, reject with no_price".
-- Replicate rows are version-hash ids and stay enabled=false behind
-- MEDIA_BACKEND_REPLICATE_ENABLED=false until H18's token exists.
insert into public.media_models
  (backend, model_id, kind, slot, price_atomic, price_unit, max_duration_s, preference_rank, enabled, notes)
values
  ('fal','fal-ai/nano-banana-pro','image','default',40000,'per_asset',null,10,true,'Nano Banana Pro — strong typography and realism'),
  ('fal','fal-ai/flux-2/flash','image','fast',12000,'per_asset',null,20,true,'FLUX.2 flash — draft tier'),
  ('fal','fal-ai/z-image/turbo','image','cheap',3000,'per_asset',null,30,true,'Z-Image Turbo — lowest cost per image'),
  ('fal','fal-ai/bytedance/seedance/v1.5/pro/text-to-video','video','default',60000,'per_second',20,10,true,'Seedance 1.5 Pro text-to-video'),
  ('fal','bytedance/seedance-2.0/text-to-video','video','premium',120000,'per_second',20,20,true,'Seedance 2.0'),
  ('fal','bytedance/seedance-2.0/fast/text-to-video','video','fast',20000,'per_second',20,30,true,'Seedance 2.0 fast — draft tier'),
  -- i2v: no verified price → price_atomic null disables it structurally.
  ('fal','fal-ai/kling-video/v3/pro/image-to-video','video','i2v',null,'per_second',20,40,false,'Kling v3 Pro image-to-video — disabled until priced'),
  -- Replicate failover rows: enabled=false until MEDIA_BACKEND_REPLICATE_ENABLED.
  ('replicate','UNVERIFIED-replicate-image-default','image','default',40000,'per_asset',null,50,false,'replicate image default — placeholder version hash, enable after live reconcile'),
  ('replicate','UNVERIFIED-replicate-video-default','video','default',60000,'per_second',20,50,false,'replicate video default — placeholder version hash, enable after live reconcile')
on conflict (backend, model_id) do nothing;
