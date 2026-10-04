--  =============================================================================
--  READ-ONLY CHECK for supabase/018_portrait_reset.sql.
--  Paste this into Supabase -> SQL Editor AFTER pasting 018.
--
--  This file contains NO DDL and NO DML. It only SELECTs. It is safe to run
--  against the live database any number of times and cannot change a row.
--  Look at the result grid, not at the editor.
--  =============================================================================
--  Expected: one row.
--
--    function_exists | security_definer | anon_may_execute
--         t                 t                 t
--
--  NOTE: this cannot prove the is_owner() check is *inside* the function. Read
--  pg_get_functiondef() below if you want that confirmed by eye. What it proves
--  is that the function exists under the exact name/signature the client calls,
--  that it is SECURITY DEFINER (so it can write staff under RLS), and that the
--  browser is actually allowed to reach it.
--
--  If anon_may_execute is f, the browser gets "permission denied for function"
--  before the is_owner() gate is ever reached, and the Owner's Reset button
--  fails no matter who is signed in.
--  =============================================================================
with f as (
  select p.oid,
         p.prosecdef,
         has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'wire_reset_portrait'
     and pg_get_function_identity_arguments(p.oid) = 'p_staff_id uuid'
)
select
  count(*) > 0                                     as function_exists,
  coalesce(bool_and(p.prosecdef), false)            as security_definer,
  coalesce(bool_and(f.anon_exec), false)            as anon_may_execute
  from f;
--  =============================================================================
--  If function_exists is f, f was empty. To see what is actually deployed:
--  =============================================================================
--  select p.proname,
--         pg_get_function_identity_arguments(p.oid) as args
--    from pg_proc p
--    join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public'
--     and p.proname like '%portrait%'
--   order by p.proname;
--  =============================================================================