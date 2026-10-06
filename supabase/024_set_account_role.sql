-- =============================================================================
--  supabase/024_set_account_role.sql
--  -----------------------------------------------------------------------------
--  Editing an APPROVED account's role must not re-run approval.
--
--  THE BUG
--  -------
--  The Accounts tab has two controls that both change a role:
--
--    • "Approve" on a PENDING row       -> wire_approve_account()  (correct)
--    • the role <select> on an APPROVED  -> was ALSO wire_approve_account()
--      row
--
--  The second one has no other route to the database, so the client reused the
--  approval function. That function is not a setter, it is a pipeline:
--
--    set status      = 'active',        -- (a)
--    set approved_at = now(),           -- (b)
--    insert into staff (...) on conflict (username) do update
--         set status = 'Active'         -- (c)
--
--  So promoting an existing Board Manager to Writer silently re-activated any
--  account the Owner had suspended and restamped their approval date -- the
--  account "approved itself" out of a state nobody asked it to leave. (c) is the
--  same story one table over: a staffer the Owner had set to 'Suspended' in the
--  Staff tab snapped back to 'Active' the moment their role was edited.
--
--  A role edit is an edit. It has to write the role and nothing else.
--
--  THE FIX
--  -------
--  wire_set_account_role() writes `role` on staff_accounts, and mirrors that one
--  column onto the matching staff row. It never touches status, approved_at, or
--  is_owner, so no edit can promote, suspend, re-approve or re-provision an
--  account behind the Owner's back.
--
--  The normalisation below is copied from wire_approve_account() verbatim, on
--  purpose: it is the same vocabulary problem, and the two functions must accept
--  exactly the same spellings or a role that approves cleanly will fail to save.
--  In particular DO NOT lower() p_role -- that was a shipped bug (see
--  012_fix_live_signup_function.sql) and it raises 'Unknown role.' for 'Writer'.
--
--  Run in the Supabase SQL Editor, then reload the schema cache.
-- =============================================================================

create or replace function public.wire_set_account_role(p_id uuid, p_role text default 'Writer')
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  -- DO NOT lower() this; the canonical names are capitalised and this is the
  -- value that gets stored.
  v_role   text := coalesce(nullif(trim(p_role), ''), 'Writer');
  v_user   text;
  v_stored text;
  v_status text;
begin
  if not public.is_owner() then
    raise exception 'Only the Owner can change roles.';
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

  -- There is exactly one Owner seat, and moving it is a separate deliberate act
  -- (see supabase/000_who_holds_owner.sql). This function is the "edit a role"
  -- path, so it refuses the Owner row outright rather than half-transferring it.
  if exists (select 1 from public.staff_accounts where id = p_id and is_owner) then
    raise exception 'The Owner role cannot be changed here.';
  end if;

  -- FOUND must be tested on the UPDATE itself: plpgsql leaves the INTO targets
  -- untouched when nothing matched, so a null test afterwards would pass and
  -- then mirror a role onto nobody.
  --
  -- `role` is the ONLY column in this statement. status, approved_at and
  -- is_owner are deliberately absent -- that omission IS the fix.
  update public.staff_accounts
     set role = v_role
   where id = p_id
  returning username, role, status into v_user, v_stored, v_status;

  if not found then
    raise exception 'Account not found.';
  end if;

  -- Keep the newsroom profile row in step: the roster in the Staff tab reads
  -- staff.role, and current_staff_id() joins the two tables on username. Role
  -- only -- never staff.status, which the Staff tab owns.
  update public.staff
     set role = v_stored
   where username = v_user;

  return jsonb_build_object(
    'id',           p_id,
    'username',     v_user,
    'role',         v_stored,
    -- Returned so the client can assert the edit did not change it.
    'status',       v_status,
    'approved_at',  (select approved_at from public.staff_accounts where id = p_id)
  );
end;
$$;

revoke all on function public.wire_set_account_role(uuid, text) from public;
grant  execute on function public.wire_set_account_role(uuid, text) to anon, authenticated;

-- -----------------------------------------------------------------------------
-- Verify only. Reports the live state and changes nothing.
--
-- Every row below should keep its status and approval date across a role edit;
-- if one of these is 'pending' with a null approved_at while the Owner believes
-- it was approved, a role edit somewhere is still running the approval pipeline.
-- -----------------------------------------------------------------------------
select username,
       role,
       status,
       approved_at,
       (select s.role from public.staff s where s.username = a.username) as staff_role,
       (select s.status from public.staff s where s.username = a.username) as staff_status
  from public.staff_accounts a
 order by (a.status <> 'pending') desc, a.created_at asc;
