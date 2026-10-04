-- =============================================================================
--  021 - TARGETED BROADCASTS AND DEADLINE REMINDERS
-- =============================================================================
--  Symptom
--    The Owner can only broadcast to "Everyone"/"Writers"/"Assignment Managers",
--    and there is no way to reach one person. Separately, assignments have no
--    real deadline date, so nothing can remind anyone one is approaching.
--
--  Why this cannot be a pure client change
--    Two premises in the original request do not hold in this database, and both
--    have to be fixed here rather than in JavaScript:
--
--    1. There is no `profiles` table and no Supabase Auth. Identity is
--       `staff_accounts` (username + password, opaque `x-wire-token`). So the
--       link from a device to a person is `staff_accounts.id`, and that is the
--       column added below. Readers who are not signed in stay anonymous and
--       simply remain untargetable - that is deliberate, not an oversight.
--
--    2. `assignments.deadline` is `text` holding prose such as 'Sept 26, 2026'.
--       Postgres cannot compare that to `now()`, so no amount of querying can
--       find "assignments due within 24 hours". A real `due_at timestamptz` is
--       added and back-filled from the text on a best-effort basis. The text
--       column is kept: it is what the public newsroom page renders, and
--       rewriting it would change published copy.
--
--  Fix
--    1. push_subscriptions.staff_id  - link a device to a staff account.
--    2. assignments.assigned_to      - who owns the piece.
--       assignments.due_at           - machine-readable deadline.
--       assignments.reminder_sent    - one reminder, not one per cron tick.
--    3. wire_register_device accepts p_staff_id and persists it.
--
--  Notes
--    * Re-runnable. `create or replace` cannot change a signature, so the old
--      5-argument wire_register_device is dropped first.
--    * Pure ASCII, no BOM. Paste into Supabase -> SQL Editor.
--    * `assigned_to` is a soft reference (no FK): the staff roster and the
--      assignment board are edited by different panels, and a hard foreign key
--      would block deleting an account that still has assignments on it. The
--      cron simply skips rows whose target no longer exists.
-- =============================================================================

-- -----------------------------------------------------------------------------
--  1. LINK A DEVICE TO THE STAFF ACCOUNT THAT OWNS IT
-- -----------------------------------------------------------------------------

alter table public.push_subscriptions
  add column if not exists staff_id uuid;

comment on column public.push_subscriptions.staff_id is
  'staff_accounts.id of the signed-in account this device belongs to. NULL for anonymous readers, who cannot be individually targeted.';

-- Targeted sends filter on this, so it needs an index.
create index if not exists push_subscriptions_staff_idx
  on public.push_subscriptions (staff_id)
  where staff_id is not null;

-- -----------------------------------------------------------------------------
--  2. ASSIGNMENTS: AN OWNER, A REAL DEADLINE, AND A REMINDER FLAG
-- -----------------------------------------------------------------------------

alter table public.assignments
  add column if not exists assigned_to uuid;
alter table public.assignments
  add column if not exists due_at timestamptz;
alter table public.assignments
  add column if not exists reminder_sent boolean not null default false;

comment on column public.assignments.assigned_to is
  'staff_accounts.id of the reporter this piece is assigned to. NULL means unassigned.';
comment on column public.assignments.due_at is
  'Machine-readable deadline. The cron reminder compares this to now(); the legacy deadline text is display-only.';
comment on column public.assignments.reminder_sent is
  'True once the approaching-deadline push has been dispatched, so the hourly cron cannot spam the same person.';

-- The cron's hot path is "due soon, not yet reminded".
create index if not exists assignments_due_reminder_idx
  on public.assignments (due_at)
  where reminder_sent = false and due_at is not null;

-- -----------------------------------------------------------------------------
--  3. BACK-FILL due_at FROM THE LEGACY TEXT COLUMN
--    Best effort and deliberately forgiving. Anything that does not parse is
--    left NULL, which simply means "the cron will never remind about it" - far
--    better than guessing a date and sending a wrong deadline alert.
-- -----------------------------------------------------------------------------

update public.assignments
   set due_at = coalesce(
     -- 'Sept 26, 2026' / 'Sep 26, 2026': strip the period Postgres rejects.
     to_timestamp(
       replace(btrim(deadline), '.', ''),
       'Mon DD, YYYY'
     ),
     to_timestamp(
       replace(btrim(deadline), '.', ''),
       'FMMonth DD, YYYY'
     ),
     to_timestamp(
       replace(btrim(deadline), '.', ''),
       'YYYY-MM-DD'
     ),
     null
   )
 where due_at is null
   and deadline is not null
   and btrim(deadline) <> '';

-- -----------------------------------------------------------------------------
--  4. REGISTER A DEVICE, LINKED TO THE SIGNED-IN STAFF ACCOUNT
--     An empty p_endpoint still means "unsubscribe" and is handled as before.
-- -----------------------------------------------------------------------------

drop function if exists public.wire_register_device(text, text, text, text, text);

create or replace function public.wire_register_device(
  p_endpoint text,
  p_device   text default null,
  p_audience text default 'Everyone',
  p_p256dh   text default null,
  p_auth     text default null,
  p_staff_id text default null
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_endpoint text;
  v_p256dh   text;
  v_auth     text;
  v_staff_id uuid;
begin
  -- Unsubscribe: a reader switching alerts off. Delete only.
  if p_endpoint is null or btrim(p_endpoint) = '' then
    return 'ignored';
  end if;

  v_endpoint := btrim(p_endpoint);
  v_p256dh    := nullif(btrim(coalesce(p_p256dh, '')), '');
  v_auth      := nullif(btrim(coalesce(p_auth, '')), '');

  if length(v_endpoint) > 500 then
    raise exception 'endpoint too long';
  end if;
  if v_p256dh is not null and length(v_p256dh) > 200 then
    raise exception 'p256dh too long';
  end if;
  if v_auth is not null and length(v_auth) > 100 then
    raise exception 'auth too long';
  end if;

  -- Accept the id only if it is a real, castable UUID. The browser sends
  -- getSession().user.id, which is already a uuid, but this function is
  -- anon-grantable and must not explode on a malformed value.
  if nullif(btrim(coalesce(p_staff_id, '')), '') is not null then
    begin
      v_staff_id := btrim(p_staff_id)::uuid;
    exception when others then
      v_staff_id := null;
    end;
  end if;

  insert into public.push_subscriptions
    (endpoint, device, audience, p256dh, auth, staff_id, last_seen)
  values (
    v_endpoint,
    left(coalesce(nullif(btrim(p_device), ''), 'Unknown device'), 120),
    left(coalesce(nullif(btrim(p_audience), ''), 'Everyone'), 60),
    v_p256dh,
    v_auth,
    v_staff_id,
    now()
  )
  on conflict (endpoint) do update
    set device    = excluded.device,
        audience  = excluded.audience,
        -- Only overwrite keys with a real value. A re-registration from a
        -- client that cannot produce keys (the in-app-only path) must not
        -- blank out keys a previous visit did store.
        p256dh    = coalesce(excluded.p256dh, public.push_subscriptions.p256dh),
        auth      = coalesce(excluded.auth, public.push_subscriptions.auth),
        -- Same rule for the owner link: do not un-link a device merely because
        -- this particular visit was anonymous. But DO re-point it when the
        -- caller is signed in as somebody else, so a shared machine does not
        -- keep delivering one person's alerts.
        staff_id  = coalesce(excluded.staff_id, public.push_subscriptions.staff_id),
        last_seen = now();

  return 'subscribed';
end;
$$;

grant execute on function public.wire_register_device(text, text, text, text, text, text)
  to anon, authenticated;

-- -----------------------------------------------------------------------------
--  5. STAFF DIRECTORY FOR THE "SPECIFIC USER" PICKER
--     The Owner needs a searchable list of people to target. Exposed as a
--     SECURITY DEFINER function (like every other RPC in this project) so the
--     roster is readable without exposing staff_accounts to the anon role.
-- -----------------------------------------------------------------------------

drop function if exists public.wire_staff_directory();

create or replace function public.wire_staff_directory()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb)
  from (
    select id, username, display_name, role
      from public.staff_accounts
     where status = 'active'
     order by display_name
  ) t;
$$;

grant execute on function public.wire_staff_directory()
  to anon, authenticated;

-- -----------------------------------------------------------------------------
--  6. DEADLINE REMINDER CLAIM
--     The cron marks a row reminded BEFORE sending, so a crash mid-send cannot
--     cause the same alert to go out again on the next tick. Returns the rows
--     it claimed, which is exactly the set that should be pushed.
-- -----------------------------------------------------------------------------

create or replace function public.wire_claim_due_reminders(p_within_hours integer default 24)
returns table (assignment_id uuid, assignment_title text, due_at timestamptz, staff_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_window integer := coalesce(p_within_hours, 24);
begin
  return query
  with due as (
    select a.id, a.title, a.due_at, a.assigned_to
      from public.assignments a
     where a.reminder_sent = false
       and a.due_at is not null
       and a.assigned_to is not null
       -- Already past due: too late for "approaching". Never notify those,
       -- and never notify twice.
       and a.due_at > now()
       and a.due_at <= now() + make_interval(hours => v_window)
       -- Completed work needs no chasing.
       and coalesce(a.status, 'Open') <> 'Completed'
     order by a.due_at asc
     -- A single pass should never fan out into an unbounded blast.
     limit 500
     for update skip locked
  ),
  claimed as (
    update public.assignments a
       set reminder_sent = true
      from due d
     where a.id = d.id
    returning a.id, a.title, a.due_at, a.assigned_to
  )
  select c.id, c.title, c.due_at, c.assigned_to from claimed c;
end;
$$;

grant execute on function public.wire_claim_due_reminders(integer)
  to service_role;

-- -----------------------------------------------------------------------------
--  7. REPORTING
-- -----------------------------------------------------------------------------

create or replace function public.wire_pushable_device_count()
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::integer
    from public.push_subscriptions
   where p256dh is not null
     and auth   is not null;
$$;

grant execute on function public.wire_pushable_device_count()
  to anon, authenticated, service_role;

create or replace function public.wire_targeted_device_count(p_staff_id uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::integer
    from public.push_subscriptions
   where p256dh is not null
     and auth   is not null
     and staff_id = p_staff_id;
$$;

grant execute on function public.wire_targeted_device_count(uuid)
  to anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
--  8. VERIFY
-- -----------------------------------------------------------------------------

do $$
declare
  v_staff_col integer;
  v_due_col   integer;
  v_backfilled integer;
begin
  select count(*) into v_staff_col
    from information_schema.columns
   where table_schema = 'public'
     and table_name   = 'push_subscriptions'
     and column_name  = 'staff_id';

  select count(*) into v_due_col
    from information_schema.columns
   where table_schema = 'public'
     and table_name   = 'assignments'
     and column_name  = 'due_at';

  select count(*) into v_backfilled
    from public.assignments
   where due_at is not null;

  raise notice '--- 021 targeted push + deadlines ---';
  raise notice 'push_subscriptions.staff_id present: %', v_staff_col > 0;
  raise notice 'assignments.due_at present: %', v_due_col > 0;
  raise notice 'assignments with a parsed due_at: % of %', v_backfilled,
    (select count(*) from public.assignments);

  if v_staff_col = 0 or v_due_col = 0 then
    raise exception '021 did not apply cleanly';
  end if;
end;
$$;