-- dsar (M11): dsar_requests + public.erase_user_subject (§15.11).
create table public.dsar_requests (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid references public.users(id) on delete set null,
  agent_id     uuid references public.agent_identities(id) on delete set null,
  kind         text not null,                -- 'export' | 'delete' | 'objection'
  state        text not null default 'received',
  requested_at timestamptz not null default now(),
  due_at       timestamptz not null default (now() + interval '30 days'),
  started_at   timestamptz,
  completed_at timestamptz,
  artifact_key text,                         -- R2 key in musebook-paid under dsar/, never a URL
  note         text,
  constraint dsar_kind_allowed check (kind in ('export','delete','objection')),
  constraint dsar_state_allowed check (state in ('received','verifying','running','completed','refused')),
  constraint dsar_has_subject check (user_id is not null or agent_id is not null)
);
create index dsar_requests_open_idx on public.dsar_requests (due_at) where completed_at is null;

alter table public.dsar_requests enable row level security;
alter table public.dsar_requests force row level security;
grant select on public.dsar_requests to authenticated;
create policy dsar_own_read on public.dsar_requests
  for select to authenticated using (user_id = (select auth.uid()));
grant select, insert, update on public.dsar_requests to musebook_kernel;
-- The consent route flips ONLY this column; column-level grant keeps the
-- kernel plane from rewriting any other user field.
grant update (analytics_consent) on public.users to musebook_kernel;
create policy dsar_kernel on public.dsar_requests
  for all to musebook_kernel using (true) with check (true);
create policy users_kernel_consent_update on public.users
  for update to musebook_kernel using (true) with check (true);

-- §15.11.1: identity, content and Postgres-behavioural in ONE transaction, in a
-- fixed order — behavioural nulling first (a mid-run failure never leaves an
-- orphaned subject id), then content tombstone, then identity cascade — with an
-- ops_events row per class carrying counts. R2 object deletion is driven by a
-- Queue message AFTER commit and is not part of this function.
create or replace function public.erase_user_subject(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_events_n    bigint := 0;
  v_sessions_n  bigint := 0;
  v_posts_n     bigint := 0;
  v_n           bigint := 0;
  v_deleted     boolean := false;
begin
  -- 1. Behavioural — Postgres: subject nulled in place, rows RETAINED (§4.9's
  -- rule). The ranking record stays; the identity does not.
  update public.action_events_human
     set viewer_user_id = null, anon_id = null, ip_hash = null, view_session_id = null
   where viewer_user_id = p_user_id;
  get diagnostics v_events_n = row_count;
  insert into public.ops_events (component, event_name, level, outcome, metadata)
  values ('dsar', 'erase.behavioural', 'info', 'ok',
          jsonb_build_object('user_id', p_user_id, 'nulled', v_events_n));

  -- 2. Content: tombstone posts (the 30-day undo window; hard delete is a
  -- separate GC pass), unpublish from every surface.
  update public.posts
     set deleted_at = now(), status = 'removed'
   where author_user_id = p_user_id and deleted_at is null;
  get diagnostics v_posts_n = row_count;
  insert into public.ops_events (component, event_name, level, outcome, metadata)
  values ('dsar', 'erase.content', 'info', 'ok',
          jsonb_build_object('user_id', p_user_id, 'tombstoned', v_posts_n));

  -- 3. Identity: delete sessions + wallets (severs the address->person mapping;
  -- payout_ledger keeps the address, nothing says whose it was), then the user.
  delete from public.sessions where user_id = p_user_id;
  get diagnostics v_sessions_n = row_count;
  delete from public.wallets where user_id = p_user_id;
  delete from public.users where id = p_user_id;
  get diagnostics v_n = row_count;
  v_deleted := v_n > 0;
  insert into public.ops_events (component, event_name, level, outcome, metadata)
  values ('dsar', 'erase.identity', 'info', 'ok',
          jsonb_build_object('user_id', p_user_id, 'sessions', v_sessions_n,
                             'deleted', v_deleted));

  return jsonb_build_object('events_nulled', v_events_n,
                            'posts_tombstoned', v_posts_n,
                            'sessions_deleted', v_sessions_n,
                            'user_deleted', v_deleted);
end;
$$;
revoke execute on function public.erase_user_subject(uuid) from public, anon, authenticated;
grant  execute on function public.erase_user_subject(uuid) to musebook_kernel;
grant  execute on function public.erase_user_subject(uuid) to musebook_jobs;

-- The dsar consumer fns (begin_dsar / collect_dsar_export / complete_dsar /
-- fail_dsar) run invoker on the jobs plane and need row access on these two
-- tables only. users/wallets/sessions stay kernel-only — erase_user_subject
-- reaches them through its definer owner (§15.11), never through a plane.
grant select, update on public.posts to musebook_jobs;
grant select, update on public.dsar_requests to musebook_jobs;
create policy posts_jobs_all        on public.posts        for all to musebook_jobs using (true) with check (true);
create policy dsar_jobs_all         on public.dsar_requests for all to musebook_jobs using (true) with check (true);
