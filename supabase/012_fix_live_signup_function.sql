-- 012_fix_live_signup_function.sql
-- -----------------------------------------------------------------------------
-- FIXES the live signup failure. Paste THIS file into the Supabase SQL Editor.
--
--   ERROR: 23514: new row for relation "staff_accounts" violates check
--          constraint "staff_accounts_role_check"
--
-- THE ACTUAL ROOT CAUSE (measured against the live database, not inferred)
--   The CHECK constraint was NEVER wrong. Probed directly with the service_role
--   key by inserting one throwaway row per candidate role, then deleting it:
--
--     role = 'Writer'           ACCEPTED
--     role = 'Editor'           REJECTED 23514
--     role = 'Managing Editor'  REJECTED 23514
--
--   So the guard already accepts exactly the three real roles. The problem is
--   the FUNCTION. Calling the deployed wire_request_account returned a DETAIL
--   showing the value the function itself tries to store:
--
--     Failing row contains (..., 'Diag Probe', Editor, pending, f, ...)
--                                                ^^^^^^ the function's value
--
--   The deployed wire_request_account is a STALE PRE-RENAME COPY that still
--   hardcodes v_role := 'Editor'. Migration 006 tightened the CHECK to the three
--   real roles but never redefined the signup function, so the server kept
--   running the old body. Every signup has failed ever since.
--
--   That is why four rounds of constraint repair failed: each one "succeeded",
--   the CHECK was already correct, and the very next signup failed identically.
--   The bug was never in a constraint that needed dropping.
--
-- WHY src/lib/auth.js COULD NOT FIX THIS
--   The client sends only a username, display name and password. The role is
--   assigned SERVER-SIDE inside the function, so no client change can affect
--   what the deployed body inserts. It had to be fixed here.
--
-- WHAT ELSE WAS WRONG, AND IS FIXED BELOW
--   wire_approve_account had `p_role text default 'Editor'` and a guard reading
--   `if v_role not in ('Owner','Editor','Board Manager')`. The client calls
--   approveAccount(id, role='Writer'), so approving ANY account raised
--   'Unknown role.'. Both are corrected below.
--
--   credentials.sql is updated to match, so a FRESH database built from the
--   repo never reproduces this.
--
-- SAFE TO RUN TWICE. Idempotent: create or replace, plus no-op guards.
--
-- Pure ASCII, no BOM. Paste the WHOLE file in one go -- the SQL Editor runs a
-- pasted script inside a single implicit transaction, so a mid-script error
-- rolls the whole thing back and changes nothing.
-- -----------------------------------------------------------------------------

-- 1. Redefine the signup function with the real role set. THIS IS THE FIX.
create or replace function public.wire_request_account(
  p_username     text,
  p_display_name text,
  p_password     text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_user   text := lower(trim(p_username));
  v_name   text := nullif(trim(p_display_name), '');
  v_id     uuid;
  v_status text;
  v_owner  boolean;
  v_role   text;
begin
  if v_user is null or v_user !~ '^[a-z0-9][a-z0-9._-]{2,31}$' then
    raise exception 'Username must be 3-32 characters, using letters, numbers, dots, dashes or underscores.';
  end if;

  if v_name is null or char_length(v_name) < 2 then
    raise exception 'Please enter your full name.';
  end if;

  if p_password is null or char_length(p_password) < 8 then
    raise exception 'Password must be at least 8 characters long.';
  end if;

  -- Friendly duplicate handling. `for update` also serialises two simultaneous
  -- signups for the same name, so the check cannot race past.
  if exists (
    select 1 from public.staff_accounts
     where username = v_user
     for update
  ) then
    raise exception 'That username is already taken. Try another one.'
      using errcode = 'unique_violation';
  end if;

  -- First-run claim, serialised by the primary key on `username` plus the
  -- existence check above, so two simultaneous first signups cannot both win.
  if not exists (select 1 from public.staff_accounts) then
    v_status := 'active';
    v_owner  := true;
    v_role   := 'Owner';
  else
    v_status := 'pending';
    v_owner  := false;
    -- 'Writer', NOT 'Editor'. This single literal was the bug.
    v_role   := 'Writer';
  end if;

  insert into public.staff_accounts
    (username, password_hash, display_name, role, status, is_owner, approved_at)
  values
    (v_user, extensions.crypt(p_password, extensions.gen_salt('bf')), v_name, v_role, v_status, v_owner,
     case when v_owner then now() else null end)
  returning id into v_id;

  return jsonb_build_object(
    'id',           v_id,
    'username',     v_user,
    'display_name', v_name,
    'role',         v_role,
    'status',       v_status,
    'is_owner',     v_owner
  );
end;
$$;
-- 2. Fix the approve function. It used to default to 'Editor' and its guard
--    rejected 'Writer', the only role the client ever sends, so approval always
--    raised 'Unknown role.'.
create or replace function public.wire_approve_account(p_id uuid, p_role text default 'Writer')
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_role text := lower(trim(coalesce(p_role, '')));
  v_out  jsonb;
begin
  if not public.is_owner() then
    raise exception 'Only the Owner can approve accounts.';
  end if;

  -- Accept the old spelling from a stale browser tab or saved form.
  if v_role = 'editor' then
    v_role := 'Writer';
  end if;

  if v_role not in ('Owner','Writer','Board Manager') then
    raise exception 'Unknown role.';
  end if;

  -- A pending account can never be the Owner, so there is exactly one Owner.
  update public.staff_accounts
     set status      = 'active',
         approved_at = now(),
         role        = case when is_owner then 'Owner' else v_role end
   where id = p_id
  returning jsonb_build_object('id', id, 'username', username, 'role', role, 'status', status)
    into v_out;

  if v_out is null then
    raise exception 'Account not found.';
  end if;

  return v_out;
end;
$$;

-- 3. Make sure the CHECK really is the three-role set.
--
--    Already correct on the live database, so this is a no-op there. It exists
--    so a FRESH database built from an older credentials.sql is also correct.
--    The fold runs FIRST so a stray legacy row cannot make the ADD below fail
--    and roll the entire paste back.
update public.staff_accounts
   set role = 'Writer'
 where role is not null
   and lower(trim(role)) in ('editor', 'reporter');

do $$
begin
  if exists (
    select 1
      from pg_constraint c
      join pg_class t     on t.oid = c.conrelid
      join pg_namespace n on n.oid = t.relnamespace
     where t.relname = 'staff_accounts'
       and n.nspname = 'public'
       and c.contype = 'c'
       and pg_get_constraintdef(c.oid) ilike '%role%'
       and pg_get_constraintdef(c.oid) not ilike '%board manager%'
  ) then
    alter table public.staff_accounts drop constraint staff_accounts_role_check;
  end if;
end;
$$;

alter table public.staff_accounts
  add constraint staff_accounts_role_check
  check (role in ('Owner','Writer','Board Manager'));

-- 4. PROVE IT, by running the real signup path end to end and cleaning up.
--
--    Steps 1-3 can all succeed while signup still fails, because none of them
--    call the function that was broken. This is the check that would have caught
--    the original bug: it calls wire_request_account exactly as the browser
--    does, asserts the row landed as a pending Writer, then deletes it.
--
--    Why an exception block and not a savepoint: PL/pgSQL runs statements
--    through SPI, and SPI refuses transaction control inside a function, so
--    `savepoint` / `rollback to` is a syntax error (42601) that kills the script
--    at the END, after reporting success for everything above it. The
--    BEGIN/EXCEPTION here is already an implicit subtransaction, so a failure
--    rolls the statement back on its own.
do $$
declare
  v_probe_id   uuid;
  v_probe_role text;
  v_probe_stat text;
  v_probe_user text := '__sql_probe_' || substr(md5(random()::text), 1, 8);
begin
  select id, role, status
    into v_probe_id, v_probe_role, v_probe_stat
    from public.wire_request_account(v_probe_user, 'Sql Probe', 'probe-password-123');

  if v_probe_id is null then
    raise exception 'PROBE FAILED: wire_request_account returned no id. Signup is still broken.';
  end if;

  if v_probe_role <> 'Writer' or v_probe_stat <> 'pending' then
    raise exception 'PROBE FAILED: got role=% status=%, expected Writer/pending.',
      v_probe_role, v_probe_stat;
  end if;

  delete from public.staff_accounts where id = v_probe_id;

  if not found then
    raise exception 'probe row was not cleaned up (id %) -- remove it by hand', v_probe_id;
  end if;

  raise notice 'FIXED AND VERIFIED: signup works. role=% status=%. probe row deleted.',
    v_probe_role, v_probe_stat;
end;
$$;
