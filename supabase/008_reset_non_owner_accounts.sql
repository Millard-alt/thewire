-- =============================================================================
--  THE WIRE - ACCOUNT RESET, KEEPING THE OWNER
-- =============================================================================
--  Run this when test accounts have piled up and every browser is signed in as
--  somebody. Unlike 000_reset_accounts.sql, this KEEPS the Owner seat, so the
--  Owner does not have to sign up again and the site is never ownerless.
--
--  WHAT IT DELETES
--      staff_accounts  - every account that is not the Owner
--      wire_sessions   - every session, INCLUDING the Owner's, so every browser
--                         is logged out. The Owner signs back in with the same
--                         password; nobody else can sign in at all.
--
--  WHAT IT LEAVES ALONE
--      the Owner account row, and every published article, assignment, staff
--      roster entry, media asset, broadcast and audit log.
--
--  RELATED
--      Articles authored by a deleted account keep their text but lose their
--      author_account_id (ON DELETE SET NULL, see 007_article_ownership.sql).
--      That makes them Owner-only for deletion, which is deliberate: nobody can
--      prove they own a story whose writer no longer exists.
--
--  HOW TO RUN
--      Supabase dashboard -> SQL Editor -> New query -> paste -> Run.
--      It is safe to run more than once. Running it twice removes nothing the
--      second time.
--
--  AFTER RUNNING
--      Sign in again as the Owner. Every other login is now unknown.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
--  Step 1: prove there IS an Owner before deleting anything.
--
--  This is the guard that makes the script safe to run blindly. If no Owner row
--  exists there is nothing to keep, and deleting every account would leave the
--  site with no way back in short of using 000_reset_accounts.sql. The exception
--  aborts the transaction, so nothing is removed.
-- -----------------------------------------------------------------------------
do $$
declare
  v_owner_count integer;
begin
  select count(*) into v_owner_count
    from public.staff_accounts
   where is_owner or lower(coalesce(role, '')) = 'owner';

  if v_owner_count = 0 then
    raise exception
      'No Owner account found. Refusing to delete every account. Run '
      'supabase/000_reset_accounts.sql instead, then sign up again to claim the Owner seat.';
  end if;

  raise notice 'Found % Owner account(s); they will be kept.', v_owner_count;
end
$$;

-- -----------------------------------------------------------------------------
--  Step 2: report what is about to go, so the SQL Editor output shows the work
--  rather than the run being a silent no-op.
-- -----------------------------------------------------------------------------
do $$
declare
  v_to_delete integer;
  v_to_keep   integer;
  v_sessions  integer;
begin
  select count(*) into v_to_delete
    from public.staff_accounts
   where not (is_owner or lower(coalesce(role, '')) = 'owner');

  select count(*) into v_to_keep from public.staff_accounts
   where is_owner or lower(coalesce(role, '')) = 'owner';

  select count(*) into v_sessions from public.wire_sessions;

  raise notice 'Will delete % non-owner account(s), keep % owner account(s), and clear % session(s).',
    v_to_delete, v_to_keep, v_sessions;
end
$$;

-- -----------------------------------------------------------------------------
--  Step 3: remove every non-owner account.
--
--  `not (is_owner or lower(role) = 'owner')` rather than `is_owner = false`:
--  an account provisioned before the is_owner column existed has NULL there,
--  and `is_owner = false` does not match a NULL row, silently keeping a test
--  account. Negating the whole expression treats NULL as "not the Owner".
-- -----------------------------------------------------------------------------
delete from public.staff_accounts
 where not (is_owner or lower(coalesce(role, '')) = 'owner');

-- -----------------------------------------------------------------------------
--  Step 4: log everyone out, the Owner included.
--
--  Sessions are removed unconditionally rather than only for the deleted
--  accounts, because a session row can outlive its account (an account removed
--  by hand, a browser that never re-checked). Leaving one behind would mean a
--  signed-in browser the database no longer recognises.
-- -----------------------------------------------------------------------------
delete from public.wire_sessions;

-- -----------------------------------------------------------------------------
--  Step 5: assert that it did what it claimed.
--
--  Every claim made in the notices above is re-checked here. If any is false the
--  exception rolls the whole transaction back, so the script either fully
--  succeeds or leaves the database exactly as it found it.
-- -----------------------------------------------------------------------------
do $$
declare
  v_remaining_non_owner integer;
  v_remaining_owner    integer;
  v_remaining_sessions integer;
begin
  select count(*) into v_remaining_non_owner
    from public.staff_accounts
   where not (is_owner or lower(coalesce(role, '')) = 'owner');

  select count(*) into v_remaining_owner
    from public.staff_accounts
   where is_owner or lower(coalesce(role, '')) = 'owner';

  select count(*) into v_remaining_sessions from public.wire_sessions;

  if v_remaining_non_owner <> 0 then
    raise exception 'Reset incomplete: % non-owner account(s) still present.',
      v_remaining_non_owner;
  end if;

  if v_remaining_owner <> 1 then
    raise exception 'Reset left % owner account(s); expected exactly 1.',
      v_remaining_owner;
  end if;

  if v_remaining_sessions <> 0 then
    raise exception 'Reset incomplete: % session(s) still present.',
      v_remaining_sessions;
  end if;

  raise notice
    'Reset complete. Kept 1 Owner account, removed every other account and all sessions. Sign in again as the Owner.';
end
$$;

commit;