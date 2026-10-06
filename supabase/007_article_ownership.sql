-- =============================================================================
--  MIGRATION 007 - ARTICLE OWNERSHIP + WRITER-SCOPED DELETES
-- =============================================================================
--  Goal: "a Writer may delete only their own articles; the Owner may delete
--  anyone's" enforced IN THE DATABASE, so it holds even with a leaked anon key.
--
--  WHAT WAS ACTUALLY WRONG WITH DELETE
--  Two separate problems, and the first one hides the second:
--
--    1. The client showed "seed-article-N" rows that no Postgres row backed. An
--       empty articles table was being read as "no data yet", so the demo seed
--       got merged back in. Deleting one hit a guard that (correctly) refused to
--       send a text id into a uuid column, so no DELETE was ever issued and the
--       story came straight back. That part is a client bug, fixed in
--       src/lib/store.js.
--
--    2. Even with a real uuid, the policy in schema.sql was
--       "for all using (is_staff())" - ANY staffer could delete ANY article.
--       This migration is what fixes that.
--
--  THE LINK
--  articles.author_account_id points at staff_accounts.id - the account the
--  author signs in with. NOT auth.users.id: this project deliberately does not
--  use Supabase Auth, it has its own username/password sessions.
--  current_account_id() already resolves the caller from the bearer token.
--
--  IDEMPOTENT: safe to paste more than once.
--  ASCII ONLY, no BOM.
-- =============================================================================

-- -----------------------------------------------------------------------------
--  1. The column.
--
--  Nullable on purpose. Articles written before this migration have no known
--  owner, and an orphan must not become deletable by anyone - fail closed.
-- -----------------------------------------------------------------------------
alter table public.articles
  add column if not exists author_account_id uuid
  references public.staff_accounts (id) on delete set null;

comment on column public.articles.author_account_id is
  'staff_accounts.id of the author. NULL means ownership unknown; only the Owner may delete that row.';

create index if not exists articles_author_idx
  on public.articles (author_account_id)
  where author_account_id is not null;

-- -----------------------------------------------------------------------------
--  2. Ownership predicates.
--
--  The Owner test is NOT re-declared here. public.is_owner() already exists in
--  credentials.sql and is the single definition the whole application uses, so
--  this migration calls it rather than adding a second, subtly different copy.
--  Two Owner predicates that can drift apart is precisely the bug class this
--  migration exists to remove.
-- -----------------------------------------------------------------------------

-- Does the caller own this row?
--
-- SECURITY DEFINER with a fixed search_path: the predicate reads
-- staff_accounts on behalf of the caller, and that table holds password hashes
-- and e-mail addresses. Without definer rights the policy could not read it at
-- all; with an unpinned search_path a caller able to create objects in the
-- schema could shadow the table and make every row look like theirs.
create or replace function public.wire_owns_article(p_article_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.articles a
    where a.id = p_article_id
      and a.author_account_id is not null
      and a.author_account_id = public.current_account_id()
  );
$$;
grant execute on function public.wire_owns_article(uuid) to anon, authenticated;
-- -----------------------------------------------------------------------------
--  3. Replace the blanket write policy.
--
--  SELECT is deliberately left permissive: any staffer can READ any article,
--  which the newsroom needs. Only writes are scoped.
--
--  UPDATE gets its own policy because "with check" on an update only validates
--  the NEW row. Without a USING clause a writer could still edit somebody
--  else's article by id. Insert is left open to any staffer: a writer must be
--  able to file their own story, and the client stamps author_account_id.
-- -----------------------------------------------------------------------------
drop policy if exists articles_staff_write on public.articles;

create policy articles_staff_insert on public.articles
  for insert to anon, authenticated
  with check (public.is_staff());

-- The Owner edits and deletes anything.
create policy articles_owner_all on public.articles
  for all to anon, authenticated
  using (public.is_owner())
  with check (public.is_owner());

-- A Writer deletes only their own.
create policy articles_delete_own on public.articles
  for delete to anon, authenticated
  using (public.wire_owns_article(id));

-- A Writer updates only their own. The "or author_account_id is null" arm lets a
-- writer rescue an unowned row (one written before this migration); the trigger
-- below stops that being used to hijack a byline.
create policy articles_update_own on public.articles
  for update to anon, authenticated
  using (public.wire_owns_article(id) or public.is_owner() or author_account_id is null)
  with check (public.wire_owns_article(id) or public.is_owner() or author_account_id is null);

-- The one gap a policy cannot close: with check runs on the NEW row, so a writer
-- editing their own article could set author_account_id to someone else and push
-- work onto that person's byline. A trigger is used because the rule is about a
-- COLUMN changing, which row-level policies cannot express.
create or replace function public.articles_reassign_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.author_account_id is distinct from old.author_account_id
     and not public.is_owner() then
    raise exception 'only the Owner can reassign an article'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists articles_reassign_guard_trg on public.articles;
create trigger articles_reassign_guard_trg
  before update on public.articles
  for each row execute function public.articles_reassign_guard();

-- -----------------------------------------------------------------------------
--  4. Backfill ownership for rows that already exist.
--
--  Matched on author NAME, and only where a single staff_accounts row claims
-- that name. `articles.author` holds a display name; staff_accounts is the only
-- table with the password hashes, so the join has to go through it.
--
-- Deliberately NOT matched on the `staff` table: its column is `name`, not
-- `display_name`, and it is the public-facing profile table. staff_accounts is
-- the authoritative roster because it is what current_account_id() resolves to.
--
-- An ambiguous name (two accounts, same display name) matches nothing and the
-- article stays NULL, which means Owner-only. Failing closed is the safe
-- direction: guessing an owner could hand a stranger delete rights.
--
-- Articles matching no roster row are left NULL too. The result is reported so
-- a paste is never silent.
-- -----------------------------------------------------------------------------
do $$
declare
  v_matched integer;
  v_orphan  integer;
begin
  update public.articles a
     set author_account_id = resolved.account_id
    from (
      select lower(trim(coalesce(display_name, ''))) as match_name,
             -- min() over a uuid is not a thing: Postgres ships no min(uuid)
             -- aggregate, so this used to abort the whole DO block with
             --   ERROR: 42883 function min(uuid) does not exist
             -- which is why the backfill below never linked a single row.
             -- `having count(*) = 1` already guarantees one id per name, so this
             -- is a tie-break that cannot be reached -- sorting the text form is
             -- the portable way to express it. See also
             -- supabase/025_backfill_article_ownership.sql, which supersedes this
             -- backfill by joining through `staff` instead of matching a display
             -- name by exact string.
             min(id::text)::uuid        as account_id
        from public.staff_accounts
       where display_name is not null
       group by lower(trim(coalesce(display_name, '')))
      having count(*) = 1
    ) as resolved
   where a.author_account_id is null
     and lower(trim(coalesce(a.author, ''))) <> ''
     and resolved.match_name = lower(trim(coalesce(a.author, '')));

  get diagnostics v_matched = row_count;

  select count(*) into v_orphan
    from public.articles
   where author_account_id is null;

  raise notice 'articles: % row(s) given an owner, % still unowned (Owner-only)', v_matched, v_orphan;
end $$;

-- =============================================================================
--  Verify by hand after pasting:
--    select policyname, cmd from pg_policies
--     where schemaname = 'public' and tablename = 'articles' order by 1;
--    select author, author_account_id is not null as owned from public.articles;
--
--  The first output must NOT list articles_staff_write. If it still does, the
--  drop above did not take effect and every staffer can still delete everything.
-- =============================================================================

-- PostgREST caches the schema in memory. A newly added column is invisible to it
-- until the cache is told, which makes every select of `articles` fail with
-- PGRST204 ("Could not find the column") even though the column exists. This
-- NOTIFY is the documented way to refresh it from inside SQL Editor.
notify pgrst, 'reload schema';