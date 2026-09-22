-- (a) RLS is ENABLED on every table in public.
do $$
declare v_missing text;
begin
  select string_agg(c.relname, ', ' order by c.relname) into v_missing
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relkind in ('r', 'p')          -- ordinary + partitioned tables
     and c.relispartition = false
     and c.relrowsecurity = false;
  if v_missing is not null then
    raise exception 'RLS is not enabled on: %', v_missing;
  end if;
end;
$$;

-- (b) RLS is FORCED on every table in public. Without this, the `postgres` owner is
--     exempt from its own policies and (a) above is decorative.
do $$
declare v_unforced text;
begin
  select string_agg(c.relname, ', ' order by c.relname) into v_unforced
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relkind in ('r', 'p')
     and c.relispartition = false
     and c.relforcerowsecurity = false;
  if v_unforced is not null then
    raise exception 'FORCE ROW LEVEL SECURITY missing on: %', v_unforced;
  end if;
end;
$$;

-- (c) No Worker role may bypass RLS, and none of them owns a table.
do $$
declare v_bad text;
begin
  select string_agg(rolname, ', ') into v_bad
    from pg_roles
   where rolname in ('musebook_worker','musebook_public_reader',
                     'musebook_kernel','musebook_jobs')
     and (rolbypassrls or rolsuper);
  if v_bad is not null then
    raise exception 'Worker role(s) can bypass RLS: %', v_bad;
  end if;

  select string_agg(c.relname, ', ') into v_bad
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_roles r on r.oid = c.relowner
   where n.nspname = 'public' and c.relkind in ('r','p')
     and r.rolname like 'musebook\_%';
  if v_bad is not null then
    raise exception 'Worker role owns table(s), which re-opens the owner exemption: %', v_bad;
  end if;
end;
$$;

-- (d) musebook_worker holds NO direct table privilege. It must SET ROLE for everything.
do $$
declare v_bad text;
begin
  select string_agg(distinct table_name, ', ') into v_bad
    from information_schema.role_table_grants
   where grantee = 'musebook_worker' and table_schema = 'public';
  if v_bad is not null then
    raise exception 'musebook_worker was granted directly on: % (use a task role)', v_bad;
  end if;
end;
$$;

-- (e) The jobs plane cannot read a body, a grant, a settlement or a ledger leg.
do $$
declare v_leak text;
begin
  select string_agg(table_name, ', ') into v_leak
    from information_schema.role_table_grants
   where grantee in ('musebook_jobs','musebook_public_reader')
     and table_schema = 'public'
     and table_name in ('post_bodies','post_versions','access_grants',
                        'x402_settlements','x402_quotes','payout_ledger',
                        'users','wallets','sessions');
  if v_leak is not null then
    raise exception 'Non-kernel plane was granted on kernel-only table(s): %', v_leak;
  end if;
end;
$$;

-- (f) Nothing in public is writable by a PostgREST client, ever.
do $$
declare v_bad text;
begin
  select string_agg(distinct p.tablename, ', ') into v_bad
    from pg_policies p
   where p.schemaname = 'public'
     and p.cmd <> 'SELECT'
     and (p.roles::text[] && array['anon','authenticated']);
  if v_bad is not null then
    raise exception 'Client-writable policies found on: %', v_bad;
  end if;
end;
$$;
