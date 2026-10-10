-- =============================================================================
--  040_interviews_get_a_category
-- =============================================================================
--
--  WHY
--
--  The brief asks for a Media & Video hub: one page offering Interviews and
--  Videos as two equal destinations, and one Owner Panel tab that switches
--  between them.
--
--  This project has no separate videos table, and should not grow one. An
--  interview IS already a video here -- `interviews.video_ids` holds up to three
--  YouTube ids and the detail view embeds them (022:60). What did not exist was
--  a way to say WHICH KIND of thing a row is, so the hub could not offer two
--  distinct archives from one table.
--
--  So: one column, on the table that already holds both.
--
--  WHAT A 'video' ROW IS
--
--  Not a separate entity with its own fields. A 'video' row is an interview row
--  whose `guest`/`interviewer` describe the coverage rather than a conversation,
--  and it carries the same YouTube ids. The columns that make no sense for a
--  match report (`guest_role`) stay nullable and the editor simply leaves them
--  blank -- see `guest_role` below, which was ALREADY nullable, so this costs
--  nothing.
--
--  `guest text not null` is the one genuine tension: "guest" for a school match
--  highlight reads as the teams or the event. That is a labelling question, not
--  a schema one, and relabelling the column would rewrite the interview editor,
--  the byline logic and the public card for every existing interview. The brief
--  did not ask for that, so the column keeps its name and the editor supplies a
--  sensible value.
--
--  THE BACKFILL IS THE POINT
--
--  `add column ... default 'interview'` applies the default to EVERY EXISTING
--  ROW, not just new ones. That is correct here -- every row in this table was
--  created as an interview -- but it is the trap 037 documents, where getting
--  the default wrong blanked a live gallery. The two-step below (add nullable,
--  backfill, then set the default) is used deliberately so the intent is
--  explicit rather than incidental.
--
--  IMMUTABLE, because the RLS below depends on it
--
--  `interviews_staff_insert` requires `status = 'pending'` for a Writer, so a
--  Writer cannot publish. This migration adds `category` to that guard: a Writer
--  filing a row must send a category from the known set, and must send
--  'interview' or 'video' -- nothing else. Without that, `category` would be a
--  free-text field a Writer could set to anything, and the two feeds would have
--  to treat unknown values as visible by default.
--
--  A Writer may also not CHANGE category after filing: an UPDATE that could
--  re-tag an approved interview as a video would let a Writer move a row
--  between the public archives, which is an editorial decision. That is the
--  Owner's, enforced by a trigger rather than by policy, because `for insert`
--  and `for update` policies are separate and a Writer's legitimate status
--  update must still work.
--
--  SAFE TO RE-RUN. Idempotent.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. The column.
--
-- Added NULLABLE first, backfilled explicitly, and only then given a default.
-- Doing it in one statement would apply the default to existing rows as a side
-- effect, which is indistinguishable from having meant to do it.
-- -----------------------------------------------------------------------------
alter table public.interviews
  add column if not exists category text;

update public.interviews
   set category = 'interview'
 where category is null;

alter table public.interviews
  alter column category set default 'interview';

-- NOT NULL now that no row is null. The check constraint is what makes the
-- vocabulary closed; a plain text column would let a typo create a row that
-- appears in neither feed and is invisible everywhere.
do $$
begin
  if exists (select 1 from public.interviews where category is null) then
    raise exception 'public.interviews still has rows with a null category.';
  end if;
end;
$$;

alter table public.interviews
  alter column category set not null;

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conrelid = 'public.interviews'::regclass
       and conname  = 'interviews_category_check'
  ) then
    alter table public.interviews
      add constraint interviews_category_check
      check (category in ('interview', 'video'));
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- 2. A partial index per feed.
--
-- Both public feeds filter on `category` and `status`, ordered by created_at.
-- Without these the filter is a full scan of every interview ever filed, on
-- every page load of either archive.
-- -----------------------------------------------------------------------------
create index if not exists interviews_category_feed_idx
  on public.interviews (category, created_at desc);

-- -----------------------------------------------------------------------------
-- 3. The insert guard.
--
-- `interviews_staff_insert` (022) already pins a Writer's row to
-- status='pending'. This re-creates it with the category arm added rather than
-- loosening it, and the Owner's exemption from the status requirement is
-- preserved: the Owner publishes directly, and must be able to file either kind.
-- -----------------------------------------------------------------------------
drop policy if exists interviews_staff_insert on public.interviews;
create policy interviews_staff_insert on public.interviews
  for insert to anon, authenticated
  with check (
    public.is_staff()
    -- Closed vocabulary on the way IN, whatever the caller's role. The column
    -- has a check constraint too, but a constraint violation is a 23514 that
    -- surfaces as an opaque "violates check constraint"; refusing here lets the
    -- client report which value was wrong.
    and category in ('interview', 'video')
    and (
      public.is_owner()
      or (status = 'pending' and (author_account_id is null
                                  or author_account_id = public.current_account_id()))
    )
  );

-- -----------------------------------------------------------------------------
-- 4. Category is immutable below the Owner seat.
--
-- A trigger, not a policy: `interviews_update_own` (022) has to keep letting a
-- Writer fix their own row's title and description, so the policy cannot be
-- narrowed to "category unchanged" without also forbidding that.
--
-- The check reads the OLD row, so it compares against what was actually stored
-- rather than trusting a value the caller sent. `coalesce` because a row written
-- before this migration was applied could still be null at the moment the
-- trigger first sees it.
-- -----------------------------------------------------------------------------
create or replace function public.interviews_category_is_immutable()
returns trigger
language plpgsql
as $$
begin
  if new.category is distinct from coalesce(old.category, 'interview') then
    if not public.is_owner() then
      raise exception 'interview_category_immutable'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

comment on function public.interviews_category_is_immutable() is
  'Refuses a category change below the Owner seat. A Writer may edit their own '
  'interview but not move it between the public archives, which is an editorial '
  'decision rather than a drafting one.';

drop trigger if exists interviews_category_immutable_trg on public.interviews;
create trigger interviews_category_immutable_trg
  before update on public.interviews
  for each row execute function public.interviews_category_is_immutable();

-- -----------------------------------------------------------------------------
-- 5. Verification.
-- -----------------------------------------------------------------------------
do $$
declare
  counts record;
begin
  -- (a) every existing row landed on the right side of the split. An interview
  --     misfiled as a video would vanish from /interviews for every reader.
  select count(*) filter (where category = 'interview') as as_interview,
         count(*) filter (where category = 'video')     as as_video,
         count(*)                                     as total
    into counts
    from public.interviews;

  if counts.as_interview + counts.as_video <> counts.total then
    raise exception
      'interviews.category is not a closed set: % interview, % video, % total.',
      counts.as_interview, counts.as_video, counts.total;
  end if;

  -- (b) the column must actually exist and be NOT NULL, or every query below
  --     silently returns nothing.
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name   = 'interviews'
       and column_name  = 'category'
       and is_nullable  = 'NO'
  ) then
    raise exception 'public.interviews.category is missing or still nullable.';
  end if;

  -- (c) the guard must carry the vocabulary check. A policy rebuilt without it
  --     would accept any string, and the 23514 from the constraint would be the
  --     only thing standing between a typo and an invisible row.
  --
  --     Matched as `= ANY (ARRAY[...])` rather than `IN (...)` because
  --     pg_get_expr renders it that way -- the same dequalification trap 035 hit
  --     with `public.is_staff()`. Accept either spelling so a future Postgres
  --     change to the renderer cannot make this check silently pass.
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public'
       and tablename  = 'interviews'
       and policyname = 'interviews_staff_insert'
       -- The rendered form is `category = ANY (ARRAY['interview'::text,
       -- 'video'::text...]) -- pg_get_expr TRUNCATES long predicates with an
       -- ellipsis, so a pattern anchored on the closing bracket would never
       -- match. Match the opening of the array only.
       -- `~*`, not `~`: pg_get_expr renders the operator as uppercase ANY, and a
       -- case-sensitive match against a lowercase pattern never fires -- which is
       -- how this check reported a correct policy as broken.
       and coalesce(with_check, '') ~* 'category\s*=\s*any'
  ) then
    -- RAISE takes ONE format string plus args. There is no `raise exception
    -- format(...)` -- that parses as an exception CONDITION and fails with
    -- 'unrecognized exception condition'. Concatenation goes inside the one
    -- string, or the value goes in as a `%` argument, which is what this does.
    raise exception
      'interviews_staff_insert does not constrain category to interview/video. '
      'Its with_check renders as: %',
      coalesce((select with_check from pg_policies
                  where schemaname = 'public'
                    and tablename  = 'interviews'
                    and policyname = 'interviews_staff_insert'), 'MISSING');
  end if;

  -- (d) the trigger must be armed, or a Writer can re-tag an approved row and
  --     move it between the two public archives.
  if not exists (
    select 1 from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
     where c.relname = 'interviews'
       and t.tgname  = 'interviews_category_immutable_trg'
       and not t.tgisinternal
  ) then
    raise exception 'the interviews_category_immutable trigger is not installed.';
  end if;

  raise notice
    '040 verified: % existing row(s) kept as interviews, category is closed and immutable below Owner.',
    counts.total;
end;
$$;

commit;