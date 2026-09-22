-- 20260922092002_telemetry_salts.sql — §13.2.3 verbatim, shipped early at M6.
--
-- §16.8 assigns this file to M11; M6's /api/events collector hashes client IPs
-- through the daily salt, so the table ships here (D37). The companion
-- rotate function and its pg_cron entry come from §13.7.4's schedule table.
--
-- Two access notes (D38). §13.2.3's verbatim grant is `select, insert` to
-- musebook_worker, but §13.9.2's salt.ts runs `insert … on conflict (day)
-- do update … returning salt` directly as musebook_worker — no app.enter —
-- which needs UPDATE as well, and RLS needs a policy for the role at all.
-- The rotate function's delete is covered the same way.

create table public.telemetry_salts (
  day        date primary key,
  salt       bytea not null default extensions.gen_random_bytes(32),
  created_at timestamptz not null default now(),
  constraint telemetry_salts_len check (octet_length(salt) = 32)
);
alter table public.telemetry_salts enable row level security;  -- jobs plane only (4.14)
alter table public.telemetry_salts force row level security;
revoke all on public.telemetry_salts from anon, authenticated;
grant select, insert on public.telemetry_salts to musebook_worker;
-- The on-conflict-do-update read path and the rotate delete both need these.
grant update, delete on public.telemetry_salts to musebook_worker;
create policy telemetry_salts_worker_all on public.telemetry_salts
  for all to musebook_worker using (true) with check (true);
-- Same capability under the jobs plane for rotate via app.enter.
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
