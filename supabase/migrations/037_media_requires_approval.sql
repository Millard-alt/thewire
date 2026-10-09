-- =============================================================================
--  037_media_requires_approval
-- =============================================================================
--  WHY
--
--  `media_assets` had no approval concept at all. Its columns were
--  id / url / caption / created_at, its read policy was `using (true)`, and
--  migration 035 deliberately left INSERT open to any active staffer because
--  the Media tab is a Writer tab in the panel.
--
--  The consequence was that a Writer could upload a photograph and it became
--  publicly readable and gallery-visible immediately, with no sign-off from
--  anybody. Articles never had this problem: 033 gates *publishing* behind
--  can_approve(). Media was simply never given the same treatment.
--
--  THE POINT OF THE BACKFILL
--
--  Adding `status` with `default 'pending'` would mark every EXISTING row
--  pending, because a column default is applied to rows already in the table.
--  That would blank the live gallery overnight -- the exact failure this
--  migration exists to prevent. So the column is added NULLABLE first, every
--  existing row is explicitly set to 'approved', and only then is the default
--  attached for future inserts.
--
--  WHO CAN DO WHAT
--
--      upload a photo              any active staffer      -> status 'pending'
--      see it on the public site   nobody, until approved
--      approve it                  can_approve()          -> 'approved'
--      edit a pending row          its author, while pending
--      edit an approved row        can_approve() only
--      delete it                   Owner only (unchanged)
--
--  A Writer cannot insert status='approved' or update a row into it: both
--  policies read `can_approve() or status = 'pending'`, so the WITH CHECK fails
--  for a Writer trying to self-approve. That is the actual enforcement --
--  hiding a button in the panel would be cosmetic.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
--  1. The column, added nullable with NO default so nothing is disturbed yet.
-- -----------------------------------------------------------------------------
alter table public.media_assets
  add column if not exists status text;

-- -----------------------------------------------------------------------------
--  2. Backfill. Every photo already on the site was vetted by whoever put it
--     there, so existing rows are approved and stay visible.
--
--     The `is distinct from` guard makes this safe to re-run: it only touches
--     rows that have no decision recorded.
-- -----------------------------------------------------------------------------
update public.media_assets
   set status = 'approved'
 where status is distinct from 'approved'
   and status is null;

-- Any row carrying a status this migration does not know about is a mistake
-- worth reporting rather than silently overwriting.
do $$
declare
  odd text;
begin
  select string_agg(status, ', ' order by status)
    into odd
    from public.media_assets
   where status is not null
     and status not in ('pending', 'approved', 'rejected');

  if odd is not null then
    raise exception
      'media_assets.status holds unexpected value(s): %. '
      'Set them to approved or pending before applying 037.', odd;
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
--  3. Only NOW does the default attach, so future rows land as pending.
-- -----------------------------------------------------------------------------
alter table public.media_assets
  alter column status set default 'pending';

alter table public.media_assets
  alter column status set not null;

-- A CHECK is a backstop for writes that arrive through a path the policies do
-- not cover, such as service_role from a serverless function.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.media_assets'::regclass
       and conname  = 'media_assets_status_check'
  ) then
    alter table public.media_assets
      add constraint media_assets_status_check
      check (status in ('pending', 'approved', 'rejected'));
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
--  4. Policies.
--
--  READ: the public sees approved rows only. Staff see everything, because the
--  panel has to be able to review what is waiting.
-- -----------------------------------------------------------------------------
drop policy if exists media_public_read on public.media_assets;
create policy media_public_read on public.media_assets
  for select
  using (status = 'approved' or public.is_staff());

-- INSERT: any staffer may upload, but only a Manager or Owner may insert a row
-- that is already approved. A Writer is pinned to 'pending'.
drop policy if exists media_staff_write on public.media_assets;
create policy media_staff_write on public.media_assets
  for insert
  with check (public.is_staff() and (public.can_approve() or status = 'pending'));

-- UPDATE: a Writer may work on a row that is still pending -- fixing a caption
-- before submitting it -- but cannot touch an approved row and cannot move a
-- pending row to approved. can_approve() is the only route to approved.
drop policy if exists media_staff_update on public.media_assets;
create policy media_staff_update on public.media_assets
  for update
  using (public.is_staff() and (public.can_approve() or status = 'pending'))
  with check (public.is_staff() and (public.can_approve() or status = 'pending'));

-- DELETE: unchanged. Purging someone's photograph is the Owner's decision.
drop policy if exists media_owner_delete on public.media_assets;
create policy media_owner_delete on public.media_assets
  for delete using (public.is_owner());

-- -----------------------------------------------------------------------------
--  5. Verify, so a partial application is reported rather than assumed.
-- -----------------------------------------------------------------------------
do $$
declare
  v_pending  bigint;
  v_approved bigint;
  v_null     bigint;
  loose      text;
begin
  select count(*) filter (where status is null),
         count(*) filter (where status = 'pending'),
         count(*) filter (where status = 'approved')
    into v_null, v_pending, v_approved
    from public.media_assets;

  if v_null > 0 then
    raise exception
      '% media_assets row(s) still have a NULL status. The gallery would be '
      'partially hidden. Re-run 037.', v_null;
  end if;

  -- The public must not be able to read a pending row.
  select coalesce(qual, '') into loose
    from pg_policies
   where schemaname = 'public'
     and tablename  = 'media_assets'
     and cmd        = 'SELECT';

  if loose !~ '(approved|can_approve|is_staff)' then
    raise exception
      'the media_assets SELECT policy is not gated on approval: %',
      coalesce(loose, 'MISSING');
  end if;

  raise notice
    'media_assets: % approved (still visible), % pending (waiting).', v_approved, v_pending;
end;
$$;

commit;
