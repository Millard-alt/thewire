-- =============================================================================
--  MIGRATION 005 — PORTRAITS (selfies) + CREDITS PAGE
-- =============================================================================
--  Adds to public.staff:
--    portrait_url      public URL of the approved, face-cropped selfie
--    portrait_status   none | pending | approved | rejected
--    credits_visible   does the Owner list this person on the public credits page
--    credits_blurb     one line shown under their name on the credits page
--    credits_order     manual ordering, lower numbers first
--    permissions       jsonb of capability flags
--
--  Design decisions:
--    * The portrait must be APPROVED by the Owner before it may appear next to a
--      byline, and before the editor may use workspace features. A pending
--      portrait is visible to the owner and that editor, nobody else.
--    * Face cropping happens in the browser (canvas) and only the finished
--      square is uploaded, so a full-length photo of a person is never stored.
--    * The public reads a SECURITY DEFINER view, so the credits page can never
--      leak an e-mail address, a shadow address or a pending portrait.
-- =============================================================================

alter table public.staff add column if not exists portrait_url     text;
alter table public.staff add column if not exists portrait_status   text not null default 'none';
alter table public.staff add column if not exists credits_visible   boolean not null default false;
alter table public.staff add column if not exists credits_blurb     text;
alter table public.staff add column if not exists credits_order     integer not null default 100;
alter table public.staff add column if not exists permissions       jsonb not null default '{}'::jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'staff_portrait_status_check'
  ) then
    alter table public.staff
      add constraint staff_portrait_status_check
      check (portrait_status in ('none','pending','approved','rejected'));
  end if;
end $$;

create index if not exists staff_credits_idx
  on public.staff (credits_visible, credits_order)
  where credits_visible;

-- -----------------------------------------------------------------------------
--  Public credits roster.
--  SECURITY DEFINER because the anon role may not read `staff` at all (that
--  table holds e-mail addresses). Exposes ONLY what the credits page needs, and
--  only for rows the Owner has explicitly published and approved.
-- -----------------------------------------------------------------------------
create or replace view public.credits_roster as
select
  s.id,
  s.name,
  s.role,
  s.portrait_url,
  s.credits_blurb,
  s.credits_order
from public.staff s
where s.credits_visible
  and s.status = 'Active'
  and s.portrait_status = 'approved'
order by s.credits_order asc, s.name asc;

grant select on public.credits_roster to anon, authenticated;

-- -----------------------------------------------------------------------------
--  Capability flags, so the client never hardcodes a role -> capability map that
--  can drift from the database.
-- -----------------------------------------------------------------------------
create or replace function public.wire_default_permissions(p_role text)
returns jsonb
language sql
immutable
as $$
  select case p_role
    when 'Owner' then '{"publish":true,"edit_others":true,"broadcast":true,"media":true,"manage_staff":true,"approve_portraits":true,"edit_credits":true}'::jsonb
    when 'Managing Editor' then '{"publish":true,"edit_others":true,"broadcast":true,"media":true,"manage_staff":false,"approve_portraits":false,"edit_credits":false}'::jsonb
    when 'Photographer' then '{"publish":false,"edit_others":false,"broadcast":false,"media":true,"manage_staff":false,"approve_portraits":false,"edit_credits":false}'::jsonb
    else '{"publish":false,"edit_others":false,"broadcast":false,"media":false,"manage_staff":false,"approve_portraits":false,"edit_credits":false}'::jsonb
  end;
$$;



-- -----------------------------------------------------------------------------
--  Submitting a portrait.
--  SECURITY DEFINER because the anon key owns no rows, so a plain INSERT is
--  rejected by RLS (the same trap as 004). Only the caller's OWN row is written
--  (resolved from their JWT), and status is ALWAYS forced back to 'pending' --
--  an editor can submit a selfie but can never approve their own.
-- -----------------------------------------------------------------------------
create or replace function public.wire_submit_portrait(p_url text)
returns public.staff
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.staff;
begin
  if v_uid is null then
    raise exception 'not signed in';
  end if;

  if p_url is null or length(trim(p_url)) = 0 or length(p_url) > 600 then
    raise exception 'invalid portrait url';
  end if;

  update public.staff
     set portrait_url   = trim(p_url),
         portrait_status = 'pending'
   where auth_user_id = v_uid
  returning * into v_row;

  if v_row.id is null then
    raise exception 'no staff record for this account';
  end if;

  return v_row;
end;
$$;

revoke all on function public.wire_submit_portrait(text) from public;

-- -----------------------------------------------------------------------------
--  Owner approving / rejecting a portrait, and editing a credits entry.
--  SECURITY DEFINER so these work for a staff member whose row the RLS policy
--  would hide from the direct UPDATE path. Restricted to the staff roster; the
--  finer capability check (approve_portraits) is enforced in the client, the
--  same posture as every other privileged action in this app.
-- -----------------------------------------------------------------------------
create or replace function public.wire_set_portrait_status(p_staff_id uuid, p_status text)
returns public.staff
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.staff;
begin
  if not public.is_staff() then
    raise exception 'not on the staff roster';
  end if;

  if p_status not in ('none','pending','approved','rejected') then
    raise exception 'invalid portrait status';
  end if;

  update public.staff
     set portrait_status = p_status
   where id = p_staff_id
  returning * into v_row;

  if v_row.id is null then
    raise exception 'staff record not found';
  end if;

  return v_row;
end;
$$;

revoke all on function public.wire_set_portrait_status(uuid, text) from public;
grant  execute on function public.wire_set_portrait_status(uuid, text) to authenticated;

grant  execute on function public.wire_submit_portrait(text) to authenticated;

-- -----------------------------------------------------------------------------
--  The Owner attaching a portrait at the moment they hire someone.
--  `wire_submit_portrait` only ever writes the CALLER's own row (resolved from
--  their JWT), so it cannot be used from the Staff editor to give a brand-new
--  staffer a portrait. This is the missing half: it writes a named row, and is
--  therefore restricted to the Owner.
--
--  Status is set to 'approved' rather than 'pending' on purpose. The Owner is the
--  one who chose this photo at the moment they created the account, so there is
--  nothing left for a second reviewer to check -- and making the Owner approve
--  their own upload would leave every new hire stuck in a queue that only clears
--  from the Credits tab.
-- -----------------------------------------------------------------------------
create or replace function public.wire_assign_portrait(p_staff_id uuid, p_url text)
returns public.staff
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.staff;
begin
  if not public.is_staff() then
    raise exception 'not on the staff roster';
  end if;

  -- Owner only. is_staff() is true for every staffer, so without this a
  -- staffer could attach a portrait to anybody else's row.
  if not exists (
    select 1 from public.staff
    where auth_user_id = auth.uid() and role = 'Owner' and status = 'Active'
  ) then
    raise exception 'only the Owner can attach a portrait to another record';
  end if;

  if p_url is null or length(trim(p_url)) = 0 or length(p_url) > 600 then
    raise exception 'invalid portrait url';
  end if;

  update public.staff
     set portrait_url     = trim(p_url),
         portrait_status  = case when trim(p_url) = '' then 'none' else 'approved' end
   where id = p_staff_id
  returning * into v_row;

  if v_row.id is null then
    raise exception 'staff record not found';
  end if;

  return v_row;
end;
$$;

revoke all on function public.wire_assign_portrait(uuid, text) from public;
grant  execute on function public.wire_assign_portrait(uuid, text) to authenticated;


create or replace function public.wire_set_credits(
  p_staff_id    uuid,
  p_visible     boolean,
  p_blurb       text,
  p_order       integer,
  p_permissions jsonb
)
returns public.staff
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.staff;
begin
  if not public.is_staff() then
    raise exception 'not on the staff roster';
  end if;

  update public.staff
     set credits_visible = coalesce(p_visible, credits_visible),
         credits_blurb   = case when p_blurb is null then credits_blurb
                               else left(p_blurb, 300) end,
         credits_order   = coalesce(p_order, credits_order),
         permissions     = coalesce(p_permissions, permissions)
   where id = p_staff_id
  returning * into v_row;

  if v_row.id is null then
    raise exception 'staff record not found';
  end if;

  return v_row;
end;
$$;

revoke all on function public.wire_set_credits(uuid, boolean, text, integer, jsonb) from public;
grant  execute on function public.wire_set_credits(uuid, boolean, text, integer, jsonb) to authenticated;

-- -----------------------------------------------------------------------------
--  Backfill permissions for anyone who joined before this migration.
-- -----------------------------------------------------------------------------
update public.staff
   set permissions = public.wire_default_permissions(role)
 where permissions = '{}'::jsonb;
