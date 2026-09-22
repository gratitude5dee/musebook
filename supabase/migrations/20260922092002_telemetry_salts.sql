-- 20260922092002_telemetry_salts.sql — §13.2.3 verbatim, shipped early at M6.
--
-- §16.8 assigns this file to M11; M6's /api/events collector hashes client IPs
-- through the daily salt, so the table ships here (D37). The companion
-- rotate function and its pg_cron entry come from §13.7.4's schedule table.
--
-- Access note (D38). §13.2.3's verbatim grant targets musebook_worker, but
-- §4.14's grant matrix forbids direct table grants to that role — every
-- privileged statement goes through a task role via app.enter. salt.ts's
-- insert-or-return therefore lives in app.telemetry_salt_for_day, which
-- enters musebook_jobs the same way app.telemetry_rotate_salt does.

create table public.telemetry_salts (
  day        date primary key,
  salt       bytea not null default extensions.gen_random_bytes(32),
  created_at timestamptz not null default now(),
  constraint telemetry_salts_len check (octet_length(salt) = 32)
);
alter table public.telemetry_salts enable row level security;  -- jobs plane only (4.14)
alter table public.telemetry_salts force row level security;
revoke all on public.telemetry_salts from anon, authenticated;
-- Jobs plane only (§4.14): musebook_worker holds no direct grant — it reaches
-- the table through app.telemetry_salt_for_day / app.telemetry_rotate_salt,
-- which app.enter('musebook_jobs') first.
grant select, insert, update, delete on public.telemetry_salts to musebook_jobs;
create policy telemetry_salts_jobs_all on public.telemetry_salts
  for all to musebook_jobs using (true) with check (true);

-- The salt for a day is generated randomly and destroyed after two days
-- (§13.9.2): a derivable salt can be recomputed forever, which defeats the
-- point of rotating it. There is no MUSEBOOK_TELEMETRY_SALT anywhere.
create or replace function app.telemetry_rotate_salt()
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  perform app.enter('musebook_jobs');
  insert into public.telemetry_salts (day) values (current_date)
    on conflict (day) do nothing;
  delete from public.telemetry_salts where day < current_date - 1;
end;
$$;
revoke all on function app.telemetry_rotate_salt() from public, anon, authenticated;
grant execute on function app.telemetry_rotate_salt() to musebook_worker;

-- §13.9.2's read path: insert-or-return today's salt under the jobs plane.
-- FRESH-bound callers always see the row they would have written.
create or replace function app.telemetry_salt_for_day(p_day date)
returns bytea
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_salt bytea;
begin
  perform app.enter('musebook_jobs');
  insert into public.telemetry_salts (day) values (p_day)
    on conflict (day) do update set day = excluded.day
    returning salt into v_salt;
  return v_salt;
end;
$$;
revoke all on function app.telemetry_salt_for_day(date) from public, anon, authenticated;
grant execute on function app.telemetry_salt_for_day(date) to musebook_worker;

-- §13.7.4's schedule table: pure SQL on a schedule stays in pg_cron.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('telemetry-salt', '5 0 * * *',
      'select app.telemetry_rotate_salt()');
  else
    raise notice 'pg_cron not enabled; telemetry-salt schedule skipped';
  end if;
end $$;
