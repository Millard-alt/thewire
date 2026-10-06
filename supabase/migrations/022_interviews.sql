-- 022_interviews.sql
-- -----------------------------------------------------------------------------
-- Paste THIS file into the Supabase SQL Editor.
--
-- One `interviews` table with a `status` column, mirroring the articles
-- precedent in supabase/schema.sql. Deliberately NOT two tables, and NOT a
-- side table for the videos -- see "WHY ONE TABLE" and "WHY video_ids IS
-- jsonb" below.
--
-- Pure ASCII, no BOM. Every statement is idempotent, so it is safe to run twice.
--
-- WHY ONE TABLE
--   An interview is read, edited, approved and deleted exactly the way an
--   article is, and carries the same byline/ownership model. Splitting it would
--   mean re-deriving the articles approval workflow for a second entity that
--   has none of the extra structure articles do not already have.
--
-- WHY video_ids IS jsonb AND NOT THREE COLUMNS
--   video_id_1 / video_id_2 / video_id_3 would need a migration for every
--   change to the limit, and an unused slot has no way to say "this writer did
--   not attach a third video". jsonb stores only what was actually attached,
--   in order, and defaults to an empty array. The client enforces the limit of
--   3 (MAX_INTERVIEW_VIDEOS in src/lib/store.js); the CHECK below enforces it
--   again server-side, so a hand-rolled request cannot bypass it either.
--
-- WHY THE IDS ARE BARE 11-CHARACTER STRINGS
--   The client normalises every accepted URL shape (standard watch?v=, youtu.be
--   short links, /embed/, /shorts/, /live/, plus stray query and fragment junk)
--   down to the 11-character id BEFORE it writes. Storing the bare id means the
--   renderer never re-parses a URL to build an embed, and a stored value cannot
--   smuggle a hostile scheme into an <iframe src>.
--
-- STATUS VALUES ARE LOWER-CASE
--   'pending' and 'published', matching what the client stores and compares.
--   The articles table went through a case-mismatch bug (001_fix_status_case.sql)
--   because the database was seeded lower-case while the UI used title case; the
--   CHECK here pins the exact literals so the two can never drift again.
-- -----------------------------------------------------------------------------

begin;

-- 1. The table ---------------------------------------------------------------

create table if not exists public.interviews (
  id                uuid primary key default gen_random_uuid(),
  title             text        not null,
  -- The person being interviewed. Display name only; not an account.
  guest             text        not null,
  -- Their title for the byline strip, e.g. "County Governor".
  guest_role        text,
  -- The Pulse staffer who conducted the interview.
  interviewer       text,
  -- Short standfirst shown on the feed card.
  summary           text,
  -- Full copy, shown only on the detail view.
  description       text,
  -- Poster/thumbnail for the feed card.
  image_url         text,
  -- Up to three 11-character YouTube ids. See the header note.
  video_ids         jsonb       not null default '[]'::jsonb,
  -- 'pending' | 'published'. Writers submit 'pending'; the Owner either
  -- publishes directly or approves a pending submission.
  status            text        not null default 'pending',
  -- staff_accounts.id of the writer who filed it. NOT auth.users.id: this
  -- project runs its own username/password sessions, so current_account_id()
  -- resolves to staff_accounts. Same convention as articles.author_account_id.
  author_account_id uuid        references public.staff_accounts (id) on delete set null,
  -- Stamped on the transition into 'published' so the feed can order by it.
  published_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on table public.interviews is
  'Video interviews. status is ''pending'' (writer submission) or ''published''.';
comment on column public.interviews.video_ids is
  'Ordered array of at most three 11-character YouTube ids, normalised client-side.';

-- The public feed reads published rows newest first, so that is the index that
-- matters in production.
create index if not exists interviews_public_feed_idx
  on public.interviews (published_at desc nulls last, created_at desc);

-- The approval queue is a filtered slice of the same table.
create index if not exists interviews_status_idx
  on public.interviews (status, created_at desc);

create index if not exists interviews_author_idx
  on public.interviews (author_account_id)
  where author_account_id is not null;

-- 2. Constraints -------------------------------------------------------------

-- status. Lower-case literals on purpose; see the header note.
alter table public.interviews
  drop constraint if exists interviews_status_check;
alter table public.interviews
  add constraint interviews_status_check
  check (status in ('pending', 'published'));

-- video_ids: at most three bare, non-empty 11-character ids.
--
-- THE POLARITY BUG THIS REPLACES
-- The first working version of this constraint negated the wrong term:
--
--     not (video_ids @? '$[*] ? (@ like_regex "^[A-Za-z0-9_-]{11}$")')
--
-- `@?` means "does ANY element match", so that expression reads "reject the row
-- if any element is a VALID id" -- precisely backwards. It accepted a whole
-- pasted URL and rejected every correctly-normalised id, so the Owner could
-- save an interview with no videos and could not save one with any. jsonpath
-- offers no `not like_regex`, which is how the `not` got misplaced when the
-- earlier `!~` 42601 was fixed by switching to the `like_regex` spelling.
--
-- So the rule is now stated positively and needs no negation at all: count the
-- elements that ARE well-formed, and require that to equal the array length.
-- If every element is valid the counts match; if any is not, the filtered count
-- is short and the row is rejected. An empty array trivially passes.
--
-- jsonb_path_query_array is used rather than a set-returning function in a
-- subquery because Postgres rejects `subquery in check constraint` (0A000) --
-- the same wall documented for articles.extra_images in 017.
--
-- The CASE is load-bearing, not decoration. AND does not short-circuit, and
-- `like_regex` on a non-string element raises rather than returning false, so a
-- row holding e.g. `[42]` would abort the statement instead of failing the
-- constraint cleanly. Inside a CASE each WHEN is evaluated in order and only
-- until one matches, so the type guard is guaranteed to have already run.
-- Scrub any row that predates this constraint into a shape it will accept.
--
-- This MUST run BEFORE the CHECK is added below, not after. ADD CONSTRAINT
-- validates every existing row immediately, so one hand-inserted row with a null
-- video_ids -- or, far more likely now, a row saved while the inverted predicate
-- was live and therefore holding whatever the client managed to smuggle through
-- -- would abort the entire migration with 23514 and leave the table unconstrained.
-- Normalising first is what makes the ADD CONSTRAINT below safe.
--
-- It scrubs, rather than merely coalescing nulls, because the broken version of
-- this file REJECTED well-formed ids and ACCEPTED everything else. Any row that
-- got written during that window may hold a full URL or a fragment. Those
-- elements are dropped (they cannot be trusted to have been normalised) and the
-- surviving well-formed ones keep their original order.
--
-- `is distinct from` means untouched rows are not rewritten at all, so the
-- updated_at trigger does not fire across the whole table for nothing.
update public.interviews as i
   set video_ids = cleaned.value
  from (
    select k.id,
           coalesce(
             (
               select jsonb_agg(e.value order by e.ord)
                 from jsonb_array_elements(
                        -- Coalesce the array form first: jsonb_array_elements
                        -- raises 22023 on a non-array, so a null or scalar
                        -- video_ids must be replaced before it reaches here
                        -- rather than aborting the statement.
                        case
                          when jsonb_typeof(k.video_ids) = 'array'
                            then k.video_ids
                          else '[]'::jsonb
                        end
                      ) with ordinality as e(value, ord)
                where jsonb_typeof(e.value) = 'string'
                  -- #>> '{}' renders even a scalar jsonb to text, so the regex
                  -- always has a string to test. The type check above must come
                  -- first anyway: it is what guarantees no array/object element
                  -- reaches the comparison.
                  and e.value #>> '{}' ~ '^[A-Za-z0-9_-]{11}$'
             ),
             '[]'::jsonb
           ) as value
      from public.interviews k
  ) as cleaned
 where i.id = cleaned.id
   and i.video_ids is distinct from cleaned.value;

alter table public.interviews
  drop constraint if exists interviews_video_ids_check;
alter table public.interviews
  add constraint interviews_video_ids_check
  check (
    case
      when jsonb_typeof(video_ids) is distinct from 'array' then false
      when video_ids @? '$[*] ? (@.type() != "string")' then false
      when jsonb_array_length(video_ids) > 3 then false
      else jsonb_array_length(
             jsonb_path_query_array(
               video_ids,
               '$[*] ? (@ like_regex "^[A-Za-z0-9_-]{11}$")'
             )
           ) = jsonb_array_length(video_ids)
    end
  );

alter table public.interviews
  alter column video_ids set default '[]'::jsonb;

-- updated_at is maintained by a trigger rather than by the client, because a
-- client that forgets to send it leaves a row that still claims to be current.
create or replace function public.interviews_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists interviews_touch_updated_at_trg on public.interviews;
create trigger interviews_touch_updated_at_trg
  before update on public.interviews
  for each row execute function public.interviews_touch_updated_at();

-- Stamp published_at on the transition INTO 'published', and clear it when a
-- row is pulled back to 'pending'.
--
-- A trigger rather than client code because the rule is about a transition, and
-- re-saving an already-published interview must not re-stamp the date. Without
-- this, a typo fix would reorder the whole feed straight back to the top.
create or replace function public.interviews_stamp_published()
returns trigger
language plpgsql
as $$
begin
  if new.status is distinct from old.status then
    if new.status = 'published' and new.published_at is null then
      new.published_at := now();
    elsif new.status = 'pending' then
      new.published_at := null;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists interviews_stamp_published_trg on public.interviews;
create trigger interviews_stamp_published_trg
  before update on public.interviews
  for each row execute function public.interviews_stamp_published();

-- 3. RLS ----------------------------------------------------------------------

-- Public read is restricted to published rows, NOT left open.
--
-- This is the difference between an interviews table and a public noticeboard.
-- articles can afford `using (lower(status) = 'published' or is_staff())` because
-- a pending story is a draft. An interview is a recording of a named person
-- speaking on the record: if a writer files one, the Owner pulls it, and the
-- guest later withdraws consent, a permissive policy would have already shipped
-- it to every reader. The row is invisible until someone deliberately publishes
-- it.
--
-- `lower()` rather than `status = 'published'` so a row pasted by hand in title
-- case is not stranded behind a policy that will never match it.
alter table public.interviews enable row level security;

drop policy if exists interviews_public_read on public.interviews;
create policy interviews_public_read on public.interviews
  for select to anon, authenticated
  using (lower(status) = 'published' or public.is_staff());

-- Any staffer may file an interview. The client stamps author_account_id, and
-- the guard trigger below stops that being used to forge a byline.
--
-- The `status = 'pending'` arm is the whole approval workflow. Without it a
-- Writer simply sends the INSERT with status 'published' and is on the front
-- page immediately -- and interviews_publish_guard() below would not catch it,
-- because that trigger is `before update` and this row is being created, not
-- changed. The Owner is exempt so "publish directly" stays a real action: the
-- Owner's own editor sets 'published' at create time and it sticks.
drop policy if exists interviews_staff_insert on public.interviews;
create policy interviews_staff_insert on public.interviews
  for insert to anon, authenticated
  with check (
    public.is_staff()
    and (
      public.is_owner()
      or (status = 'pending' and (author_account_id is null
                                  or author_account_id = public.current_account_id()))
    )
  );

-- The Owner edits, publishes and deletes anything.
drop policy if exists interviews_owner_all on public.interviews;
create policy interviews_owner_all on public.interviews
  for all to anon, authenticated
  using (public.is_owner())
  with check (public.is_owner());

-- A Writer deletes only their own. wire_owns_article() is the articles analogue
-- (migration 007); this is the interview equivalent, written the same way --
-- SECURITY DEFINER with a fixed search_path, because the predicate reads
-- staff_accounts, which holds password hashes.
create or replace function public.wire_owns_interview(p_interview_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.interviews i
    where i.id = p_interview_id
      and i.author_account_id is not null
      and i.author_account_id = public.current_account_id()
  );
$$;
grant execute on function public.wire_owns_interview(uuid) to anon, authenticated;

drop policy if exists interviews_delete_own on public.interviews;
create policy interviews_delete_own on public.interviews
  for delete to anon, authenticated
  using (public.wire_owns_interview(id));

-- A Writer edits only their own. The `author_account_id is null` arm lets a
-- writer rescue a row filed before this migration; the trigger below stops that
-- being used to hijack a byline.
--
-- NOTE this is an UPDATE policy for every column, not just the body. A writer
-- who can edit their own pending interview can also flip `status` to
-- 'published' and put it on the front page with no review at all -- which is the
-- whole point of having a pending state. The status guard below closes that.
drop policy if exists interviews_update_own on public.interviews;
create policy interviews_update_own on public.interviews
  for update to anon, authenticated
  using (public.wire_owns_interview(id) or public.is_owner() or author_account_id is null)
  with check (public.wire_owns_interview(id) or public.is_owner() or author_account_id is null);

-- The two gaps a row-level policy cannot close. Both are about a COLUMN changing
-- or a TRANSITION happening, neither of which policy syntax can express, so both
-- are triggers -- the same conclusion migration 007 reached for the same two
-- rules on articles.

-- (a) Byline hijack. `with check` validates the NEW row, so a writer editing
--     their own interview could set author_account_id to somebody else and push
--     work onto that account -- and then no longer own it, so they could not even
--     take it back.
create or replace function public.interviews_reassign_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.author_account_id is distinct from old.author_account_id
     and not public.is_owner() then
    raise exception 'only the Owner can reassign an interview'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists interviews_reassign_guard_trg on public.interviews;
create trigger interviews_reassign_guard_trg
  before update on public.interviews
  for each row execute function public.interviews_reassign_guard();

-- (b) Self-publishing. The UPDATE policy above necessarily grants a writer write
--     access to the whole row, because policies are row-level and cannot name
--     columns. Without this guard a Writer's `update` would carry
--     `status = 'published'` and their submission would appear on the public feed
--     the instant they saved it, skipping the Owner entirely.
--
--     The rule: a non-Owner may move a row INTO 'published' only from a state
--     that was already 'published'. Any other upward move is refused. A writer
--     can therefore keep editing their own published interview (the Owner put it
--     there), and can freely move a row back to 'pending' -- pulling something
--     off the air is never the escalation this guards against.
create or replace function public.interviews_publish_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_owner() and new.status is distinct from old.status then
    if new.status = 'published' and old.status <> 'published' then
      raise exception 'only the Owner can publish an interview'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists interviews_publish_guard_trg on public.interviews;
create trigger interviews_publish_guard_trg
  before update on public.interviews
  for each row execute function public.interviews_publish_guard();

-- 4. Grants ------------------------------------------------------------------

-- PostgREST needs table grants to serve a request at all, and the browser talks
-- to this project with the `anon` key, so `anon` must be named explicitly.
-- Omitting these was the portrait-upload bug in migration 013: the policy was
-- correct, the policy never ran, because the table was never granted.
grant usage on schema public to anon, authenticated;
grant select on public.interviews to anon, authenticated;
grant insert, update, delete on public.interviews to anon, authenticated;

commit;

-- =============================================================================
--  After pasting, confirm:
--    select policyname, cmd from pg_policies
--     where schemaname = 'public' and tablename = 'interviews' order by 1;
--
--  Expected: interviews_public_read (select), interviews_staff_insert (insert),
--  interviews_owner_all (all), interviews_delete_own (delete),
--  interviews_update_own (update).
--
--  And confirm the guards are actually armed, not merely present:
--    select tgname from pg_trigger
--     where tgrelid = 'public.interviews'::regclass and not tgisinternal;
--  Expected: 4 triggers -- touch_updated_at, stamp_published, reassign_guard,
--  publish_guard.
--
--  A failure in either check is silent everywhere else: the feed simply renders
--  empty and the Owner sees no queue, with no error to trace it from.
-- =============================================================================

-- PostgREST caches the schema in memory. A brand new table is invisible to it
-- until the cache is told, which makes every select of `interviews` fail with
-- PGRST204 ("Could not find the table") even though the table exists. This
-- NOTIFY is the documented way to refresh it from inside the SQL Editor.
notify pgrst, 'reload schema';
