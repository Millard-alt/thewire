-- =============================================================================
--  THE WIRE - EMERGENCY ACCOUNT RESET
-- =============================================================================
--  sign in to approve or manage staff. This wipes every login so the very
--  next signup re-claims the Owner role.
--
--  WHAT IT DELETES
--      staff_accounts  - every login (usernames, password hashes, roles)
--      wire_sessions   - every active session, so no stale browser stays
--                         signed in (cascades automatically, listed for
--                         clarity)
--
--  WHAT IT LEAVES ALONE
--      articles, assignments, staff roster, top_performers, media_assets,
--      broadcasts, audit_logs, site_settings and every uploaded image.
--      Your published content and branding are NOT touched.
--
--  HOW TO RUN
--      Supabase dashboard -> SQL Editor -> New query -> paste -> Run.
--      It is safe to run more than once.
--
--  AFTER RUNNING
--      1. Sign out in every browser tab that has the site open (the session
--         rows are gone, so those tabs will be rejected on their next action).
--      2. Go to the site, choose "Create account", and the FIRST signup
--         becomes Owner automatically and needs no approval.
--      3. Every signup after that waits in the approval queue as normal.
-- =============================================================================

begin;

-- Report what is about to be removed, so the result is visible in the
-- SQL Editor output rather than being a silent no-op.
do $$
declare
  account_count integer;
  session_count integer;
begin
  select count(*) into account_count from public.staff_accounts;
  select count(*) into session_count from public.wire_sessions;
  raise notice 'Removing % account(s) and % session(s).', account_count, session_count;
end
$$;

-- Sessions first. `on delete cascade` would handle this too, but being
-- explicit means the script behaves the same if that clause is ever changed.
delete from public.wire_sessions;

delete from public.staff_accounts;

-- Prove the reset worked and that the first-run owner claim is available again.
do $$
declare
  remaining integer;
begin
  select count(*) into remaining from public.staff_accounts;
  if remaining <> 0 then
    raise exception 'Reset incomplete: % account(s) still present.', remaining;
  end if;
  raise notice 'Reset complete. The next signup will become Owner.';
end
$$;

commit;
