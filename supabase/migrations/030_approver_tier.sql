-- =============================================================================
--  030_approver_tier.sql
--  A BOARD MANAGER may approve. This ADDS authority, so it is isolated here.
-- =============================================================================
--
-- READ THIS BEFORE RUNNING IT
--
-- Every other change in this workstream TAKES authority away from the weakest
-- role. This one GIVES some to the middle role, which is the opposite direction
-- and the reason it gets its own file, its own helper and its own tests rather
-- than being folded into a UI change where it would be invisible.
--
-- WHAT IT CHANGES
--
-- Before: `is_owner()` is a SEAT flag on the account (`a.is_owner`), not the
-- `role` column, so a Board Manager is not an Owner. Every approve path is an
-- ordinary row UPDATE, so `articles_update_own`, `interviews_update_own` and
-- `podcasts_owner_all` all excluded Board Managers: a Board Manager could not
-- publish, unpublish or approve anybody's work, including work that was
-- explicitly waiting for review.
--
-- After: a Board Manager may move a row between the review states. Nothing else
-- about them changes -- see the scope note at the bottom, because the temptation
-- with a policy like this is to let it drift into "can edit anything".
--
-- WHY A HELPER FUNCTION RATHER THAN INLINING THE ROLE TEST
--
-- `is_owner() or role = 'Board Manager'` written inline in five policies is five
-- chances to write it differently, and one of them will forget `status = 'active'`
-- -- which would let a SUSPENDED Board Manager approve work. One function, one
-- place to get it right.
--
-- SAFE TO RE-RUN. Every statement is idempotent.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. THE APPROVER TIER
-- -----------------------------------------------------------------------------
create or replace function public.can_approve()
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  /*
    The Owner seat, OR an Active account whose role is Board Manager.

    `status = 'active'` is not optional. Omitting it is the single most likely
    mistake in this whole migration, and the consequence is that a suspended
    Board Manager keeps approving work until someone notices -- which is the
    exact failure the Owner-only design existed to prevent.

    `is_owner()` is kept as its own arm rather than folded into a role test
    because it is a seat flag: the Owner account's `role` may be 'Writer' in
    legacy rows, and testing `role = 'Owner'` would silently strip the Owner's
    authority from exactly the accounts that predate the role vocabulary.
  */
  select public.is_owner()
      or exists (
    select 1
      from public.staff_accounts a
     where a.id = public.current_account_id()
       and a.status = 'active'
       and a.role = 'Board Manager'
  );
$$;

comment on function public.can_approve() is
  'May this session move a row between review states (approve / unpublish)? True '
  'for the Owner seat and for an Active Board Manager. False for a Writer and for '
  'any suspended account. It grants the approve DECISION and nothing else: not '
  'editing other people''s work, not deleting, not reordering the front page.';

revoke all on function public.can_approve() from public;
grant execute on function public.can_approve() to anon, authenticated;

-- -----------------------------------------------------------------------------
-- 2. ARTICLES — an approver may move a row between review states
-- -----------------------------------------------------------------------------
-- SCOPE, PRECISELY: `status` only.
--
-- The old `articles_update_own` deliberately carried an `author_account_id is
-- null` rescue arm, and its trigger refuses a change of `author_account_id`. A
-- permissive policy is OR'd with the others, so adding a broad approver policy
-- would hand a Board Manager the whole row -- including the ability to rewrite a
-- byline, which the trigger above exists to prevent and which no policy can
-- prevent on its own.
--
-- There is no "only this column" form of an UPDATE policy in Postgres, so the
-- column restriction is done the only way it can be: by granting UPDATE on that
-- one column to the approver role, and leaving the row policy alone.
drop policy if exists articles_approver_update on public.articles;
create policy articles_approver_update on public.articles
  for update to anon, authenticated
  using (public.can_approve())
  with check (public.can_approve());

grant update (status) on public.articles to anon, authenticated;

-- -----------------------------------------------------------------------------
-- 3. INTERVIEWS — same, and the same column restriction
-- -----------------------------------------------------------------------------
drop policy if exists interviews_approver_update on public.interviews;
create policy interviews_approver_update on public.interviews
  for update to anon, authenticated
  using (public.can_approve())
  with check (public.can_approve());

grant update (status) on public.interviews to anon, authenticated;

-- -----------------------------------------------------------------------------
-- 4. PODCASTS — approve or reject, Owner or Board Manager
-- -----------------------------------------------------------------------------
-- `podcasts_owner_all` is `for all` with is_owner(), and it is what lets the
-- Owner publish straight to 'approved'. A Board Manager gets a status-only path
-- instead, so they can clear the queue without inheriting the ability to edit an
-- episode's audio, rewrite its byline, or delete it.
--
-- `podcasts_delete` is deliberately NOT widened. Purging a refused episode's
-- audio is a destructive act about something already submitted for publication,
-- and the brief did not ask for it.
drop policy if exists podcasts_approver_update on public.podcasts;
create policy podcasts_approver_update on public.podcasts
  for update to anon, authenticated
  using (public.can_approve())
  with check (public.can_approve());

grant update (status) on public.podcasts to anon, authenticated;

-- -----------------------------------------------------------------------------
-- 5. STILL TRUE AFTER THIS MIGRATION
-- -----------------------------------------------------------------------------
-- Nothing below changed, and each is asserted in tests/features.mjs so a later
-- migration cannot quietly undo this one:
--
--   * A WRITER cannot approve, unpublish or delete anybody's work, including
--     their own before it is filed. `podcasts_staff_submit` still pins
--     status = 'pending' on insert, so a crafted request cannot self-approve.
--   * A WRITER cannot edit another author's row. `articles_update_own` and
--     `interviews_update_own` are untouched.
--   * ONLY THE OWNER deletes. `podcasts_delete` still requires is_owner().
--   * ONLY THE OWNER reorders the front page, renames the masthead or edits the
--     roster on About Us and Credits. None of that is in this file.
--   * A SUSPENDED account approves nothing, at any role. The `status = 'active'`
--     test inside can_approve() is what guarantees it.
--
--   The browser hides what a Writer cannot do, but hiding is not enforcement:
--   every one of those guarantees lives here, and a leaked anon key cannot reach
--   past it.

commit;

-- -----------------------------------------------------------------------------
-- 6. VERIFY (read-only, changes nothing)
-- -----------------------------------------------------------------------------
select
  (select count(*) from pg_policies
    where schemaname = 'public'
      and policyname in ('articles_approver_update',
                         'interviews_approver_update',
                         'podcasts_approver_update'))          as approver_policies,
  to_regprocedure('public.can_approve()')                        as helper_exists,
  -- Column-level grants: the restriction that stops this being "edit anything".
  (select count(*) from information_schema.column_privileges
    where table_schema = 'public'
      and table_name in ('articles', 'interviews', 'podcasts')
      and column_name = 'status'
      and grantee = 'anon'
      and privilege_type = 'UPDATE')                             as status_grants_to_anon,
  -- A full-table UPDATE grant on those tables would defeat the column grant
  -- above, because the table-level privilege is checked first. It must be 0.
  (select count(*) from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name in ('articles', 'interviews', 'podcasts')
      and grantee = 'anon'
      and privilege_type = 'UPDATE')                             as table_update_grants_to_anon;

-- Expected: approver_policies 3, helper_exists present, status_grants_to_anon 3,
-- table_update_grants_to_anon 0.
--
-- IF table_update_grants_to_anon is NOT 0, an earlier migration granted a
-- table-wide UPDATE and the column restriction above achieves nothing. In that
-- case a Board Manager CAN edit every column, and this migration needs a
-- `revoke update on ... from anon` before its column grant.