-- 010_repair_role_constraint.sql
-- -----------------------------------------------------------------------------
-- Repair public.staff_accounts.role so the database agrees with the client.
--
-- THE FAILURE THIS FIXES
--   ERROR: 23514: new row for relation "staff_accounts" violates check
--          constraint "staff_accounts_role_check"
--   DETAIL: Failing row contains (..., 'editor', ..., 'Editor', 'Writer',
--           'active', ...)
--
-- The failing row's role is 'Writer', which is the value the whole product now
-- uses. So the constraint rejecting it is NOT the one written in credentials.sql
-- -- that file already lists 'Writer'. A DIFFERENT, older copy of the CHECK is
-- still live, and it predates the Writer rename.
--
-- 006_roles_and_privileges.sql tried to fix this by dropping the constraint
-- first and re-adding it after. That only works if the constraint is named
-- exactly 'staff_accounts_role_check'. This file instead DISCOVERS every CHECK
-- attached to the role column via the system catalog and drops all of them, so
-- it repairs the column regardless of what the constraint is called or how many
-- stale copies exist. 006 could leave a second, stale constraint behind for
-- exactly this reason, and the symptom then looks like "the fix did not take".
--
-- Everything runs inside ONE DO block, so it is a single atomic unit: either the
-- column ends up consistent and guarded, or nothing changes at all. That also
-- matters because the Supabase SQL Editor wraps a pasted script in one implicit
-- transaction, so a mid-script failure rolls the whole paste back and leaves the
-- table as it was -- which is how a half-applied fix becomes indistinguishable
-- from no fix at all.
--
-- The final check RAISEs if any row still violates the intended set, rather
-- than reporting success while leaving bad data behind.
--
-- Idempotent. Safe to run more than once, in any order relative to 006.
-- -----------------------------------------------------------------------------

do $$
declare
  v_constraint text;
  v_bad        text;
begin
  -- 1. Drop EVERY CHECK constraint that mentions the role column.
  --    Matched on the catalog, not on conname. conname alone is what made 006
  --    fragile: a constraint renamed by an earlier edit, or a second copy added
  --    by a re-run, simply does not match and so is never dropped.
  for v_constraint in
    select c.conname
      from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      join pg_namespace n on n.oid = t.relnamespace
     where t.relname = 'staff_accounts'
       and n.nspname = 'public'
       and c.contype = 'c'
       -- Only role checks. The status and username checks are left alone.
       and pg_get_constraintdef(c.oid) ilike '%role%'
  loop
    execute format('alter table public.staff_accounts drop constraint %I', v_constraint);
    raise notice 'dropped stale role check: %', v_constraint;
  end loop;
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

  raise notice 'staff_accounts.role repaired; % account(s), all roles valid',
    (select count(*) from public.staff_accounts);
end;
$$;