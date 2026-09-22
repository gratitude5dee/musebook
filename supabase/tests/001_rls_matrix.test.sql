-- supabase/tests/001_rls_matrix.test.sql — pgTAP RLS matrix for G-RLS.
-- Asserts BEHAVIOUR (counts / row effects), never the DDL — that is what
-- separates this suite from G-ROLE's §4.14 posture assertions.
--
-- Axis A (PostgREST roles) runs here. Axis B (musebook_* planes) does not:
-- SET ROLE ignores superuser and postgres is not a member of the Worker
-- roles — §15.6 requires a real musebook_worker connection, so axis B lives
-- in scripts/db-assert-rls.ts, run by `pnpm db:assert-rls` (G-ROLE).
--
-- count_or_zero returns -1 when the GRANT itself denies the table, so every
-- "cannot reach" assertion is `<= 0` and a table that is wide open at the
-- GRANT layer still fails — the §15.6 rule applied inside Postgres.

create schema if not exists pgtap;
create extension if not exists pgtap with schema pgtap;
grant usage on schema pgtap to public;

begin;

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

set local search_path = pg_temp, pgtap, public, extensions, pg_catalog;

select no_plan();

-- ── axis A: anon ───────────────────────────────────────────────────────────
set local role anon;

-- positive controls: the public-read surface must actually return seeded rows.
select is((select count(*)::int from public.posts), 24,
          'anon reads the 24 published seed posts');
select is((select count(*)::int from public.profiles), 5,
          'anon reads the 5 seed profiles');
select ok(pg_temp.count_or_zero('comments') > 0,
          'anon reads published comments');
select ok(pg_temp.count_or_zero('likes') > 0, 'anon reads likes');
select ok(pg_temp.count_or_zero('post_counters') > 0,
          'anon reads post_counters');

-- every table with no public-read policy is invisible to a client. -1 means
-- the grant is absent; 0 means RLS filtered it. Both are unreachable.
select ok(pg_temp.count_or_zero(t) <= 0, format('anon cannot reach %s', t))
from (values
  ('post_bodies'), ('post_versions'), ('access_grants'),
  ('x402_quotes'), ('x402_settlements'), ('payout_ledger'), ('refunds'),
  ('users'), ('wallets'), ('wallet_nonces'), ('sessions'),
  ('creator_publishing_defaults'), ('assets'), ('approval_queue'),
  ('delegations'), ('delegation_spend'), ('agent_spend_reservations'),
  ('agent_post_schedules'), ('action_events'), ('action_events_daily'),
  ('audit_log'), ('idempotency_keys'), ('job_outbox'), ('ops_events'),
  ('platform_analytics'), ('platform_variants'), ('post_classifications_raw'),
  ('post_embeddings'), ('slate_items'), ('slates'), ('user_embeddings'),
  ('distribution_jobs'), ('model_registry'), ('ranking_weights'),
  ('channels'), ('blocks'), ('bookmarks'), ('mutes')
) as v(t);

-- client roles never write: the migration revokes INSERT/UPDATE/DELETE from
-- anon and authenticated, so every write attempt fails at the GRANT layer.
select throws_like($$delete from public.posts$$, '%permission denied%',
                   'anon holds no DELETE on posts');
select throws_like($$update public.posts set title = 'x'$$,
                   '%permission denied%',
                   'anon holds no UPDATE on posts');
select throws_like(
  $$insert into public.likes (post_id, user_id)
    values ('44444444-4444-4444-8444-000000000001',
            '11111111-1111-4111-8111-000000000002')$$,
  '%permission denied%',
  'anon holds no INSERT on likes');

-- ── axis A: authenticated with no jwt claims (auth.uid() = null) ───────────
reset role;
set local role authenticated;

select ok(pg_temp.count_or_zero('bookmarks') <= 0,
          'authenticated with no claims sees no bookmarks');
select ok(pg_temp.count_or_zero('wallets') <= 0,
          'authenticated with no claims sees no wallets');
select ok(pg_temp.count_or_zero('mutes') <= 0,
          'authenticated with no claims sees no mutes');
select ok(pg_temp.count_or_zero('blocks') <= 0,
          'authenticated with no claims sees no blocks');
select ok(pg_temp.count_or_zero('delegations') <= 0,
          'authenticated with no claims sees no delegations');
select throws_like($$delete from public.posts$$, '%permission denied%',
                   'authenticated holds no DELETE on posts');
select throws_like(
  $$insert into public.likes (post_id, user_id)
    values ('44444444-4444-4444-8444-000000000001',
            '11111111-1111-4111-8111-000000000002')$$,
  '%permission denied%',
  'authenticated holds no INSERT on likes');

select * from finish();
rollback;
