-- scripts/sql/assert-rls-worker.sql — §15.6 axis B + G-ROLE gate's live half.
-- Executed AS musebook_worker (the runner builds the worker URL). Proves by
-- execution that planes can only reach what §4.14's grant matrix declares —
-- SET ROLE inside a Worker session is exactly the production pattern.
--
-- count_or_zero returns -1 when the GRANT denies the table, matching the
-- §15.6 rule: a failure here is silent rows, never a thrown error.

create or replace function pg_temp.count_or_zero(p_table text)
returns bigint language plpgsql as $$
declare n bigint;
begin
  execute format('select count(*) from public.%I', p_table) into n;
  return n;
exception when insufficient_privilege or undefined_table then
  return -1;
end;
$$;

set local search_path = pg_temp, public, pg_catalog;

-- (1) musebook_worker with no plane set can read nothing at all.
do $$
declare v_leak text;
begin
  select string_agg(c.relname, ', ') into v_leak
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind in ('r','p')
     and c.relispartition = false
     and pg_temp.count_or_zero(c.relname) > 0;
  if v_leak is not null then
    raise exception 'musebook_worker with no plane read rows from: %', v_leak;
  end if;
end;
$$;

-- (2) planes vs tables they are not declared for.
do $$
declare
  rec record;
  n bigint;
  v_leak text;
  v_rows jsonb;
  v_cur text;
begin
  create temporary table plane_forbidden (plane text, tbl text) on commit drop;
  insert into plane_forbidden
    select p.plane, t.tbl
      from (values ('musebook_public_reader'), ('musebook_kernel'), ('musebook_jobs')) as p(plane)
      cross join (values
        -- kernel-only tables
        ('post_bodies'), ('post_versions'), ('access_grants'),
        ('x402_quotes'), ('x402_settlements'), ('payout_ledger'), ('refunds'),
        ('users'), ('wallets'), ('wallet_nonces'), ('sessions'),
        ('creator_publishing_defaults'), ('assets'),
        -- jobs-only tables
        ('action_events'), ('action_events_daily'), ('agent_spend_reservations'),
        ('approval_queue'), ('audit_log'), ('channels'), ('delegation_spend'),
        ('delegations'), ('distribution_jobs'), ('idempotency_keys'),
        ('job_outbox'), ('model_registry'), ('ops_events'),
        ('platform_analytics'), ('platform_variants'),
        ('post_classifications_raw'), ('post_embeddings'), ('ranking_weights'),
        ('slate_items'), ('slates'), ('user_embeddings'),
        -- client-own tables nobody else reads
        ('agent_post_schedules'), ('blocks'), ('bookmarks'), ('mutes'),
        -- public-read surface (worker_read grants all three planes)
        ('agent_identities'), ('artifacts'), ('comments'), ('connectors'),
        ('follows'), ('likes'), ('platform_publishing_defaults'),
        ('platforms'), ('post_assets'), ('post_classifications'),
        ('post_counters'), ('posts'), ('profiles'), ('reposts'), ('scopes')
      ) as t(tbl)
   where case p.plane
           when 'musebook_public_reader' then t.tbl not in (
             'agent_identities','artifacts','comments','connectors','follows',
             'likes','platform_publishing_defaults','platforms','post_assets',
             'post_classifications','post_counters','posts','profiles',
             'reposts','scopes')
           when 'musebook_kernel' then t.tbl not in (
             'access_grants','post_bodies','post_versions','payout_ledger',
             'refunds','sessions','users','wallets','wallet_nonces',
             'x402_quotes','x402_settlements','assets',
             'creator_publishing_defaults','delegations',
             'agent_identities','artifacts','comments','connectors','follows',
             'likes','platform_publishing_defaults','platforms','post_assets',
             'post_classifications','post_counters','posts','profiles',
             'reposts','scopes')
           when 'musebook_jobs' then t.tbl not in (
             'action_events','action_events_daily','agent_spend_reservations',
             'approval_queue','audit_log','channels','delegation_spend',
             'delegations','distribution_jobs','idempotency_keys',
             'job_outbox','model_registry','ops_events','platform_analytics',
             'platform_variants','post_classifications_raw','post_embeddings',
             'ranking_weights','slate_items','slates','user_embeddings',
             'agent_identities','artifacts','comments','connectors','follows',
             'likes','platform_publishing_defaults','platforms','post_assets',
             'post_classifications','post_counters','posts','profiles',
             'reposts','scopes')
         end;

  -- Snapshot the matrix into memory: after SET LOCAL ROLE the session can no
  -- longer read the worker-owned temp table, so iteration must not touch it.
  select jsonb_agg(jsonb_build_object('plane', pf.plane, 'tbl', pf.tbl)
                   order by pf.plane, pf.tbl)
    into v_rows from plane_forbidden pf;

  for rec in
    select x->>'plane' as plane, x->>'tbl' as tbl
      from jsonb_array_elements(v_rows) x
  loop
    if rec.plane is distinct from v_cur then
      reset role;
      execute format('set local role %I', rec.plane);
      v_cur := rec.plane;
    end if;
    n := pg_temp.count_or_zero(rec.tbl);
    if n > 0 then
      v_leak := coalesce(v_leak || ', ', '') || rec.plane || '->' || rec.tbl;
    end if;
  end loop;
  reset role;

  if v_leak is not null then
    raise exception 'plane read an undeclared table: %', v_leak;
  end if;
end;
$$;

-- (3) positive controls: declared reads must actually return rows — a suite
--     where every grant were missing would also pass (2).
do $$
begin
  set local role musebook_public_reader;
  if pg_temp.count_or_zero('posts') <> 24 then
    raise exception 'public_reader posts count % <> 24',
      pg_temp.count_or_zero('posts');
  end if;
  reset role;

  set local role musebook_kernel;
  if pg_temp.count_or_zero('post_bodies') <= 0 then
    raise exception 'kernel cannot read post_bodies';
  end if;
  if pg_temp.count_or_zero('users') <= 0 then
    raise exception 'kernel cannot read users';
  end if;
  reset role;

  set local role musebook_jobs;
  if pg_temp.count_or_zero('action_events') <> 40 then
    raise exception 'jobs action_events count % <> 40',
      pg_temp.count_or_zero('action_events');
  end if;
  if pg_temp.count_or_zero('delegations') <= 0 then
    raise exception 'jobs cannot read delegations';
  end if;
  reset role;
end;
$$;
