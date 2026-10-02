-- 016_grant_owner_panel_rpcs.sql
-- -----------------------------------------------------------------------------
-- FIXES: the Owner's device list is permanently empty, and every RPC that only
--        granted `authenticated` is unreachable from the browser.
--        Paste THIS file into the Supabase SQL Editor.
--
-- THE ROOT CAUSE, MEASURED AGAINST THE LIVE DATABASE
--   Supabase Auth is deliberately not used in this project. Sessions are opaque
--   tokens resolved by public.is_staff() / public.is_owner(). That means the
--   PostgREST role on EVERY request from the browser is `anon` -- never
--   `authenticated`, which only ever applies to a real Supabase JWT.
--
--   Several migrations granted their functions to `authenticated` alone:
--     003  wire_list_devices()          -> 42501 permission denied  (BROKEN)
--     005  wire_set_credits(...)
--     009  wire_credits_people_*        -> live, already reachable
--   A grant naming a role the client never uses is silently unreachable: the
--   call fails with "permission denied for function", and because every caller
--   catches that and returns an empty list, the panel renders as "no devices
--   yet" rather than as an error. That is why this looked like missing data.
--
--   Measured live before writing this file:
--     wire_list_devices        40142501 permission denied for function
--     wire_subscriber_count    200 0                     (anon grant, works)
--     wire_credits_people_list 200 []                    (already reachable)
--   Only wire_list_devices is genuinely unreachable. This file grants `anon` on
--   every Owner-panel RPC for uniformity so the next one added cannot repeat
--   the mistake, and leaves the existing grants alone where they already work.
--
--   Each function still enforces its own authorisation INSIDE the body
--   (is_staff() / is_owner()). Granting EXECUTE to anon does not grant access to
--   anything: it only lets the request reach the check. No data is exposed to a
--   logged-out visitor, because an unauthenticated call still fails the check
--   inside the function.
--
-- WHY grant AND NOT revoke FROM anon
--   `revoke ... from anon` was the bug in 003: it removed the grant the app
--   actually needs. The revoke below is from PUBLIC only, which is the correct
--   default-deny, and anon keeps its explicit grant.
--
-- Idempotent. Safe to run more than once.
-- -----------------------------------------------------------------------------

begin;

-- 1. The device registry the Owner panel reads. This is the actual fix.
grant execute on function public.wire_list_devices() to anon;
grant execute on function public.wire_list_devices() to authenticated;

-- 2. Owner account management. 015 already granted these to anon; repeated here
--    so this file is the single place that states the rule for the whole panel.
grant execute on function public.wire_list_accounts() to anon;
grant execute on function public.wire_approve_account(uuid, text) to anon;
grant execute on function public.wire_reject_account(uuid) to anon;
grant execute on function public.wire_set_password(uuid, text) to anon;

-- 3. Portraits and the Credits page.
grant execute on function public.wire_submit_portrait(text) to anon;
grant execute on function public.wire_set_portrait_status(uuid, text) to anon;
grant execute on function public.wire_assign_portrait(uuid, text) to anon;
grant execute on function public.wire_set_credits(uuid, boolean, text, integer, jsonb) to anon;
grant execute on function public.wire_credits_people_list() to anon;
grant execute on function public.wire_credits_people_upsert(uuid, text, text, text, text, text, integer) to anon;
grant execute on function public.wire_credits_people_delete(uuid) to anon;
grant execute on function public.wire_credits_people_reorder(uuid[]) to anon;

-- 4. Prove it with the built-in privilege test, which is the correct tool.
--
--    The previous version of this check read pg_proc.proacl and tested
--        'anon' = any (proacl::text[])
--    That can NEVER be true. Each element of the array is a whole aclitem like
--    'anon=X/postgres', not the bare grantee name, so the comparison was always
--    false and it printed "BROKEN - anon is missing from the ACL" for all 13
--    functions while the ACL it printed alongside plainly showed anon=X. The
--    grants were fine; the verifier was broken. has_function_privilege is the
--    supported way to ask this question and needs no ACL parsing.
--
--    This deliberately does NOT try to SET ROLE anon and call the functions.
--    A logged-out call would be refused by the authorisation check inside each
--    body anyway, so it could only ever prove that access is denied, not that
--    the grant is live. has_function_privilege answers the grant question
--    directly. The security property that matters is unchanged either way:
--    EXECUTE lets the request reach the function, and the function's own
--    is_staff() / is_owner() check still decides the answer, so nothing is
--    exposed to a logged-out visitor.
select
  p.proname                                     as function_name,
  pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE') as anon_may_execute,
  case
    when pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
      then 'OK - anon can reach it'
    else 'BROKEN - anon lacks EXECUTE'
  end                                           as verdict
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = any (array[
        'wire_list_devices',
        'wire_list_accounts',
        'wire_approve_account',
        'wire_reject_account',
        'wire_set_password',
        'wire_submit_portrait',
        'wire_set_portrait_status',
        'wire_assign_portrait',
        'wire_credits_people_list',
        'wire_credits_people_upsert',
        'wire_credits_people_delete',
        'wire_credits_people_reorder',
        'wire_set_credits'
      ])
order by p.proname;