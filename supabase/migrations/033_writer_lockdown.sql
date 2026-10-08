-- =============================================================================
--  033_writer_lockdown.sql
--  A WRITER FILES. THEY DO NOT PUBLISH, APPROVE, DELETE OR REORDER.
-- =============================================================================
--
-- THE ROLE THIS FILE IS ABOUT
--
-- The brief called it "Editor". This project has no such role: `ROLES` in
-- src/lib/auth.js and every CHECK constraint on `role` list exactly three --
-- Owner, Writer, Board Manager -- and `scripts/role-consistency.mjs` keeps
-- 'Editor' in FORBIDDEN_STORED so it can never come back. "Editor" in the brief
-- means the WRITER: the newsroom's junior editorial role, which may file content
-- and may not decide what the paper publishes. That is what this file enforces.
--
-- IT ALSO NAMES A STATUS THE BRIEF ASKED FOR AND DOES NOT USE
--
-- The brief says submissions must be saved with `status = 'pending_approval'`.
-- No such value exists, and tests/features.mjs asserts it does not. The three
-- tables use their own established vocabularies -- articles 'Pending Review' /
-- 'Published', interviews and podcasts 'pending' / 'approved' -- and the
-- requirement is honoured in substance rather than in spelling: a Writer's
-- submission always lands in the NOT-LIVE state, and only the Owner or a Board
-- Manager can move it out. Renaming a status column across three tables, the RLS
-- policies, the JS status maps, the admin badges and every test that asserts the
-- current literals would be churn that changes no behaviour a reader can see.
--
-- FIVE HOLES, ALL OF WHICH WERE OPEN ON A PREVIOUS BUILD
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 0. THE APPROVER TIER, RESTATED — SO THIS FILE RUNS STANDING ALONE
-- -----------------------------------------------------------------------------
-- WHY THIS SECTION EXISTS
-- -----------------------
-- The first attempt at this migration failed with:
--
--     ERROR:  42883: function public.can_approve() does not exist
--
-- `can_approve()` is defined in migration 030, which had never been applied to
-- the database -- and, worse, which the CHANGELOG's "Pending" list did not
-- mention at all. So the documented run order said "028, then 029, then 032,
-- then 033", 033 was run after exactly that, and it could not work. A migration
-- whose dependency is not listed as a dependency is not a dependency anyone will
-- honour.
--
-- The whole file is in one transaction, so that failure rolled back cleanly and
-- left nothing half-applied. This section is what stops it happening twice: 033
-- now carries the approver tier itself, identically to 030, so it can be run on
-- its own. `create or replace function` and `drop/create policy` are both
-- idempotent, so running 030 AFTER this file is equally harmless -- the
-- definitions are byte-identical, so whichever runs last changes nothing.
--
-- This is the same decision already taken for `wire_default_permissions()` in
-- section 6, for the same reason: a fresh install should be correct from the
-- earliest migration, and an existing one should not have to guess.
--
-- WHAT IS AND IS NOT RESTATED
-- 030 also repaired the podcast RLS that 029 got wrong, but that is a SEPARATE
-- file with a SEPARATE failure mode and it does not depend on anything here, so
-- 033 does not absorb it. If a podcast submission is refused, the cause is 029,
-- not this file.
create or replace function public.can_approve()
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
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
  'May this session move a row between review states? The Owner seat, or an '
  'ACTIVE Board Manager. Grants the approve DECISION and nothing else.';

revoke all on function public.can_approve() from public;
grant execute on function public.can_approve() to anon, authenticated;

-- The three status-only update policies. Without them a Board Manager has no
-- path to approve anything: 030's whole point is that an approver's authority is
-- granted by POLICY and bounded by the guard trigger in section 4.
drop policy if exists articles_approver_update on public.articles;
create policy articles_approver_update on public.articles
  for update to anon, authenticated
  using (public.can_approve())
  with check (public.can_approve());
grant update (status) on public.articles to anon, authenticated;

drop policy if exists interviews_approver_update on public.interviews;
create policy interviews_approver_update on public.interviews
  for update to anon, authenticated
  using (public.can_approve())
  with check (public.can_approve());
grant update (status) on public.interviews to anon, authenticated;

drop policy if exists podcasts_approver_update on public.podcasts;
create policy podcasts_approver_update on public.podcasts
  for update to anon, authenticated
  using (public.can_approve())
  with check (public.can_approve());
grant update (status) on public.podcasts to anon, authenticated;

-- -----------------------------------------------------------------------------
-- 1. ARTICLES HAD NO PUBLISH GUARD AT ALL
-- -----------------------------------------------------------------------------
-- THE WORST OF THE FIVE, AND THE ONE NOBODY WAS LOOKING FOR
--
-- `interviews_publish_guard()` exists because a Writer's `articles_update_own`-
-- style policy gives them the whole row. The articles table never got the
-- equivalent. So the sequence was:
--
--     insert  articles (..., status = 'Pending Review')   -- files a draft
--     update  articles set status = 'Published' where id = <own row>
--
-- ...and the draft went live, skipping the Owner entirely. `articles_staff_insert`
-- pins nothing about status either, so a Writer could skip the draft as well and
-- INSERT straight to 'Published'.
--
-- Interviews solved this with a BEFORE UPDATE trigger. Articles now solve it the
-- same way, which is the point of copying the pattern rather than inventing one.
--
-- THE RULE: a non-approver may move a row INTO 'Published' only from a state that
-- was already 'Published'. Any upward move is refused. A Writer can therefore keep
-- editing their own published article -- the Owner put it there -- and can freely
-- take one back to 'Pending Review', because pulling something off the air is
-- never the escalation this guards against.
create or replace function public.articles_publish_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.can_approve() then
    return new;
  end if;

  if new.status is distinct from old.status then
    if new.status = 'Published' and old.status <> 'Published' then
      raise exception 'only the Owner or a Board Manager can publish an article'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

comment on function public.articles_publish_guard() is
  'Refuses a Writer moving a row INTO ''Published''. Articles had no publish guard '
  'at all, so a Writer could set status = ''Published'' on their own draft and put '
  'it on the front page, or INSERT straight to ''Published'' and skip the draft. '
  'Mirrors interviews_publish_guard().';

drop trigger if exists articles_publish_guard_trg on public.articles;
create trigger articles_publish_guard_trg
  before update on public.articles
  for each row execute function public.articles_publish_guard();

-- -----------------------------------------------------------------------------
-- 2. ARTICLES CANNOT BE INSERTED LIVE BY A WRITER
-- -----------------------------------------------------------------------------
-- The insert half of hole 1. `articles_staff_insert` was `with check (is_staff())`
-- -- no condition on status at all, so the CHECK constraint's four allowed values
-- were reachable by anyone who filed a story.
--
-- This is the same shape as `interviews_staff_submit`: pin the status, pin the
-- filer. `articles_owner_all` is a permissive policy and policies are OR-ed, so
-- the Owner keeps the ability to publish straight from the Content desk.
drop policy if exists articles_staff_insert on public.articles;

create policy articles_staff_insert on public.articles
  for insert to anon, authenticated
  with check (
    public.is_staff()
    and (
      public.can_approve()
      or (
        status = 'Pending Review'
        and (
          author_account_id is null
          or author_account_id = public.current_account_id()
        )
      )
    )
  );

comment on policy articles_staff_insert on public.articles is
  'A Writer may file a story, and only as a draft they own. can_approve() covers '
  'the Owner and an Active Board Manager, who may still publish straight from the '
  'Content desk.';

-- -----------------------------------------------------------------------------
-- 3. THE UNOWNED-ROW RESCUE ARM IS CLOSED
-- -----------------------------------------------------------------------------
-- `articles_update_own` and `interviews_update_own` both carried
--
--     or author_account_id is null
--
-- described as a rescue for rows written before migration 007 existed. In
-- practice it is not a rescue, it is a hole: `author_account_id is null` matches
-- EVERY unowned row in the table, so a Writer could update any of them. The
-- reassign trigger only stops them from TAKING a byline, not from rewriting the
-- text of a story that belongs to somebody else.
--
-- The seeded front page is unowned. So on any previous build a Writer could open
-- the Content desk and edit the paper's own seeded articles -- which is exactly
-- what "Editors cannot edit other authors' articles" forbids.
--
-- The arm is not deleted, it is GONE. `can_approve()` is deliberately NOT added
-- here: `articles_approver_update` from 030 is a separate permissive policy and
-- policies are OR-ed, so an approver already has row access to every row through
-- that one. Writing it into this policy too would be a second copy of the same
-- grant, and the second copy is the one somebody edits next year.
--
-- The Owner keeps the ability to adopt an orphan, through `articles_owner_all`.
drop policy if exists articles_update_own on public.articles;

create policy articles_update_own on public.articles
  for update to anon, authenticated
  using (
    public.wire_owns_article(id)
    or public.is_owner()
  )
  with check (
    public.wire_owns_article(id)
    or public.is_owner()
  );

drop policy if exists interviews_update_own on public.interviews;

create policy interviews_update_own on public.interviews
  for update to anon, authenticated
  using (
    public.wire_owns_interview(id)
    or public.is_owner()
  )
  with check (
    public.wire_owns_interview(id)
    or public.is_owner()
  );

comment on policy articles_update_own on public.articles is
  'A Writer updates only their own row. The former `author_account_id is null` '
  'rescue arm is gone: it matched EVERY unowned row, including the seeded front '
  'page, so a Writer could rewrite the paper''s own articles.';

-- -----------------------------------------------------------------------------
-- 4. THE APPROVER GRANT WAS COLUMN-RESTRICTED ON PAPER AND NOT IN FACT
-- -----------------------------------------------------------------------------
-- WHAT MIGRATION 030 INTENDED
-- 030 grants `update (status)` and says so loudly, and its own footer warns:
-- "IF table_update_grants_to_anon is NOT 0 ... a Board Manager CAN edit every
-- column, and this migration needs a `revoke update on ... from anon`."
--
-- WHAT IS ACTUALLY THERE
-- A table-wide UPDATE for `anon` was granted three times:
--
--     supabase/credentials.sql:543-552   grant select, insert, update, delete
--                                         on public.articles
--     supabase/migrations/022:403        grant insert, update, delete
--                                         on public.interviews
--     supabase/migrations/029:71         grant update, delete
--                                         on public.podcasts
--
-- Postgres checks the TABLE privilege before the COLUMN privilege, so on any
-- database where those three ran, the column restriction in 030 is inert and a
-- Board Manager can rewrite a byline, an `author_account_id`, or a
-- `display_order` -- the last of which is the front page's coverage order, which
-- `wire_set_article_layout` restricts to the Owner for good reason.
--
-- WHY THIS IS A TRIGGER AND NOT THE `revoke` 030 ASKED FOR
-- ------------------------------------------------------------------
-- Do NOT `revoke update on public.articles from anon`. These table-wide grants
-- are load-bearing for the OWNER: the Owner's Content desk edits an article with
-- a plain `.update()`, through `articles_owner_all`. Revoking the table privilege
-- would remove the Owner's ability to edit an article at all, because RLS decides
-- WHICH ROWS are visible and grants decide WHICH COLUMNS -- and revoking the
-- column leaves the Owner with no path except a SECURITY DEFINER function this
-- project would then need for every write in three tables.
--
-- So the restriction is enforced where it can be, in a trigger, which is exactly
-- how the two existing column-level rules in this project are enforced
-- (`articles_reassign_guard`, `interviews_reassign_guard`). The table grant
-- stays; the MEANING of having it narrows.
--
-- THE TEST IS DIFFERENTIAL, NOT A COLUMN LIST
-- `to_jsonb(new) - 'status' - 'updated_at'` compares EVERY remaining column at
-- once, including any column a future migration adds. Enumerating the columns
-- instead would make this guard silently weaker with every new column, which is
-- the exact failure mode of a hand-maintained list.
--
-- THE OWN-AUTHOR CARVE-OUT IS DELIBERATE
-- The guard skips the row when the approver IS its author. Otherwise a Board
-- Manager could not edit their own draft, which "you may edit what you filed" has
-- to mean for every role above the floor. `articles_update_own` already permits
-- that; this guard is about the rows they do not own.
-- THE PARAMETER LIST IS EMPTY, AND THAT IS NOT AN OMISSION.
-- A `returns trigger` function may not declare arguments at all:
--
--     ERROR: 42P13: trigger functions cannot have declared arguments
--     HINT: The arguments of the trigger can be accessed through
--           TG_NARGS and TG_ARGV instead.
--
-- The first version of this took `p_table text` and passed 'articles',
-- 'interviews' and 'podcasts' at trigger creation, to document which table each
-- trigger belonged to. The body never read it, so it was documentation supplied
-- through a channel that does not exist. The table is identified by `new` and
-- `old`, which a trigger receives regardless, so nothing is lost.
--
-- The `drop ... (text)` below is not paranoia about THIS version failing: it
-- cannot have been created, because the compile fails. It is for a database where
-- an earlier attempt landed some statements outside the transaction -- and
-- without it, a stale `(text)` variant and the new `()` variant would COEXIST as
-- an overload, which is the same trap migration 024 and 030 each walked into.
drop function if exists public.wire_approver_scope_guard(text);

create or replace function public.wire_approver_scope_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.can_approve() or public.is_owner() then
    return new;
  end if;

  -- Their own row: ordinary authorship rules apply, not the approver rules.
  if new.author_account_id is not null
     and new.author_account_id = public.current_account_id() then
    return new;
  end if;

  if (to_jsonb(new) - 'status' - 'updated_at')
     is distinct from (to_jsonb(old) - 'status' - 'updated_at') then
    raise exception
      'an approver may change the review status of a row and nothing else; use the Owner seat to edit this content'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function public.wire_approver_scope_guard(text) is
  'Enforces migration 030''s "status only" intent, which its column grant could not '
  'deliver because credentials.sql / 022 / 029 each grant a table-wide UPDATE to '
  'anon and Postgres checks the table privilege first. Compares every column except '
  'status and updated_at, so a column added later cannot slip past it.';

revoke all on function public.wire_approver_scope_guard() from public;
grant execute on function public.wire_approver_scope_guard() to anon, authenticated;

drop trigger if exists articles_approver_scope_trg on public.articles;
create trigger articles_approver_scope_trg
  before update on public.articles
  for each row execute function public.wire_approver_scope_guard();

drop trigger if exists interviews_approver_scope_trg on public.interviews;
create trigger interviews_approver_scope_trg
  before update on public.interviews
  for each row execute function public.wire_approver_scope_guard();

drop trigger if exists podcasts_approver_scope_trg on public.podcasts;
create trigger podcasts_approver_scope_trg
  before update on public.podcasts
  for each row execute function public.wire_approver_scope_guard();

-- -----------------------------------------------------------------------------
-- 5. THE INTERVIEW PUBLISH GUARD STILL SAID "only the Owner"
-- -----------------------------------------------------------------------------
-- Migration 030 added `interviews_approver_update` so a Board Manager could clear
-- the queue. It then left the trigger from 022 standing, which tests
-- `not public.is_owner()` -- so a Board Manager approving an interview was
-- refused with 42501 "only the Owner can publish an interview". The approver tier
-- worked for articles and podcasts, which have no publish guard, and was dead for
-- interviews, which has one.
--
-- The rule is now can_approve(), matching `articles_publish_guard()` above, and
-- the message names both roles so an approver who is refused for some OTHER reason
-- is not sent looking for a permission they already have.
create or replace function public.interviews_publish_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.can_approve() then
    return new;
  end if;

  if new.status is distinct from old.status then
    if new.status = 'published' and old.status <> 'published' then
      raise exception 'only the Owner or a Board Manager can publish an interview'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

comment on function public.interviews_publish_guard() is
  'Refuses a Writer moving a row INTO ''published''. Widened from is_owner() to '
  'can_approve() by migration 033: the trigger from 022 tested not is_owner(), so '
  'the Board Manager approver tier added by 030 could never publish an interview.';

-- -----------------------------------------------------------------------------
-- 6. THE CAPABILITY MAP, WHICH WAS DESCRIBING A MODEL THAT WAS NOT THE MODEL
-- -----------------------------------------------------------------------------
-- `wire_default_permissions()` is the server's statement of what each role may do,
-- and it granted `"publish": true` to a Writer. So the Owners reading the Accounts
-- tab were shown a permission table that said a Writer could publish anything,
-- while every RLS policy, both guard triggers and every button in the panel said
-- the opposite. `ROLE_CAPABILITIES` in src/views/admin.js -- the same table, shown
-- to the Owner in that tab -- had the same two wrong answers.
--
-- A capability map that overstates a role is worse than one that is absent: it is
-- read as documentation of what the database will do, and the database will not.
--
-- `006_roles_and_privileges.sql` is edited in place with the same values, so a
-- FRESH install is correct from 006 onward. This statement is what corrects a
-- database where 006 has already run, which is the one that matters today.
create or replace function public.wire_default_permissions(p_role text)
returns jsonb
language sql
immutable
as $$
  select case p_role
    when 'Owner' then '{"publish":true,"edit_others":true,"broadcast":true,"media":true,"manage_staff":true,"approve_portraits":true,"edit_credits":true}'::jsonb
    -- publish:true -- a Board Manager IS an approver (can_approve()).
    -- edit_others:FALSE -- migration 033 section 4 narrowed them to `status`.
    when 'Board Manager' then '{"publish":true,"edit_others":false,"broadcast":true,"media":true,"manage_staff":false,"approve_portraits":true,"edit_credits":true}'::jsonb
    -- publish:FALSE -- a Writer files a draft and it waits for an approver.
    when 'Writer' then '{"publish":false,"edit_others":false,"broadcast":false,"media":true,"manage_staff":false,"approve_portraits":false,"edit_credits":false}'::jsonb
    -- 'Editor' remains an ALIAS for 'Writer', never a tier. An account carrying
    -- the old spelling must resolve to the same answer as its canonical name, and
    -- this branch is the only thing standing between them and the all-false
    -- default -- which is why both rows here are byte-identical.
    when 'Editor' then '{"publish":false,"edit_others":false,"broadcast":false,"media":true,"manage_staff":false,"approve_portraits":false,"edit_credits":false}'::jsonb
    else '{"publish":false,"edit_others":false,"broadcast":false,"media":false,"manage_staff":false,"approve_portraits":false,"edit_credits":false}'::jsonb
  end;
$$;

comment on function public.wire_default_permissions(text) is
  'What each role may do. Migration 033 corrected two entries: a Writer does NOT '
  'publish (publish was true), and a Board Manager does NOT edit other people''s '
  'content (edit_others was true). Must agree with ROLE_CAPABILITIES in '
  'src/views/admin.js, which is the same table shown to the Owner.';

-- -----------------------------------------------------------------------------
-- 7. WHAT IS STILL TRUE, AND WHAT IS NOT
-- -----------------------------------------------------------------------------
-- A WRITER may: file an article, an interview and a podcast; edit their own rows;
-- take their own published work back down to a draft; delete their own pending
-- podcast.
--
-- A WRITER may NOT: publish anything, approve anything, unpublish anybody's work,
-- edit or delete anybody else's row, touch an unowned row, or change
-- `display_order` on any content.
--
-- A BOARD MANAGER may additionally: move any row between review states, and
-- nothing else about it.
--
-- ONLY THE OWNER may: edit any row's content, delete a published row, purge
-- podcast audio, set the front page coverage order, or edit the roster.
--
-- THE CLIENT IS NOT THE ENFORCEMENT. `visibleTabs()`, the disabled attributes and
-- the disabled buttons in src/views/admin.js are convenience, and every one of the
-- guarantees above lives in this file, where a leaked anon key cannot reach past it.
-- A hidden control is not a control that cannot be pressed.

commit;

-- -----------------------------------------------------------------------------
-- 8. VERIFY (read-only, changes nothing)
-- -----------------------------------------------------------------------------
select
  (select count(*) from pg_trigger
    where tgname in ('articles_publish_guard_trg',
                     'articles_approver_scope_trg',
                     'interviews_approver_scope_trg',
                     'podcasts_approver_scope_trg',
                     'interviews_publish_guard_trg'))              as guard_triggers,
  (select count(*) from pg_policies
    where schemaname = 'public'
      and policyname in ('articles_staff_insert',
                         'articles_update_own',
                         'interviews_update_own'))                as rewritten_policies,
  -- A WRITER SELF-PUBLISHES IF THIS IS 0. `articles_staff_insert` must still
  -- PIN the status; if the phrase ever stops appearing, a Writer can INSERT
  -- straight to 'Published' again.
  (select count(*) from pg_policies
    where schemaname = 'public'
      and policyname = 'articles_staff_insert'
      and with_check like '%Pending Review%')                    as status_pinned_inserts,
  -- 030 asked for this and it is STILL NOT 0 -- deliberately, see section 4. The
  -- guard triggers above are what narrow the meaning of the table grant.
  (select count(*) from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name in ('articles', 'interviews', 'podcasts')
      and grantee = 'anon'
      and privilege_type = 'UPDATE')                             as table_update_grants_to_anon;

-- Expected: guard_triggers 5, rewritten_policies 3, status_pinned_inserts 1,
-- table_update_grants_to_anon 3.
--
-- That last number is 3 and is EXPECTED. Migration 030 expected 0 and said to
-- revoke; doing so would have taken the Owner's ability to edit an article, which
-- section 4 explains. Do not "fix" it by revoking -- fix it by understanding that
-- the guard triggers, not the grant, are what scope an approver.