-- =============================================================================
--  028_page_scopes.sql
--  ONE ROW, ONE PAGE: credits_people gains an explicit page_scope
-- =============================================================================
--
-- THE PROBLEM THIS FIXES
--
-- Migration 024 gave the About Us page two rosters by adding a `category`
-- column, and it made "category IS NULL" mean "Credits page only". That is one
-- bit of overloaded meaning in a nullable column, and it produced two visible
-- bugs:
--
--   1. THE BLEED. `listCredits()` selects every row in the table and lets the
--      VIEW decide. So the Credits page fetched Board Members and Bylines,
--      filtered client-side, and shipped them to the browser before dropping
--      them. A reader with devtools open had every board member's name, role
--      colour, note and photo in the page source for a page they were not on.
--      Filtering in the browser is not privacy, it is a convention.
--
--   2. THE AMBIGUITY. "No category" had to mean two different things -- "not on
--      About yet" and "explicitly Credits only" -- and only one of them was
--      true. Promoting somebody to the board was also silently demoting them
--      from the Credits page, which is not what anybody meant.
--
-- THE FIX
--
-- An explicit, NOT NULL, CHECK-constrained column that says which page a row
-- belongs to. The two public pages now read with `.eq('page_scope', ...)` and
-- each page's rows are separated by the DATABASE, not by a filter in a
-- template.
--
-- WHAT CHANGES FOR THE OWNER (read this before running)
--
-- A row belongs to exactly one page. That is the point of the change, and it
-- has one visible consequence: somebody who must appear on BOTH pages is now
-- TWO rows -- one `about_us`, one `credits`. They are edited independently and
-- ordered independently, exactly as the two order columns already behaved.
--
--   credits_people
--   ├─ page_scope = 'about_us'  → category is REQUIRED  (Board Members |
--   │                                                    Behind the Bylines)
--   └─ page_scope = 'credits'   → category is NULL
--
-- BYLINE PORTRAITS ARE UNAFFECTED, DELIBERATELY
--
-- `primePortraits()` builds the byline sticker cache out of this table for
-- people who have no staff profile. If it were scoped to `credits`, every
-- reporter listed on About Us would silently lose their face next to their
-- bylines. So the portrait cache reads BOTH scopes; only the two PUBLIC PAGES
-- are filtered. See the note in src/lib/credits.js.
--
-- SAFE TO RE-RUN. Every statement is idempotent, and the backfill only touches
-- rows whose page_scope is still NULL.
--
-- RUN IT AFTER 024, NEVER BEFORE, AND NEVER RE-RUN 024 AFTERWARDS.
-- 024 still contains `create or replace function wire_credits_people_upsert(...,
-- p_about_order)` -- the NINE-argument version. 028 drops that signature and
-- creates the ten-argument one. Replaying 024 afterwards would re-create the
-- nine-argument function alongside the ten-argument one, and PostgREST resolving
-- one name to two candidates is PGRST202 "Could not find the function" on every
-- add, save and remove -- both pages dead, with no error until you press Save.
-- That is the same trap 024 walked into when it dropped the seven-argument
-- version, which is why the drop above is load-bearing rather than tidiness.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. THE COLUMN
-- -----------------------------------------------------------------------------
alter table public.credits_people
  add column if not exists page_scope text;

comment on column public.credits_people.page_scope is
  'Which public page this row belongs to. ''about_us'' = the About Us page '
  '(Board Members / Behind the Bylines). ''credits'' = the Credits page. '
  'EXACTLY ONE per row: a person who must appear on both pages is two rows. '
  'Read by both public pages, so a row never crosses over.';

-- -----------------------------------------------------------------------------
-- 2. THE BACKFILL
-- -----------------------------------------------------------------------------
-- Migration 024's rule was "category IS NULL means Credits page only", so that
-- is the rule this preserves exactly:
--
--   * a row with an About category was being rendered on /about  -> about_us
--   * every other row was being rendered on /credits           -> credits
--
-- No row is added, dropped or re-pointed. Re-running is a no-op because the
-- WHERE clause only matches rows this migration has not already classified.
update public.credits_people
   set page_scope = case when category is null then 'credits' else 'about_us' end
 where page_scope is null;

-- New rows default to the Credits page, which is the older and larger of the
-- two, and is what `addPerson()` sent before this column existed.
alter table public.credits_people
  alter column page_scope set default 'credits';

-- NOT NULL now that every row is classified. This is what turns "usually
-- filtered correctly" into "cannot be ambiguous": PostgREST can no longer return
-- a row that belongs to neither page.
alter table public.credits_people
  alter column page_scope set not null;

-- -----------------------------------------------------------------------------
-- 3. THE CONSTRAINTS
-- -----------------------------------------------------------------------------
-- Two separate constraints rather than one, so a failure names the actual
-- mistake instead of "credits_people_check".
alter table public.credits_people
  drop constraint if exists credits_people_page_scope_check;

alter table public.credits_people
  add constraint credits_people_page_scope_check
  check (page_scope in ('about_us', 'credits'));

alter table public.credits_people
  drop constraint if exists credits_people_scope_category_check;

-- THE BLEED, MADE UNREPRESENTABLE.
--
-- These two halves are the whole separation, expressed as one invariant:
--
--   about_us  =>  a category is required, because the page renders rosters
--                 under those headings and a member of neither renders nowhere.
--   credits   =>  the category MUST be null, because a leftover category is
--                 exactly the value `loadAboutRoster()` used to match on. This
--                 is the line that stops a Credits-only row from reappearing
--                 under "Board Members" if the About page's filter is ever
--                 widened by accident.
--
-- The application cannot violate this: `wire_credits_people_upsert` below
-- derives the category FROM the scope rather than trusting the two to agree.
alter table public.credits_people
  add constraint credits_people_scope_category_check
  check (
    (page_scope = 'about_us' and category is not null)
    or
    (page_scope = 'credits'  and category is null)
  );

-- -----------------------------------------------------------------------------
-- 4. THE INDEX
-- -----------------------------------------------------------------------------
-- Both public pages now open with an equality filter on page_scope and then sort,
-- so the sort columns belong in the index. The old `(category, sort_order, name)`
-- index is still correct for the About page and is left in place -- dropping it
-- would only make the About page slower.
create index if not exists credits_people_page_scope_idx
  on public.credits_people (page_scope, sort_order, name);

create index if not exists credits_people_scope_about_idx
  on public.credits_people (page_scope, category, about_order, name);

-- -----------------------------------------------------------------------------
-- 5. THE RPC, REDEFINED TO CARRY A SCOPE
-- -----------------------------------------------------------------------------
-- The old nine-argument signature is DROPPED, not overloaded. PostgREST
-- resolves an RPC name to its single candidate: two signatures sharing the name
-- is PGRST202 "Could not find the function", for every call, which is how an
-- entire Credits tab dies. This is the same trap migration 024 walked into and
-- documented, so the drop here is load-bearing, not tidiness.
drop function if exists public.wire_credits_people_upsert(uuid, text, text, text, text, text, integer, text, integer);
drop function if exists public.wire_credits_people_upsert(uuid, text, text, text, text, text, integer, text, integer, text);

create or replace function public.wire_credits_people_upsert(
  p_id         uuid,
  p_name       text,
  p_role_label text,
  p_role_color text,
  p_blurb      text,
  p_portrait   text,
  p_sort_order integer,
  p_category   text default null,
  p_about_order integer default null,
  p_page_scope text default null
)
returns public.credits_people
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row      public.credits_people;
  v_color    text;
  v_portrait text;
  v_category text;
  v_scope    text;
begin
  if not public.is_owner() then
    raise exception 'only the Owner can change the Credits page';
  end if;

  if p_name is null or length(trim(p_name)) = 0 then
    raise exception 'a name is required';
  end if;

  -- Normalise the colour here rather than trusting the browser: empty means
  -- "use the site default", anything else must be a full hex triplet.
  v_color := null;
  if p_role_color is not null and length(trim(p_role_color)) > 0 then
    v_color := lower(trim(p_role_color));
    if v_color !~* '^#[0-9a-f]{6}$' then
      raise exception 'the role colour must be a hex colour such as #1d4ed8';
    end if;
  end if;

  v_portrait := null;
  if p_portrait is not null and length(trim(p_portrait)) > 0 then
    v_portrait := left(trim(p_portrait), 600);
  end if;

  -- THE SCOPE IS DERIVED FROM WHAT THE OWNER SUBMITTED, AND THE CATEGORY IS
  -- DERIVED FROM THE SCOPE. Not the other way round, and never "trust the
  -- caller to send two arguments that agree".
  --
  --   p_page_scope = 'credits'  -> the category is CLEARED, whatever was sent.
  --   p_page_scope = 'about_us' -> the category is REQUIRED and validated.
  --
  -- So the new credits_people_scope_category_check invariant holds by
  -- construction, and a client that sends a contradictory pair gets the credits
  -- interpretation rather than a constraint violation at COMMIT time.
  --
  -- An absent scope means "leave it alone" on an update and "credits" on an
  -- insert -- see the two branches below.
  v_scope := null;
  if p_page_scope is not null and length(trim(p_page_scope)) > 0 then
    v_scope := lower(trim(p_page_scope));
    if v_scope not in ('about_us', 'credits') then
      raise exception 'unknown page scope: %', p_page_scope;
    end if;
  end if;

  -- No scope in the payload: the caller did not say, which means "leave this
  -- person's page alone". Take it from the row. An INSERT with no scope is the
  -- Credits page, which is what every add sent before this column existed.
  if v_scope is null then
    v_scope := 'credits';
    if p_id is not null then
      select page_scope into v_scope
        from public.credits_people
       where id = p_id;
      -- Null here means the row is already gone. Leave it as 'credits'; the
      -- UPDATE below matches nothing and raises the clearer error.
      if v_scope is null then
        v_scope := 'credits';
      end if;
    end if;
  end if;

  -- THE CATEGORY IS DERIVED FROM THE SCOPE, one flat branch, no nesting.
  if v_scope = 'credits' then
    v_category := null;
  else
    v_category := nullif(trim(coalesce(p_category, '')), '');
    if v_category is not null
       and v_category not in ('Board Members', 'Behind the Bylines') then
      raise exception 'unknown About Us category: %', p_category;
    end if;

    if v_category is null then
      -- An About Us row with no heading renders on the page under nothing at
      -- all, which reads as a layout bug rather than a data error. A loud
      -- message, never a silent default.
      --
      -- On an UPDATE there is a prior value to fall back to, so a caller that
      -- omits the category is not forced to resend it. On an INSERT there is
      -- none, so this is the error path.
      if p_id is null then
        raise exception 'an About Us entry needs a category: Board Members or Behind the Bylines';
      end if;
      select category into v_category
        from public.credits_people
       where id = p_id;
    end if;
  end if;

  if p_id is null then
    insert into public.credits_people
      (name, role_label, role_color, blurb, portrait_url, sort_order,
       category, about_order, page_scope)
    values
      (left(trim(p_name), 120),
       left(coalesce(nullif(trim(p_role_label), ''), 'Contributor'), 80),
       v_color,
       nullif(left(coalesce(p_blurb, ''), 300), ''),
       v_portrait,
       coalesce(p_sort_order, 100),
       v_category,
       coalesce(p_about_order, 100),
       v_scope)
    returning * into v_row;
  else
    update public.credits_people
       set name         = left(trim(p_name), 120),
           role_label   = left(coalesce(nullif(trim(p_role_label), ''), 'Contributor'), 80),
           role_color   = v_color,
           blurb        = nullif(left(coalesce(p_blurb, ''), 300), ''),
           portrait_url = coalesce(v_portrait, portrait_url),
           sort_order   = coalesce(p_sort_order, sort_order),
           -- Assigned unconditionally, unlike every other optional field: moving
           -- somebody between the two pages is a real edit, and it is the whole
           -- point of this migration. coalesce() cannot express "clear it", and
           -- a stale scope would keep a person on a page they were removed from.
           page_scope    = v_scope,
           -- Never disagrees with page_scope: v_category was derived from it.
           category     = v_category,
           about_order  = coalesce(p_about_order, about_order)
     where id = p_id
    returning * into v_row;

    if v_row.id is null then
      raise exception 'that person is no longer on the Credits page';
    end if;
  end if;

  return v_row;
end;
$$;

revoke all on function public.wire_credits_people_upsert(uuid, text, text, text, text, text, integer, text, integer, text) from public;
grant  execute on function public.wire_credits_people_upsert(uuid, text, text, text, text, text, integer, text, integer, text) to authenticated;

-- -----------------------------------------------------------------------------
-- 6. WHY THERE ARE NO "one view per page" SHORTCUTS HERE
-- -----------------------------------------------------------------------------
-- The obvious extra step is a `credits_page` view and a `credits_for_about_us`
-- view. Both were written and both were cut, for reasons worth leaving behind:
--
--   * A VIEW over a table that already has RLS either needs
--     `security_invoker = true` (PostgreSQL 15+, so it fails outright on 14 --
--     and it would fail at the END of this script, leaving the column applied
--     and the grant missing, which is the worst possible moment to discover it)
--     or it is SECURITY DEFINER and silently bypasses the RLS on
--     credits_people for every caller. The first is a portability trap and the
--     second is a data leak, so the choice was "do not ship it".
--
--   * It is also not load-bearing. The separation is already enforced in two
--     places that cannot drift: credits_people_scope_category_check makes a
--     cross-page row unrepresentable, and the client filters with
--     `.eq('page_scope', 'about_us')` / `.eq('page_scope', 'credits')`, which
--     tests/features.mjs asserts on both pages by name. A `.select('*')` on the
--     base table would have to be typed on purpose to leak anything, and a
--     reviewer reading a diff sees `.eq('page_scope', ...)` immediately.
--
--   * A view adds a second name for the same rows, and a second name is a
--     second thing that can go stale after a column is added.

-- -----------------------------------------------------------------------------
-- 7. WHAT THE OWNER SHOULD SEE AFTER RUNNING THIS
-- -----------------------------------------------------------------------------
--   select page_scope, coalesce(category,'-') as category, count(*)
--     from public.credits_people
--    group by 1, 2
--    order by 1, 2;
--
-- Expected: every 'credits' row has category '-', and every 'about_us' row has
-- a real heading. If an 'about_us' row shows '-', the backfill ran before 024
-- and that row predates the About page -- set it to 'credits' by hand.