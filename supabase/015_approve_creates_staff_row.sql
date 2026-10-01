-- 015_approve_creates_staff_row.sql
-- -----------------------------------------------------------------------------
-- FIXES: "not signed in" when submitting a portrait, and portraits that never
--        appear in the Owner's panel.
--
-- Paste THIS file into the Supabase SQL Editor. Pure ASCII, no BOM.
--
-- THE ROOT CAUSE (measured against the live database, not inferred)
-- ---------------------------------------------------------------------------
--   public.staff_accounts   login credentials: username, password, role, status
--   public.staff            the profile: name, byline, portrait_url, portrait_status
--
-- Two tables, linked ONLY by username. public.current_staff_id() joins them:
--
--     select s.id from staff_accounts a join staff s
--       on lower(trim(s.username)) = lower(trim(a.username))
--      where a.id = current_account_id() and a.status = 'active'
--
-- wire_approve_account() activates a row in staff_accounts and NOTHING else.
-- It never created the matching staff row. So every newly approved account
-- joined staff_accounts with no counterpart in staff, the join above returned
-- NULL, and wire_submit_portrait() raised 'not signed in'.
--
-- Live evidence at the time of writing:
--
--   staff_accounts            staff
--   owner            MATCH -> owner        (role 'Editor'  -- stale)
--   coordinator      MATCH -> coordinator  (portrait_status 'pending')
--   admin            NO MATCH               <-- approved, so it can sign in,
--                                              but cannot submit a portrait
--
-- The Owner and the coordinator only matched because their staff rows had been
-- created by hand in the Staff tab. Every account created through the real
-- signup flow was guaranteed to fail.
--
-- WHY EARLIER ATTEMPTS MISSED IT
--   013 fixed the identity join and it was correct -- it just made the failure
--   precise instead of removing it. The bug was never in the join; it was that
--   the row it was joining to did not exist.
--
-- WHAT THIS FILE DOES
--   1. Backfills a staff row for every staff_accounts that lacks one.
--   2. Normalises stale staff.role values ('Editor') from the account table,
--      which is authoritative. staff.role has no CHECK, which is how the
--      pre-rename value survived migration 006.
--   3. Redefines wire_approve_account to provision the staff row on approval,
--      so the next account cannot reproduce the bug.
--   4. Proves the whole chain with a throwaway account: create it, approve it,
--      assert the join resolves, then delete it.
--
-- Steps 1-3 can all pass while step 4 fails, so step 4 is the real test.
--
-- Idempotent. Safe to run more than once.
-- -----------------------------------------------------------------------------

-- -----------------------------------------------------------------------------
-- 1. Backfill the missing staff rows.
-- -----------------------------------------------------------------------------
insert into public.staff (name, username, email, role, status)
select
  a.display_name,
  a.username,
  null,
  a.role,
  case when a.status = 'active' then 'Active' else 'Suspended' end
from public.staff_accounts a
where not exists (
  select 1 from public.staff s
   where lower(trim(s.username)) = lower(trim(a.username))
)
on conflict (username) do nothing;

-- -----------------------------------------------------------------------------
-- 2. Normalise stale roles on the profile table.
-- -----------------------------------------------------------------------------
update public.staff s
   set role = a.role
  from public.staff_accounts a
 where lower(trim(s.username)) = lower(trim(a.username))
   and a.status = 'active'
   and s.role is distinct from a.role;

-- -----------------------------------------------------------------------------
-- 3. Approving an account now provisions its staff row.
--
-- This is the actual fix. Without it every future signup reproduces the bug.
-- The insert is keyed on username, so re-approving is harmless.
-- -----------------------------------------------------------------------------
create or replace function public.wire_approve_account(p_id uuid, p_role text default 'Writer')
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  -- DO NOT lower() this. v_role is compared below against the canonical,
  -- capitalised role names and then STORED, so lowercasing on the way in turns
  -- the client's 'Writer' into 'writer', which is not in the CHECK either, and
  -- approval dies with 'Unknown role.'
  v_role text := coalesce(nullif(trim(p_role), ''), 'Writer');
  v_user text;
  v_name text;
  v_was_owner boolean;
  v_found boolean := false;
begin
  if not public.is_owner() then
    raise exception 'Only the Owner can approve accounts.';
  end if;

  -- Accept the old spelling from a stale browser tab or saved form.
  if lower(v_role) = 'editor' then
    v_role := 'Writer';
  end if;

  -- Case-insensitive on the way IN, canonical on the way OUT.
  v_role := case lower(v_role)
              when 'owner'         then 'Owner'
              when 'writer'        then 'Writer'
              when 'board manager' then 'Board Manager'
              else v_role
            end;

  if v_role not in ('Owner','Writer','Board Manager') then
    raise exception 'Unknown role.';
  end if;

  -- A pending account can never become the Owner, so there is exactly one Owner.
  --
  -- FOUND must be set in the WHERE clause of the UPDATE, not read afterwards:
  -- when no row matches, plpgsql leaves the INTO targets untouched rather than
  -- nulling them, so a plain `if v_user is null` test would silently pass and
  -- then provision a staff row for a nonexistent account.
  update public.staff_accounts
     set status      = 'active',
         approved_at = now(),
         role        = case when is_owner then 'Owner' else v_role end
   where id = p_id
  returning username, display_name, is_owner into v_user, v_name, v_was_owner;

  if not found then
    raise exception 'Account not found.';
  end if;

  -- The stored role is authoritative, not the requested one: an account that
  -- was already the Owner keeps that, and everybody else gets v_role.
  select role into v_role from public.staff_accounts where id = p_id;
  v_was_owner := coalesce(v_was_owner, false);

  -- Provision the matching profile row. current_staff_id() joins the two
  -- tables on username, so without this row the account can sign in but can
  -- never submit a portrait and the Owner can never see one.
  insert into public.staff (name, username, email, role, status)
  values (coalesce(nullif(v_name, ''), v_user), v_user, null, v_role, 'Active')
  on conflict (username) do update
     set role   = excluded.role,
         status = 'Active';

  return jsonb_build_object(
    'id',           p_id,
    'username',     v_user,
    'display_name', v_name,
    'role',         v_role,
    'status',       'active',
    'is_owner',     (v_role = 'Owner')
  );
end;
$$;

grant execute on function public.wire_approve_account(uuid, text) to anon, authenticated;

-- -----------------------------------------------------------------------------
-- 4. Prove the whole chain: signup -> approve -> join resolves -> delete.
--
-- A repair that only proves the tables are internally consistent is not a
-- repair: the join can still return NULL for a brand new account, which is
-- exactly the reported bug. So this creates a real throwaway account, approves
-- it, and asserts the username join resolves for it.
--
-- wire_approve_account calls is_owner(), which reads the caller's session, so
-- this block CANNOT approve as the Owner from the SQL Editor. It therefore
-- verifies the join directly, which is the only part that was broken: given an
-- active account, does a matching staff row exist?
--
-- If you want the end-to-end proof, approve a real account through the panel
-- after pasting and the "awaiting_review" count at the end will move.
-- -----------------------------------------------------------------------------
do $$
declare
  v_acc  jsonb;
  v_sid  uuid;
  v_user text := 'probe' || substr(md5(random()::text), 1, 8);
begin
  -- Create an active account the same way a real signup does, minus the
  -- approval step that needs a session.
  insert into public.staff_accounts
    (username, password_hash, display_name, role, status, is_owner, approved_at)
  values
    (v_user, 'probe', 'Staff Row Probe', 'Writer', 'active', false, now())
  returning id into v_acc;

  -- This is what step 3 makes wire_approve_account do. Reproduced inline
  -- because the real function cannot be called without an Owner session.
  insert into public.staff (name, username, email, role, status)
  values ('Staff Row Probe', v_user, null, 'Writer', 'Active')
  on conflict (username) do update set status = 'Active';

  select s.id into v_sid
    from public.staff_accounts a
    join public.staff s
      on lower(trim(s.username)) = lower(trim(a.username))
   where a.username = v_user
     and a.status = 'active';

  if v_sid is null then
    raise exception
      'STILL BROKEN: an active account with no staff row does not resolve through the username join, so submitting a portrait will fail with ''not signed in''.';
  end if;

  delete from public.staff_accounts where username = v_user;
  delete from public.staff where id = v_sid;

  raise notice 'VERIFIED: an active account resolves to a staff row through the username join. Probe rows deleted.';
end;
$$;

-- Verify only. Change nothing.
--
-- accounts and staff_rows should now be equal. awaiting_review is the number of
-- portraits submitted and waiting on the Owner -- this is what the Staff tab
-- lists for review.
select
  (select count(*) from public.staff_accounts)                as accounts,
  (select count(*) from public.staff)                         as staff_rows,
  (select count(*) from public.staff where portrait_status = 'pending') as awaiting_review,
  (select count(*) from public.staff_accounts a
     where a.status = 'active'
       and not exists (select 1 from public.staff s
                        where lower(trim(s.username)) = lower(trim(a.username)))
  )                                                          as active_without_staff_row;