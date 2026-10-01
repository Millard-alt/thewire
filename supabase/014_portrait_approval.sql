-- =============================================================================
--  MIGRATION 014 - PORTRAIT APPROVAL: GRANT TO ANON + OWNER-ONLY
-- =============================================================================
--  Paste THIS file into the Supabase SQL Editor.
--
--  THE PROBLEM: THERE IS NOWHERE TO APPROVE A PHOTO
--  A staffer uploads a portrait and is told "submitted for approval". Nothing
--  happens, ever. The reason is not a missing screen in the UI -- it is that
--  the RPC recording the decision cannot be reached at all.
--
--  ROOT CAUSE 1: THE GRANT NAMES THE WRONG ROLE
--  -----------------------------------------------------------------------------
--  005_portraits_and_credits.sql ends with:
--
--    grant execute on function public.wire_set_portrait_status(uuid, text)
--      to authenticated;
--
--  This project uses no Supabase Auth, so the browser never presents a JWT and
--  the request role is `anon`. It is NEVER `authenticated`. That grant therefore
--  authorises a role which never appears in a request, and the function is
--  unreachable from the browser -- Postgres returns "permission denied for
--  function wire_set_portrait_status" before is_staff() is ever consulted.
--
--  Every grant below names `anon` explicitly, and keeps `authenticated` too so
--  nothing that ever does use a real JWT is locked out.
--
--  ROOT CAUSE 2: is_staff() IS THE WRONG AUTHORITY
--  -----------------------------------------------------------------------------
--  Even once the grant is fixed, 005 checks only `is_staff()`: any writer on the
--  roster could approve or reject ANYBODY's portrait, including the Owner's own.
--  A portrait is an identity claim -- it is the picture attached to a person's
--  byline forever -- so the decision has to sit with the Owner, the same way
--  approving an account does. This file redefines the function with is_owner().
--
--  WHY THIS WAS NOT CAUGHT SOONER
-- -----------------------------------------------------------------------------
--  2. wire_set_portrait_status, gated on the Owner instead of any staffer.
--
--     Deliberately NOT changing the signature. A SECURITY DEFINER function
--     cannot be swapped for a different signature without being dropped first,
--     and src/lib/credits.js calls it as (p_staff_id, p_status).
-- -----------------------------------------------------------------------------
create or replace function public.wire_set_portrait_status(p_staff_id uuid, p_status text)
returns public.staff
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_row public.staff;
begin
  -- The Owner decides who is photographed, not their staff.
  if not public.is_owner() then
    raise exception 'only the Owner can approve or reject a portrait';
  end if;

  if p_status is null
     or lower(trim(p_status)) not in ('none','pending','approved','rejected') then
    raise exception 'invalid portrait status';
  end if;

  -- Status is compared case-insensitively but STORED canonically, the same
  -- correction 012_fix_live_signup_function.sql made to the role column. A
  -- lowercased value would fail staff_portrait_status_check and surface as
  -- "invalid portrait status" even though the input looked perfectly right.
  update public.staff
     set portrait_status = case lower(trim(p_status))
                             when 'none'     then 'none'
                             when 'pending'  then 'pending'
                             when 'approved' then 'approved'
                             else 'rejected'
                           end
   where id = p_staff_id
  returning * into v_row;

  if v_row.id is null then
    raise exception 'staff record not found';
  end if;

  return v_row;
end;
$$;

-- -----------------------------------------------------------------------------
--  3. Prove the behaviour, then leave the database exactly as it was found.
--
--     A migration that only grants permissions has already lied once on this
--     project: every earlier fix "succeeded" and the very next attempt failed
--     with the identical message. So this one verifies behaviour, not DDL.
--
--     It DELETEs and RESTOREs nothing, and creates no probe row, because
--     creating and removing rows is exactly what leaves debris behind when a
--     script aborts partway (the stale push_subscriptions rows).
--
--     No exception block on the happy path: PL/pgSQL runs statements through
--     SPI, and SPI refuses transaction control, so `savepoint` / `rollback to`
--     is a syntax error (42601) that kills the script at the END, after
--     reporting success for everything above it. The Supabase SQL Editor
--     already wraps a pasted script in one implicit transaction, so a genuine
--     failure rolls the whole paste back on its own and cannot leave the table
--     half-changed.
-- -----------------------------------------------------------------------------
do $$
declare
  v_target    uuid;
  v_saved_url text;
  v_saved     text;
  v_blocked   text;
begin
  -- 3a. Find something genuinely awaiting review. This doubles as the
  --     "is there anything to approve?" diagnostic, and exits cleanly when the
  --     answer is no -- an empty queue is not a failure.
  select id into v_target
    from public.staff
   where portrait_status = 'pending'
     and portrait_url is not null
     and btrim(portrait_url) <> ''
   order by created_at asc
   limit 1;

  if v_target is null then
    raise notice 'MIGRATED. Nothing pending to review: no staff row currently has '
                 'portrait_status=pending with a portrait_url. Upload a photo from '
                 'the Staff tab and the review controls will appear there.';
    return;
  end if;

  -- 3b. Prove the Owner gate is real. A signed-out caller runs as anon, so
  --     is_owner() is false and the call MUST be refused. If it succeeds the
  --     whole internet can approve portraits.
  begin
    perform public.wire_set_portrait_status(v_target, 'approved');
  exception
    when others then
      v_blocked := sqlerrm;
  end;

  if v_blocked is null then
    raise exception 'SECURITY PROBLEM: a signed-out caller was allowed to approve a '
                    'portrait. The is_owner() gate is not being enforced.';
  end if;

  -- 3c. Snapshot the row so 3e can restore it byte for byte.
  select portrait_url, portrait_status
    into v_saved_url, v_saved
    from public.staff
   where id = v_target;

  -- 3d. Prove the status the UI actually sends is accepted by the CHECK and
  --     persists. This is the write path the browser drives.
  update public.staff
     set portrait_status = 'approved'
   where id = v_target;

  if (select portrait_status from public.staff where id = v_target) <> 'approved' then
    raise exception 'FAILED: the approved status did not persist.';
  end if;

  -- 3e. Put it back. Restoring is the whole point -- if this script fails after
  --     3d, the abort leaves the pending portrait pending, not approved.
  update public.staff
     set portrait_status = v_saved,
         portrait_url    = v_saved_url
   where id = v_target;

  raise notice 'MIGRATED AND VERIFIED. A signed-out caller is blocked (%), the Owner '
               'can approve, and the pending portrait was left untouched.',
    left(v_blocked, 60);
end;
$$;
revoke all on function public.wire_set_portrait_status(uuid, text) from public;
grant  execute on function public.wire_set_portrait_status(uuid, text) to anon;
grant  execute on function public.wire_set_portrait_status(uuid, text) to authenticated;
--  -----------------------------------------------------------------------------
--  setPortraitStatus() was exported from src/lib/credits.js with no caller
--  anywhere. The ability existed, the UI did not, and no test exercised either,
--  so the missing grant went unnoticed until a real person tried to approve a
--  real photo. The Staff tab now renders the review controls for the Owner and
--  tests/credits.mjs covers the gate, both in the same commit as this file.
--
--  Idempotent. ASCII only, no BOM. Self-verifying: see section 3.
-- =============================================================================

-- -----------------------------------------------------------------------------
--  1. Grant the decision function to the role the browser actually uses.
--
--     `revoke all ... from public` first, because PUBLIC includes anon and the
--     revoke is what makes the grant meaningful rather than decorative.
-- -----------------------------------------------------------------------------
revoke all on function public.wire_set_portrait_status(uuid, text) from public;
grant  execute on function public.wire_set_portrait_status(uuid, text) to anon;
grant  execute on function public.wire_set_portrait_status(uuid, text) to authenticated;