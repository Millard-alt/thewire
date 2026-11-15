-- 046_staff_portrait_position.sql
-- -----------------------------------------------------------------------------
-- Adds a per-staffer portrait FRAMING coordinate, so the Owner can crop a
-- portrait vertically instead of relying on a hard centre crop.
--
-- Paste THIS file into the Supabase SQL Editor. Pure ASCII, no BOM.
-- Idempotent. Safe to run more than once.
--
-- WHAT THIS ADDS
--   public.staff.portrait_position  text  NOT NULL DEFAULT '50% 50%'
--
--   The value is a CSS `object-position` string (e.g. "50% 20%") written by the
--   staff editor's vertical framing slider and read back by the live preview
--   (object-fit: cover) and by the byline sticker. The horizontal component is
--   always 50% in this UI; only the vertical offset is adjustable, because
--   that is the axis on which a head-and-shoulders shot actually drifts.
--
-- wire_assign_portrait gains an optional p_position argument so the Owner can
-- persist the framing in the same call that attaches the URL. The argument is
-- nullable: omitting it (or passing NULL) keeps whatever is already stored, so
-- older callers and a plain re-attach of an existing photo never wipe the
-- framing the Owner chose.
-- -----------------------------------------------------------------------------

alter table public.staff
  add column if not exists portrait_position text not null default '50% 50%';

-- Backfill any pre-existing NULLs (the column is new, but be defensive).
update public.staff
   set portrait_position = '50% 50%'
 where portrait_position is null;

-- Extend the portrait RPC. Drop the old signature first so PostgREST does not
-- see two candidates and raise PGRST202.
drop function if exists public.wire_assign_portrait(uuid, text);

create or replace function public.wire_assign_portrait(
  p_staff_id uuid,
  p_url      text,
  p_position text default null
)
returns public.staff
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.staff;
  v_pos text := nullif(trim(coalesce(p_position, '')), '');
begin
  if not public.is_staff() then
    raise exception 'not on the staff roster';
  end if;

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
     set portrait_url      = trim(p_url),
         portrait_status   = case when trim(p_url) = '' then 'none' else 'approved' end,
         portrait_position = coalesce(v_pos, portrait_position)
   where id = p_staff_id
  returning * into v_row;

  if v_row.id is null then
    raise exception 'staff record not found';
  end if;

  return v_row;
end;
$$;

revoke all on function public.wire_assign_portrait(uuid, text, text) from public;
grant execute on function public.wire_assign_portrait(uuid, text, text) to authenticated;

-- schema.sql carries the matching column definition; the grant above keeps the
-- Owner-only path working on databases that run this file in isolation.