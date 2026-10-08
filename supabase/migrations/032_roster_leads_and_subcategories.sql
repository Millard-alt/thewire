-- =============================================================================
--  032_roster_leads_and_subcategories.sql
--  ROSTER HIERARCHY: a sub-team under each main heading, and an explicit lead
-- =============================================================================
--
-- WHAT THIS ADDS
--
-- Two columns on `credits_people`:
--
--   sub_category  text     the team/department, free text. NULL means "no
--                          sub-team", and such a row is a direct member of the
--                          main heading with no sub-header above it.
--   is_lead       boolean  this person leads their sub-category. FALSE for
--                          almost everybody.
--
-- AND WHY THERE IS NO `main_category` COLUMN
-- ----------------------------------------
-- `credits_people.category` ALREADY IS the main category. Migration 024 added it
-- and migration 028 CHECK-constrained it to exactly ('Board Members',
-- 'Behind the Bylines'), which is precisely the two main headings the brief
-- names. It is read by both public pages, sent by the panel, and enforced by
-- `wire_credits_people_upsert`.
--
-- Adding `main_category` alongside it would give the same fact two columns with
-- two sources of truth, and the two would eventually disagree -- at which point
-- every read has to ask which one wins. So this migration reuses the column that
-- is already constrained, named for exactly this purpose, and calls it the main
-- category throughout the application code (`ABOUT_CATEGORIES`,
-- `normaliseAboutCategory`, the panel's "Main category" <select>).
--
--   credits_people
--   ├─ page_scope   'about_us' | 'credits'      (migration 028)
--   ├─ category     the MAIN category           (migrations 024 + 028)
--   ├─ sub_category the team/department         (this migration)
--   └─ is_lead      leads the sub-category      (this migration)
--
-- THE LEAD FALLBACK IS NOT IN HERE
-- ---------------------------------
-- The brief asks for: "if no member in a sub-category has is_lead = true, pick the
-- first member by display_order as the lead." That is a RENDERING decision, so it
-- lives in `resolveLead()` in src/lib/credits.js, not in a trigger and not in a
-- backfill. The database stores what the Owner said; the page decides how to
-- present a group where the Owner said nothing. A backfill would write a lie into
-- the data -- it would assert the Owner designated somebody they never ticked.
--
-- ONE LEAD PER SUB-CATEGORY IS ENFORCED, NOT ASSUMED
-- --------------------------------------------------
-- A partial unique index makes it a fact:
--
--   credits_people_one_lead_idx  on (page_scope, category, sub_category)
--                                 where is_lead
--
-- `coalesce(..., '')` is load-bearing twice over. Postgres treats NULLs as
-- DISTINCT in a unique index, so without it a NULL sub_category could hold any
-- number of leads; and it lets a group key be compared with `=` in the RPC below.
--
-- The RPC clears the previous lead BEFORE writing, so ticking somebody else off
-- does not raise a constraint violation the Owner would have to unpick -- the
-- checkbox just moves.
--
-- THE TWELVE-ARGUMENT RPC DROPS THE TEN-ARGUMENT ONE
-- ---------------------------------------------------
-- PostgREST resolves an RPC name to a SINGLE candidate. Two signatures sharing
-- the name is PGRST202 "Could not find the function" on every add, save and
-- remove -- which is exactly how 024 and 028 each killed the whole Credits tab
-- when they overloaded instead of dropping. Both older signatures are dropped
-- below; the drop is load-bearing, not tidiness.
--
-- p_sub_category AND p_is_lead HAVE DIFFERENT "ABSENT" SEMANTICS, DELIBERATELY
-- --------------------------------------------------------------------------
-- A missing RPC argument arrives as NULL, so NULL cannot mean both "leave it
-- alone" and "clear it". Each gets the honest answer for its type:
--
--   p_sub_category   NULL  -> leave it alone (coalesce keeps the stored value)
--                     ''    -> CLEAR it, i.e. put the person back in the main
--                              heading with no sub-team
--   p_is_lead        NULL  -> leave it alone. A boolean has no third state, so
--                              nothing is ambiguous here.
--
-- So the client omits `p_sub_category` when the caller never mentioned a
-- sub-category, and sends `''` when the Owner cleared the field.
--
-- RUN IT AFTER 028, AND NEVER RE-RUN 028 OR 024 AFTERWARDS.
-- 028 still contains a `create or replace` for the ten-argument
-- `wire_credits_people_upsert`; replaying it puts a second candidate beside the
-- twelve-argument one and both pages die on the next save. 024 puts back a third.
--
-- SAFE TO RE-RUN. Every statement is idempotent.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. THE COLUMNS
-- -----------------------------------------------------------------------------
alter table public.credits_people
  add column if not exists sub_category text;

alter table public.credits_people
  add column if not exists is_lead boolean;

comment on column public.credits_people.category is
  'THE MAIN CATEGORY: ''Board Members'' or ''Behind the Bylines''. Constrained by '
  'credits_people_category_check (024) and by credits_people_scope_category_check '
  '(028). There is deliberately no separate main_category column: this one already '
  'is it.';

comment on column public.credits_people.sub_category is
  'The team or department under the main category -- Writers, Designers, '
  'Photographers. NULL or '''' means the person sits directly under the main '
  'heading with no sub-header. Free text, matched case-insensitively by the '
  'client for grouping but stored as typed.';

comment on column public.credits_people.is_lead is
  'TRUE when the Owner ticked "Set as Lead of this Sub-Category". At most one per '
  '(page_scope, category, sub_category) -- see credits_people_one_lead_idx. A '
  'sub-category with nobody ticked falls back to the first member by display '
  'order at RENDER time (resolveLead in src/lib/credits.js), not here: the '
  'database stores what the Owner said, it does not guess on their behalf.';

-- Backfill, so the column is never null and `is_lead is true` has a plain
-- meaning. Everybody starts as NOT a lead, which is the state 99 rows out of 100
-- are in and the only state the renderer can resolve on its own.
update public.credits_people
   set is_lead = false
 where is_lead is null;

alter table public.credits_people
  alter column is_lead set default false;

-- NOT NULL so `where is_lead` and `where not is_lead` partition the table
-- cleanly, with no third bucket to forget about.
alter table public.credits_people
  alter column is_lead set not null;

-- -----------------------------------------------------------------------------
-- 2. THE CONSTRAINTS
-- -----------------------------------------------------------------------------
alter table public.credits_people
  drop constraint if exists credits_people_sub_category_check;

-- 60 characters, matching `role_label`. A sub-category is a word or two
-- ("Behind the Bylines", "Managing Editor"); anything longer is a blurb, and
-- `blurb` already exists.
--
-- An empty string is refused rather than stored: NULL is the single spelling of
-- "no sub-team", and the RPC turns '' into NULL before it gets here, so a stored
-- '' could only ever come from hand-written SQL and would render a blank heading.
alter table public.credits_people
  add constraint credits_people_sub_category_check
  check (sub_category is null or length(btrim(sub_category)) between 1 and 60);

-- AT MOST ONE LEAD PER SUB-CATEGORY.
--
-- The partial unique index is what makes "the lead" a single person rather than
-- a list the template has to arbitrate. It is also the reason the RPC clears the
-- incumbent first rather than after: a plain unique index is not deferrable, so
-- writing the new lead before clearing the old one would fail at COMMIT.
--
-- The key is (page_scope, category, sub_category) because a row belongs to
-- exactly one page (migration 028), so "Writers" on About Us and "Writers" on
-- Credits are different teams and must not fight over the same lead slot.
create unique index if not exists credits_people_one_lead_idx
  on public.credits_people (
    page_scope,
    coalesce(category, ''),
    coalesce(sub_category, '')
  )
  where is_lead;

-- The About page opens with an equality filter on page_scope and then sorts by
-- about_order, so it wants the sub-team in the index too. The credits page keeps
-- using credits_people_scope_about_idx / credits_people_page_scope_idx.
create index if not exists credits_people_scope_sub_idx
  on public.credits_people (page_scope, category, sub_category, about_order, name);

-- -----------------------------------------------------------------------------
-- 3. THE RPC, REDEFINED TO CARRY A SUB-TEAM AND A LEAD
-- -----------------------------------------------------------------------------
-- BOTH OLDER SIGNATURES ARE DROPPED. See the header: two candidates for one
-- PostgREST name is PGRST202 on every write, and it kills both public pages.
drop function if exists public.wire_credits_people_upsert(uuid, text, text, text, text, text, integer, text, integer, text, text);
drop function if exists public.wire_credits_people_upsert(uuid, text, text, text, text, text, integer, text, integer, text, text, boolean);

create or replace function public.wire_credits_people_upsert(
  p_id           uuid,
  p_name         text,
  p_role_label   text,
  p_role_color   text,
  p_blurb        text,
  p_portrait     text,
  p_sort_order   integer,
  p_category     text    default null,
  p_about_order  integer default null,
  p_page_scope   text    default null,
  p_sub_category text    default null,
  p_is_lead      boolean default null
)
returns public.credits_people
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row         public.credits_people;
  v_color       text;
  v_portrait    text;
  v_category    text;
  v_scope       text;
  v_sub         text;
  v_lead        boolean;
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
  -- DERIVED FROM THE SCOPE. Unchanged by this migration, and deliberately so:
  -- the scope/category invariant is enforced and tested, and re-deriving it here
  -- would be a second opinion about a rule that already has one.
  v_scope := null;
  if p_page_scope is not null and length(trim(p_page_scope)) > 0 then
    v_scope := lower(trim(p_page_scope));
    if v_scope not in ('about_us', 'credits') then
      raise exception 'unknown page scope: %', p_page_scope;
    end if;
  end if;

  if v_scope is null then
    v_scope := 'credits';
    if p_id is not null then
      select page_scope into v_scope
        from public.credits_people
       where id = p_id;
      if v_scope is null then
        v_scope := 'credits';
      end if;
    end if;
  end if;

  if v_scope = 'credits' then
    v_category := null;
  else
    v_category := nullif(trim(coalesce(p_category, '')), '');
    if v_category is not null
       and v_category not in ('Board Members', 'Behind the Bylines') then
      raise exception 'unknown About Us category: %', p_category;
    end if;

    if v_category is null then
      if p_id is null then
        raise exception 'an About Us entry needs a category: Board Members or Behind the Bylines';
      end if;
      select category into v_category
        from public.credits_people
       where id = p_id;
    end if;
  end if;

  -- THE SUB-CATEGORY, WITH ITS THREE-STATE CONTRACT MADE EXPLICIT.
  --
  --   NULL  -> the caller did not mention it: keep whatever is stored.
  --   ''    -> the Owner emptied the field: clear it, back to the main heading.
  --   'Writers' -> set it.
  --
  -- Runs of whitespace collapse to one space first, so "  Writers " and
  -- "Writers" are ONE sub-category rather than two headings that differ only in
  -- whitespace -- which is the failure mode that makes a roster look broken.
  --
  -- The 60-character cap is applied BEFORE the final trim, and the trim runs
  -- again afterwards, because cutting a long name at 60 can leave a trailing space
  -- ("Writers, Editors, Photographers, Designers and " becomes "... Designers
  -- and "). `normaliseSubCategory()` trims on the way in, so a stored trailing
  -- space would make the stored value and the value the next save sends back
  -- differ, and the person would change sub-team on an unrelated edit.
  v_sub := null;
  if p_sub_category is not null then
    v_sub := nullif(btrim(regexp_replace(p_sub_category, '\s+', ' ', 'g')), '');
    if v_sub is not null and length(v_sub) > 60 then
      v_sub := nullif(btrim(left(v_sub, 60)), '');
    end if;
  end if;

  -- TRUE means "this person leads their sub-category", FALSE means "not", and
  -- NULL means "leave it alone" -- the caller's form did not render the toggle.
  v_lead := coalesce(p_is_lead, false);

  -- MOVE THE LEAD, THEN WRITE IT.
  --
  -- One lead per sub-category is a unique index, and a plain unique index is not
  -- deferrable, so the incumbent has to be demoted BEFORE the new lead lands.
  -- Doing it here rather than surfacing a constraint violation means ticking a
  -- second box simply MOVES the lead, which is what the checkbox in the panel
  -- looks like it does.
  --
  -- The group key is (page_scope, category, sub_category), and p_id is excluded
  -- so re-saving somebody's own card does not demote them on the way past. The
  -- exclusion has to spell out the insert case: `p_id is null` is exactly when
  -- there is no row yet to skip.
  if v_lead then
    update public.credits_people
       set is_lead = false
     where page_scope = v_scope
       and coalesce(category, '')     = coalesce(v_category, '')
       and coalesce(sub_category, '') = coalesce(v_sub, '')
       and (p_id is null or id <> p_id)
       and is_lead;
  end if;

  if p_id is null then
    insert into public.credits_people
      (name, role_label, role_color, blurb, portrait_url, sort_order,
       category, about_order, page_scope, sub_category, is_lead)
    values
      (left(trim(p_name), 120),
       left(coalesce(nullif(trim(p_role_label), ''), 'Contributor'), 80),
       v_color,
       nullif(left(coalesce(p_blurb, ''), 300), ''),
       v_portrait,
       coalesce(p_sort_order, 100),
       v_category,
       coalesce(p_about_order, 100),
       v_scope,
       v_sub,
       v_lead)
    returning * into v_row;
  else
    update public.credits_people
       set name         = left(trim(p_name), 120),
           role_label   = left(coalesce(nullif(trim(p_role_label), ''), 'Contributor'), 80),
           role_color   = v_color,
           blurb        = nullif(left(coalesce(p_blurb, ''), 300), ''),
           portrait_url = coalesce(v_portrait, portrait_url),
           sort_order   = coalesce(p_sort_order, sort_order),
           page_scope   = v_scope,
           category     = v_category,
           about_order  = coalesce(p_about_order, about_order),
           -- ONLY CLEARED, NEVER UNSET. A null p_sub_category means "the caller
           -- did not mention it", so the old value is kept. An empty string
           -- reaches here as v_sub = null and DOES clear it, which is the
           -- Owner's "take this person out of Writers" action.
           --
           -- The bare column on the right-hand side is the row's current value,
           -- which is the point: it is what makes "not mentioned" mean "leave it
           -- alone" without a second query.
           sub_category = case when p_sub_category is null then sub_category else v_sub end,
           -- Same contract, opposite reason: a boolean has no "clear" state, so
           -- null is unambiguously "leave it alone".
           is_lead      = coalesce(p_is_lead, is_lead)
     where id = p_id
    returning * into v_row;

    if v_row.id is null then
      raise exception 'that person is no longer on the Credits page';
    end if;
  end if;

  return v_row;
end;
$$;

revoke all on function public.wire_credits_people_upsert(uuid, text, text, text, text, text, integer, text, integer, text, text, boolean) from public;
grant  execute on function public.wire_credits_people_upsert(uuid, text, text, text, text, text, integer, text, integer, text, text, boolean) to authenticated;

-- -----------------------------------------------------------------------------
-- 4. THE `anon` GRANT, WHICH MIGRATION 016 GOT WRONG
-- -----------------------------------------------------------------------------
-- 016 granted the SEVEN-argument upsert to `anon`, and this project has no Supabase
-- JWT, so PostgREST resolves every browser request as `anon`. Whatever the live
-- function is, `authenticated` alone has never been enough for the Owner panel
-- against this project. Re-granted here against the twelve-argument signature so
-- the panel's saves are actually authorised.
grant  execute on function public.wire_credits_people_upsert(uuid, text, text, text, text, text, integer, text, integer, text, text, boolean) to anon;

-- -----------------------------------------------------------------------------
-- 5. WHAT THE OWNER SHOULD SEE AFTER RUNNING THIS
-- -----------------------------------------------------------------------------
--   select coalesce(category,'-')        as main_category,
--          coalesce(sub_category,'-')    as sub_category,
--          count(*)                      as people,
--          count(*) filter (where is_lead) as leads
--     from public.credits_people
--    group by 1, 2
--    order by 1, 2;
--
-- Expected: `leads` is 1 or 0 on every row. Two leads in one sub-category means
-- this migration ran twice with a competing write in between, or something
-- wrote the table directly; the partial unique index should have made that
-- impossible, so investigate rather than deleting rows.
--
-- Existing rosters come through UNCHANGED: sub_category is null and is_lead is
-- false for every row, so the About page renders exactly as it did before, with
-- each main heading holding its people directly. Nothing is backfilled into a
-- sub-team, because guessing which team a person belongs to is not the database's
-- job.