-- =============================================================================
--  MIGRATION 018 - OWNER PORTRAIT RESET
-- =============================================================================
--  Paste THIS file into the Supabase SQL Editor.
--
--  WHAT IT DOES
--  Adds wire_reset_portrait(uuid), which clears a staffer's portrait entirely:
--  the stored URL is emptied and the status returns to 'none', the state a new
--  hire starts in. Their bylines fall back to initials and the Owner sees no
--  photo to review, so the next upload is a clean resubmission rather than an
--  edit of something already public.
--
--  WHY NOT REUSE wire_assign_portrait
--  -----------------------------------------------------------------------------
--  It looks like it does exactly this: passing an empty string sets
--  portrait_url = '' and portrait_status = 'none'. It is still wrong here, for
--  two independent reasons.
--
--  1. IT IS GATED ON is_staff(), NOT is_owner().
--     005_portraits_and_credits.sql checks only that the caller is on the
--     roster. Every writer qualifies. Attaching a portrait to someone is
--     already far too much power for that, but CLEARING one is destructive and
--     irreversible -- there is no trash. A writer who disliked a colleague's
--     photo could wipe it. Approval already moved to is_owner() in
--     014_portrait_approval.sql; reset has to sit in the same place.
--
--  2. IT IS NOT GRANTED TO anon.
--     005 grants it to `authenticated`. This project uses no Supabase Auth, so
--     the browser never presents a JWT and the request role is always `anon`.
--     The grant authorises a role that never appears in a request, which is the
--     exact defect 014 documented and fixed for the approval path. Calling this
--     from the browser would fail with "permission denied for function" before
--     any check inside the body ran.
--
--  THE NEW FUNCTION
--  SECURITY DEFINER so it can write `staff` under RLS, is_owner() gated so only
--  the Owner may call it, granted to anon so the browser can actually reach it.
--  Signature is new, so nothing existing is redefined and 014 stays untouched.
--
--  Deliberately does NOT touch the storage bucket. The uploaded file is left
--  where it is: deleting from Storage needs a second grant, and an orphaned
--  object costs nothing while a botched delete would cost the Owner a portrait
--  they had already approved. Reclaiming storage is a separate, deliberate
--  operation.
--
--  Also does NOT touch credits_people. That table is a separate, hand-curated
--  roster the Owner builds for the public Credits page, and a photo there is a
--  publishing decision rather than an identity claim. Resetting a staffer's
--  workspace portrait must not silently strip somebody from the Credits page.
--  -----------------------------------------------------------------------------
create or replace function public.wire_reset_portrait(p_staff_id uuid)
returns public.staff
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_row public.staff;
begin
  -- The Owner decides who is photographed. Not their staff.
  if not public.is_owner() then
    raise exception 'only the Owner can reset a portrait';
  end if;

  if p_staff_id is null then
    raise exception 'invalid staff id';
  end if;

  -- SELECT ... INTO leaves the variable UNSET when no row matches, so a missing
  -- staff row would fall through a null check unnoticed. Assert the row
  -- resolved with a count instead, then read it.
  if (select count(*) from public.staff where id = p_staff_id) = 0 then
    raise exception 'staff record not found';
  end if;

  update public.staff
     set portrait_url    = '',
         portrait_status = 'none',
         updated_at      = now()
   where id = p_staff_id
  returning * into v_row;

  return v_row;
end;
$$;

-- -----------------------------------------------------------------------------
--  Grants. `revoke ... from public` first, because PUBLIC includes anon and the
--  revoke is what makes the grant meaningful rather than decorative.
-- -----------------------------------------------------------------------------
revoke all on function public.wire_reset_portrait(uuid) from public;
grant  execute on function public.wire_reset_portrait(uuid) to anon;
grant  execute on function public.wire_reset_portrait(uuid) to authenticated;
--  -----------------------------------------------------------------------------
--  PROVE IT, THEN LEAVE THE DATABASE EXACTLY AS IT WAS FOUND.
--
--  A migration that only declares a function proves nothing. This block proves
--  the Owner gate is real, that the status and URL both actually clear, and it
--  restores every row it touches -- so a failure at any step leaves the roster
--  exactly as found, which matters because this runs against live accounts.
--
--  The signed-out caller here is the SQL editor's own session, i.e. NOT the
--  Owner, so the gate MUST refuse. If it succeeds, the internet can wipe any
--  portrait on the site.
--  -----------------------------------------------------------------------------
do $$
declare
  v_target    uuid;
  v_saved_url text;
  v_saved     text;
  v_saved_upd timestamptz;
  v_blocked   text;
  v_after     public.staff;
begin
  -- Pick a row that genuinely has a portrait, so the write is observable.
  select id into v_target
    from public.staff
   where portrait_url is not null
     and btrim(portrait_url) <> ''
   order by created_at asc
   limit 1;

  if v_target is null then
    raise notice 'MIGRATED. No staff row currently has a portrait, so there was '
                 'nothing to prove the write against. The Owner can still use the '
                 'Reset portrait button once somebody uploads a photo.';
    return;
  end if;

  -- Snapshot first, so every later step can put it back.
  select portrait_url, portrait_status, updated_at
    into v_saved_url, v_saved, v_saved_upd
    from public.staff
   where id = v_target;

  -- 1. The Owner gate. A signed-out caller must be refused.
  begin
    perform public.wire_reset_portrait(v_target);
  exception
    when others then
      v_blocked := sqlerrm;
  end;

  if v_blocked is null then
    raise exception 'SECURITY PROBLEM: a signed-out caller was allowed to reset a '
                    'portrait. The is_owner() gate is not being enforced.';
  end if;

  -- 2. Prove a reset clears BOTH halves. Clearing only the URL would leave the
  --    row reading "pending" with nothing to review, and the Owner's queue would
  --    show a phantom submission forever.
  update public.staff
     set portrait_url    = '',
         portrait_status = 'none',
         updated_at      = now()
   where id = v_target
  returning * into v_after;

  if v_after.portrait_url <> '' or v_after.portrait_status <> 'none' then
    raise exception 'FAILED: the reset did not clear both the url and the status.';
  end if;

  -- 3. Restore, byte for byte. Restoring is the whole point -- if this script
  --    aborts later, the portrait must still be there.
  update public.staff
     set portrait_url    = v_saved_url,
         portrait_status = v_saved,
         updated_at      = v_saved_upd
   where id = v_target;

  raise notice 'MIGRATED AND VERIFIED. A signed-out caller is blocked (%), a reset '
               'clears both the url and the status, and the portrait was restored.',
    left(v_blocked, 60);
end;
$$;
--  =============================================================================
--  Idempotent. ASCII only, no BOM. Self-verifying: see the do block above.
--  =============================================================================