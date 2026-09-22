-- scripts/sql/assert-no-anon-exposure.sql
do $$
declare v text;
begin
  -- (1) No SECURITY DEFINER function in public|app is executable by anon.
  select string_agg(p.proname, ', ') into v
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public','app') and p.prosecdef
     and has_function_privilege('anon', p.oid, 'execute');
  if v is not null then
    raise exception 'anon can execute SECURITY DEFINER functions: %', v;
  end if;

  -- (2) No table in public grants INSERT/UPDATE/DELETE to anon or authenticated.
  --     Extension-owned objects are excluded: their grants are platform-managed
  --     and cannot be revoked (pgTAP's tap_funky, Supabase helper views).
  select string_agg(distinct format('%s:%s', g.table_name, g.privilege_type), ', ') into v
    from information_schema.role_table_grants g
   where g.table_schema = 'public'
     and g.grantee in ('anon','authenticated')
     and g.privilege_type in ('INSERT','UPDATE','DELETE')
     and not exists (
       select 1
         from pg_depend d
         join pg_extension e on e.oid = d.refobjid
         join pg_class c on c.oid = d.objid
        where d.classid = 'pg_class'::regclass
          and d.refclassid = 'pg_extension'::regclass
          and c.relname = g.table_name
          and c.relnamespace = 'public'::regnamespace);
  if v is not null then
    raise exception 'client write grants found: %', v;
  end if;

  -- (3) T18, continuously. Section 4.14 asserts this at migration time; a later
  --     migration can undo it, and nothing else in the system would notice.
  select string_agg(rolname, ', ') into v
    from pg_roles
   where rolname in ('musebook_worker','musebook_public_reader',
                     'musebook_kernel','musebook_jobs')
     and (rolbypassrls or rolsuper);
  if v is not null then
    raise exception 'a Worker role can bypass RLS: %', v;
  end if;

  select string_agg(c.relname, ', ' order by c.relname) into v
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind in ('r','p')
     and c.relispartition = false and c.relforcerowsecurity = false;
  if v is not null then
    raise exception 'FORCE ROW LEVEL SECURITY missing on: %', v;
  end if;
end $$;
