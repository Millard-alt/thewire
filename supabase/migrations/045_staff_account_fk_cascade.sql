-- 045_staff_account_fk_cascade.sql
-- -----------------------------------------------------------------------------
-- MAKES THE DATABASE THE SINGLE SOURCE OF TRUTH FOR "WHO IS ON THE TEAM".
--
-- Paste THIS file into the Supabase SQL Editor. Pure ASCII, no BOM.
-- Idempotent. Safe to run more than once.
--
-- THE PROBLEM (measured against the live schema, not inferred)
-- -----------------------------------------------------------------------------
--   public.staff_accounts   the ACCOUNT: username, password hash, role, status
--   public.staff            the PROFILE: name, e-mail, portrait, byline state
--
-- The two tables describe the same person but were linked ONLY by a lowercase
-- username comparison performed in the browser. The Owner's panel has one tab
-- per table (Accounts and Staff), and both delete buttons carried their own
-- copy of "find the other row by username and delete it too". Two copies of
-- that logic could and did drift, and any mismatch left a dangling row on the
-- other tab until the next full reload.
--
-- WHAT THIS FILE DOES
--   1. Adds public.staff.account_id and backfills it from staff_accounts by
--      the same username match the client used to do, once, at the boundary.
--   2. Adds the foreign key the client used to simulate by hand:
--
--        ALTER TABLE public.staff
--          ADD CONSTRAINT staff_account_id_fkey
--          FOREIGN KEY (account_id) REFERENCES public.staff_accounts (id)
--          ON DELETE CASCADE;
--
--      (The request named it "accounts(id)" because the tab is called
--      Accounts; in this schema that table is public.staff_accounts.)
--      From now on, deleting an account row deletes its staff profile in the
--      same statement. There is exactly one place the deletion happens.
--   3. Redefines wire_approve_account so the staff row it provisions is born
--      with its account_id stamped -- future rows never rely on the username
--      fallback again.
--   4. Redefines current_staff_id() to resolve through the foreign key first
--      and the username join second, so legacy rows keep working while the
--      roster converges on the FK.
--
-- The frontend (src/views/admin.js) is refactored in the same change: both
-- delete buttons funnel through one helper that deletes via the ACCOUNT row
-- and lets this cascade remove the profile. The client no longer keeps the
-- two tables in sync by hand.
-- -----------------------------------------------------------------------------

-- -----------------------------------------------------------------------------
-- 1. The linking column.
-- -----------------------------------------------------------------------------
alter table public.staff
  add column if not exists account_id uuid;

-- Backfill once from the username match the client used to do in JavaScript.
-- Both usernames are UNIQUE in their own tables, so at most one account can
-- match a given staff row; a NULL result simply means the profile has no
-- account (a seeded roster entry) and stays NULL -- the FK permits that.
update public.staff s
   set account_id = a.id
  from public.staff_accounts a
 where s.account_id is null
   and lower(trim(s.username)) = lower(trim(a.username));

-- -----------------------------------------------------------------------------
-- 2. The foreign key, named and cascading.
--    Drop-then-add keeps the file idempotent: re-running replaces the
--    constraint instead of failing with 42710 duplicate object.
-- -----------------------------------------------------------------------------
alter table public.staff
  drop constraint if exists staff_account_id_fkey;

alter table public.staff
  add constraint staff_account_id_fkey
  foreign key (account_id) references public.staff_accounts (id)
  on delete cascade;

-- Speeds the reverse lookup ("which profile belongs to this account?") and
-- gives Postgres an index to drive the cascade from.
create index if not exists staff_account_id_idx
  on public.staff (account_id);

-- -----------------------------------------------------------------------------
-- 3. Approving an account provisions its staff row WITH the FK stamped.
--
-- Same definition as 015_approve_creates_staff_row.sql, plus account_id in
-- both the insert values and the conflict update. The conflict update also
-- repairs rows provisioned before this migration ran.
-- -----------------------------------------------------------------------------
create or replace function public.wire_approve_account(p_id uuid, p_role text default 'Writer')
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  -- DO NOT lower() this. v_role is compared below against the canonical,
  -- capitalised role names and then STORED, so lowercasing on the way in turns
  -- the client's 'Writer' into 'writer', which is not in the CHECK either, and
  -- approval dies with 'Unknown role.' The case-insensitive comparison is done
  -- against a separate lowercased copy further down, so the stored value always
  -- keeps its canonical spelling.
  v_role text := coalesce(nullif(trim(p_role), ''), 'Writer');
  v_user text;
  v_name text;
  v_was_owner boolean;
begin
  if not public.is_owner() then
    raise exception 'Only the Owner can approve accounts.';
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

  -- A pending account can never become the Owner, so there is exactly one Owner.
  -- FOUND must be set in the WHERE clause of the UPDATE, not read afterwards:
  -- when no row matches, plpgsql leaves the INTO targets untouched rather than
  -- nulling them, so a plain `if v_user is null` test would silently pass and
  -- then provision a staff row for a nonexistent account.
  update public.staff_accounts
     set status      = 'active',
         approved_at = now(),
         role        = case when is_owner then 'Owner' else v_role end
   where id = p_id
  returning username, display_name, is_owner into v_user, v_name, v_was_owner;

  if not found then
    raise exception 'Account not found.';
  end if;

  -- The stored role is authoritative, not the requested one: an account that
  -- was already the Owner keeps that, and everybody else gets v_role.
  select role into v_role from public.staff_accounts where id = p_id;
  v_was_owner := coalesce(v_was_owner, false);

  -- Provision the matching profile row, keyed to the account through the
  -- foreign key so the ON DELETE CASCADE can always find it. current_staff_id()
  -- resolves through this column first, so a newly approved account can sign
  -- in AND submit a portrait with no username matching anywhere.
  insert into public.staff (name, username, email, role, status, account_id)
  values (coalesce(nullif(v_name, ''), v_user), v_user, null, v_role, 'Active', p_id)
  on conflict (username) do update
     set role       = excluded.role,
         status     = 'Active',
         account_id = excluded.account_id;

  return jsonb_build_object(
    'id',           p_id,
    'username',     v_user,
    'display_name', v_name,
    'role',         v_role,
    'status',       'active',
    'is_owner',     (v_role = 'Owner')
  );
end;
$$;

grant execute on function public.wire_approve_account(uuid, text) to anon, authenticated;

-- -----------------------------------------------------------------------------
-- 4. Identity resolves through the foreign key first.
--
-- Same contract as 013: the caller's staff row id, or NULL. The FK arm is a
-- plain equality the planner can hash; the username arm only fires for legacy
-- rows whose account_id did not backfill (a profile with no account joins to
-- nothing in either arm, which is the correct answer).
-- -----------------------------------------------------------------------------
create or replace function public.current_staff_id()
returns uuid
language sql
stable
security definer
set search_path = public, extensions
as $$
  select s.id
    from public.staff_accounts a
    join public.staff s
      on s.account_id = a.id
      or (s.account_id is null
          and lower(trim(s.username)) = lower(trim(a.username)))
   where a.id = public.current_account_id()
     and a.status = 'active'
   limit 1;
$$;

grant execute on function public.current_staff_id() to anon, authenticated;

-- Probe resolver used only by the verification block below; it takes the
-- account id as an argument because a do-block has no bearer token for
-- current_account_id(). Created BEFORE the block that calls it.
create or replace function public.current_staff_id_for_probe(p_account uuid)
returns uuid
language sql
stable
security definer
set search_path = public, extensions
as $$
  select s.id
    from public.staff_accounts a
    join public.staff s
      on s.account_id = a.id
      or (s.account_id is null
          and lower(trim(s.username)) = lower(trim(a.username)))
   where a.id = p_account
     and a.status = 'active'
   limit 1;
$$;

grant execute on function public.current_staff_id_for_probe(uuid) to anon, authenticated;

-- -----------------------------------------------------------------------------
-- 5. Verify only. Change nothing.
-- -----------------------------------------------------------------------------
do $$
declare
  v_unlinked_active integer;
  v_missing_fk      integer;
begin
  -- The constraint must exist, be on the right column, and cascade.
  select count(*) into v_missing_fk
    from pg_constraint
   where conrelid = 'public.staff'::regclass
     and conname  = 'staff_account_id_fkey'
     and confrelid = 'public.staff_accounts'::regclass
     and pg_get_constraintdef(oid) like '%ON DELETE CASCADE%';

  if v_missing_fk <> 1 then
    raise exception 'NOT APPLIED: staff_account_id_fkey is missing or does not cascade.';
  end if;

  -- Every ACTIVE account should now resolve to a staff row. This is the same
  -- assertion 015 ended with, asked through the new FK-or-username resolver.
  select count(*) into v_unlinked_active
    from public.staff_accounts a
   where a.status = 'active'
     and public.current_staff_id_for_probe(a.id) is null;

  if v_unlinked_active > 0 then
    raise notice 'WARNING: % active account(s) still resolve to no staff row.', v_unlinked_active;
  else
    raise notice 'VERIFIED: staff_account_id_fkey is in place and every active account resolves to a staff profile.';
  end if;
end;
$$;

select
  (select count(*) from public.staff_accounts)                    as accounts,
  (select count(*) from public.staff)                             as staff_rows,
  (select count(*) from public.staff where account_id is not null) as staff_rows_linked_by_fk,
  (select count(*) from public.staff_accounts a
     where a.status = 'active'
       and not exists (select 1 from public.staff s
                        where s.account_id = a.id
                           or (s.account_id is null
                               and lower(trim(s.username)) = lower(trim(a.username))))
  )                                                               as active_without_staff_row;
