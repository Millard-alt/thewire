-- 006_roles_and_privileges.sql
-- -----------------------------------------------------------------------------
--  Collapse the role model to exactly three roles and make the database agree
--  with src/lib/auth.js (ROLES) and src/views/admin.js (ACCOUNT_ROLES).
--
--  THE BUG THIS FIXES
--  src/lib/auth.js:118 had been granting `isAdmin: true` to every signed-in
--  account, so an Editor signing in landed on the Owner's Control Center with
--  the Accounts tab, broadcasts and branding all live. Anyone the Owner had
--  approved could effectively be the Owner. That is fixed in auth.js; this
--  migration fixes the server half so the role is real rather than cosmetic.
--
--  'Reporter' never existed in the product. It was an artefact of a guess in an
--  early draft of wire_default_permissions(). It is folded into 'Editor', which
--  is the weakest role, so nobody loses access.
--
--  Idempotent. Safe to run more than once.
-- -----------------------------------------------------------------------------

-- 1. Fold any legacy 'Reporter' row down to 'Editor' FIRST.
--    This has to happen before the new CHECK is attached, otherwise a database
--    that still holds a 'Reporter' row fails the ALTER and the migration stops
--    half-applied with the old constraint already dropped.
update public.staff_accounts set role = 'Editor' where role = 'Reporter';

-- 2. Relax the CHECK so 'Board Manager' is storable and 'Reporter' is not.
--    The constraint is dropped and re-added rather than ALTERed, because the
--    set of accepted values changes and there is no portable syntax for that
--    across every Postgres version.
do $$
begin
  if exists (
    select 1 from pg_constraint where conname = 'staff_accounts_role_check'
  ) then
    alter table public.staff_accounts drop constraint staff_accounts_role_check;
  end if;
end
$$;

alter table public.staff_accounts
  add constraint staff_accounts_role_check
  check (role in ('Owner','Board Manager','Editor'));

-- 3. Re-state the capability map so the three real roles are the only ones
--    that resolve to anything. Mirrors ROLE_CAPABILITIES in admin.js.
--    NOTE: the enum of staff *job titles* (seed.js `reporter`, the
--    assignments.reporter column) is a different concept and is untouched here.
create or replace function public.wire_default_permissions(p_role text)
returns jsonb
language sql
immutable
as $$
  select case p_role
    when 'Owner' then '{"publish":true,"edit_others":true,"broadcast":true,"media":true,"manage_staff":true,"approve_portraits":true,"edit_credits":true}'::jsonb
    when 'Board Manager' then '{"publish":true,"edit_others":true,"broadcast":true,"media":true,"manage_staff":false,"approve_portraits":true,"edit_credits":true}'::jsonb
    when 'Editor' then '{"publish":true,"edit_others":false,"broadcast":false,"media":true,"manage_staff":false,"approve_portraits":false,"edit_credits":false}'::jsonb
    else '{"publish":false,"edit_others":false,"broadcast":false,"media":false,"manage_staff":false,"approve_portraits":false,"edit_credits":false}'::jsonb
  end;
$$;

-- 4. Teach the approval RPC the new role list, so approving somebody as
--    "Board Manager" is accepted instead of raising 'Unknown role.'
create or replace function public.wire_approve_account(p_id uuid, p_role text default 'Editor')
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_role text := coalesce(nullif(trim(p_role), ''), 'Editor');
  v_out  jsonb;
begin
  if not public.is_owner() then
    raise exception 'Only the Owner can approve accounts.';
  end if;

  if v_role not in ('Owner','Editor','Board Manager') then
    raise exception 'Unknown role.';
  end if;

  -- A pending account can never become the Owner: there is exactly one seat.
  update public.staff_accounts
     set status      = 'active',
         approved_at = now(),
         role        = case when is_owner then 'Owner' else v_role end
   where id = p_id
  returning jsonb_build_object('id', id, 'username', username, 'role', role, 'status', status)
    into v_out;

  if v_out is null then
    raise exception 'No such account.';
  end if;

  return v_out;
end;
$$;
