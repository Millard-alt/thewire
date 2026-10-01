-- 011_repair_role_constraint.sql
-- -----------------------------------------------------------------------------
-- SUPERSEDED BY 012_fix_live_signup_function.sql -- DO NOT RUN THIS.
--
-- Kept in the repo only as a record of what was tried, and because deleting it
-- would leave the changelog referring to a file that no longer exists.
--
-- WHAT THIS FILE GOT WRONG
--   It assumed the CHECK constraint was stale and set about dropping it. The
--   constraint was correct all along. Measured against the live database by
--   inserting one throwaway row per candidate role and deleting it again:
--
--     role = 'Writer'           ACCEPTED
--     role = 'Editor'           REJECTED 23514
--     role = 'Managing Editor'  REJECTED 23514
--
--   So every repair this file performed was a no-op on the guard, which is why
--   each run "succeeded" and the very next signup failed with the identical
--   message. The real cause was the FUNCTION: the deployed
--   wire_request_account is a stale pre-rename copy that hardcodes
--   v_role := 'Editor', and 006 tightened the CHECK without redefining it.
--
--   The general lesson, now enforced in 012: a migration that only repairs the
--   table cannot prove the signup path works. 012 ends by calling
--   wire_request_account itself and asserting the row lands as a pending
--   Writer, which is the only check that would have caught this.
-- -----------------------------------------------------------------------------
--
-- Original header retained below for reference.
-- -----------------------------------------------------------------------------

-- 011_repair_role_constraint.sql
-- -----------------------------------------------------------------------------
-- FIXES the live signup failure:
--   ERROR: 23514: new row for relation "staff_accounts" violates check
--          constraint "staff_accounts_role_check"
--
-- WHY THE EARLIER ATTEMPTS TO FIX THIS DID NOT TAKE
--   The previous versions of this repair were shipped as ONE file whose first
--   half was a set of read-only diagnostic SELECTs. One of those SELECTs called
--   public.staff_accounts_role_is_valid(), a function that does not exist
--   anywhere in this repository. The Supabase SQL Editor runs a pasted script
--   inside a single implicit transaction, so that one bad reference aborted the
--   ENTIRE paste before the repair block was ever reached. The editor reported
--   an error, no constraint was dropped, and the very next signup failed with
--   the identical message -- which is precisely why this looked unfixable.
--
--   The diagnostic half now lives in 010_diagnose_role.sql, on its own, where a
--   mistake in it cannot block the repair. Run 010 if you want the evidence;
--   run 012 to fix it.
--
-- Steps 1-5 below can all pass while signup still fails, because they only prove
-- the table is internally consistent -- they never prove a new row can be
-- created by the function the app actually calls.
--
-- Idempotent. Safe to run more than once, and in any order relative to 006.
-- -----------------------------------------------------------------------------

do $$
declare
  v_constraint text;
  v_def        text;
  v_bad        text;
  v_attnum     smallint;
  v_found      integer := 0;
begin
  -- 0. Locate the role column by NAME, not by position. Ordinal position is not
  --    stable across ALTER TABLE ADD COLUMN, so anything that hardcodes an
  --    attnum is a latent second bug.
  select a.attnum into v_attnum
    from pg_attribute a
    join pg_class t on t.oid = a.attrelid
    join pg_namespace n on n.oid = t.relnamespace
   where n.nspname = 'public'
     and t.relname = 'staff_accounts'
     and a.attname = 'role'
     and a.attnum > 0
     and not a.attisdropped;

  if v_attnum is null then
    raise exception 'public.staff_accounts has no role column';
  end if;

  -- 1. Drop EVERY CHECK that DEPENDS ON the role column, matched on conkey.
  --
  --    conkey is the list of column ids the constraint references, so this is
  --    an exact structural test: it finds the check whether or not it is named
  --    staff_accounts_role_check, and no matter how many copies exist.
  --
  --    The previous revision matched on `pg_get_constraintdef(...) ilike '%role%'`,
  --    which is a TEXT guess. Postgres renders a check as
  --      CHECK ((role)::text = ANY (ARRAY['Owner'::text, ...]))
  --    so a constraint written as `check (role::text = 'Owner' or ...)`, or one
  --    over an expression, or one where the column is quoted differently, does
  --    not necessarily contain the substring 'role' in its rendered form. Any
  --    such check survives the drop and then rejects the very INSERT the fix is
  --    meant to allow -- which is exactly the reported symptom: the migration
  --    runs, reports success, and the error is unchanged.
  for v_constraint, v_def in
    select c.conname, pg_get_constraintdef(c.oid)
      from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      join pg_namespace n on n.oid = t.relnamespace
     where t.relname = 'staff_accounts'
       and n.nspname = 'public'
       and c.contype = 'c'
       and v_attnum = any (c.conkey)
  loop
    execute format('alter table public.staff_accounts drop constraint %I', v_constraint);
    v_found := v_found + 1;
    raise notice 'dropped constraint % : %', v_constraint, v_def;
  end loop;

  if v_found = 0 then
    raise notice 'no CHECK constraint referenced the role column; adding the guard anyway';
  end if;
-- 2. At most ONE Owner, never at least one. This runs BEFORE the role
  --    normalisation below, because that normalisation reads is_owner to decide
  --    who is Owner. Deduping afterwards would leave the demoted row still
  --    carrying role='Owner' with is_owner=false -- a row that the UI renders as
  --    Owner but that no RLS helper agrees with, which is worse than either
  --    state alone.
  --
  --    It only ever REMOVES a duplicate flag. It deliberately does not promote
  --    anybody: choosing a row to elevate would mean choosing which human becomes
  --    the Owner from a query, and getting that wrong hands the entire Control
  --    Center to an arbitrary account. An Ownerless newsroom is a loud, visible
  --    state the Owner fixes deliberately; a silently promoted stranger is not
  --    recoverable.
  update public.staff_accounts
     set is_owner = false
   where is_owner
     and id <> (
             select id
               from public.staff_accounts
              where is_owner
              order by created_at asc
              limit 1
           );

  -- 3. Normalise every role, with no CHECK attached so nothing can block it.
  --
  --    Handled case-insensitively, because every one of these has been written
  --    to this column at some point:
  --      'reporter'          a guess in an early draft, never a real role
  --      'editor'            the previous name for Writer
  --      'managing editor'   never real
  --      'photographer'      a job title, not a role
  --      'board manager'     a case variant of the real role
  --    Anything else falls through to 'Writer', the weakest role, so an
  --    unrecognised value can never grant more access than intended.
  --
  --    is_owner is honoured FIRST, so the Owner seat is never demoted by a stray
  --    role string left over from before the rename.
  --
  --    The same case expression appears twice because a CHECK-free UPDATE
  --    cannot reference its own target column in the WHERE clause. Both copies
  --    must stay identical or the filter would match the wrong rows.
  update public.staff_accounts
     set role = case
                  when is_owner then 'Owner'
                  when lower(trim(coalesce(role, ''))) = 'owner' then 'Owner'
                  when lower(trim(coalesce(role, ''))) = 'board manager'
                    then 'Board Manager'
                  else 'Writer'
                end
   where role is distinct from (
           case
             when is_owner then 'Owner'
             when lower(trim(coalesce(role, ''))) = 'owner' then 'Owner'
             when lower(trim(coalesce(role, ''))) = 'board manager'
               then 'Board Manager'
             else 'Writer'
           end);

  -- 4. Attach exactly ONE guard, matching ROLES in src/lib/auth.js. Added after
  --    the data is clean so the validation pass has nothing to complain about.
  alter table public.staff_accounts
    add constraint staff_accounts_role_check
    check (role in ('Owner', 'Writer', 'Board Manager'));

  -- 5. Prove it. A silent success here would be worse than the original bug, so
  --    an unexpected value is a hard failure naming the offending rows.
  select string_agg(format('%s=%s', username, role), ', ')
    into v_bad
    from public.staff_accounts
   where role not in ('Owner', 'Writer', 'Board Manager');

  if v_bad is not null then
    raise exception 'role repair incomplete, still invalid: %', v_bad;
  end if;

  -- 6. Prove the guard actually ACCEPTS 'Writer', by running the real INSERT
  --    path and discarding the result.
  --
  --    Steps 1-5 can all pass while signup still fails, because they only prove
  --    the table is consistent -- they never prove a new row can be created.
  --    That gap is what let the original bug survive a "successful" migration
  --    and then reproduce on the very next signup. This writes a throwaway row
  --    through the same column list the app uses, confirms it succeeds, then
  --    removes it.
  --
  --    Raises, rather than warning, if the insert is rejected: a migration that
  --    cannot create a Writer is not a repair.
  --
  --    WHY THERE IS NO SAVEPOINT HERE
  --    An earlier revision wrapped this in `savepoint repair_probe;` /
  --    `rollback to savepoint repair_probe;`. That is a syntax error at or near
  --    "to" (SQLSTATE 42601): PL/pgSQL executes statements through SPI, and SPI
  --    refuses transaction control inside a function. The whole script died at
  --    line 241, AFTER steps 1-5 had already committed nothing -- so the repair
  --    never applied and the very next signup failed with the identical error.
  --    Two lessons, both now encoded below:
  --      * The DO block's own BEGIN/EXCEPTION is already a subtransaction. When
  --        the INSERT raises, Postgres rolls back the statement automatically.
  --        An explicit savepoint is not just redundant here, it is illegal.
  --      * Nothing in this block may rely on control flow that SPI rejects, or
  --        the failure lands at the END of the script and looks like the repair
  --        succeeded.
  --
  --    The throwaway row is deleted explicitly on the success path. Relying on
  --    rollback alone is not safe: if the INSERT succeeds and the DELETE is
  --    skipped by later control flow, a junk account sits on the real roster
  --    waiting for the Owner to find and remove it by hand.
  declare
    v_probe_id uuid;
  begin
    begin
      insert into public.staff_accounts
        (username, password_hash, display_name, role, status, is_owner, approved_at)
      values
        ('__repair_probe__', 'x', 'Repair Probe', 'Writer', 'pending', false, null)
      returning id into v_probe_id;
    exception
      when check_violation then
        -- The insert is rolled back by this block's implicit subtransaction, so
        -- nothing is left behind and the exception is safe to re-raise.
        raise exception
          'STILL BROKEN: the database still rejects role=Writer. '
          'A CHECK constraint outside the role column, or a domain or rule, is '
          'blocking it. Constraint detail: %', sqlerrm;
    end;

    delete from public.staff_accounts where id = v_probe_id;

    if not found then
      raise exception 'probe row was not cleaned up (id %) -- remove it by hand', v_probe_id;
    end if;
  end;

  raise notice
    'staff_accounts.role repaired; % account(s), all roles valid; '
    'a Writer insert is now accepted',
    (select count(*) from public.staff_accounts);
end;
$$;
