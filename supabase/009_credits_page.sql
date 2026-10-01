-- =============================================================================
--  MIGRATION 009 - THE CREDITS PAGE AS ITS OWN ROSTER
-- =============================================================================
--  Goal: the public Credits page lists ONLY the people the Owner has chosen to
--  put there. It is no longer derived from `staff`, so creating an account no
--  longer makes somebody appear on the page, and a person can be credited
--  without them ever having an account at all.
--
--  WHY A NEW TABLE RATHER THAN A COLUMN ON `staff`
--  `staff` holds credentials-adjacent data (e-mail, shadow address, auth id) and
--  every row in it is a login. A credits page that reads `staff` can only ever
--  show accounts, so it cannot credit a photographer, a patron or a designer who
--  never signs in. It also means the public page needs a SECURITY DEFINER view
--  purely to avoid leaking those columns. A dedicated table has none of those
--  problems: it holds only what the page shows.
--
--  WHY OWNER-ONLY IS ENFORCED HERE
--  There is NO insert/update/delete policy on this table. RLS denies by default,
--  so an anon key cannot write even one row; the only path in is the SECURITY
--  DEFINER functions below, each of which calls is_owner() first. That is what
--  makes "only the Owner can change the credits page" true with a leaked anon
--  key, not merely true in the UI.
--
--  ROLE IS FREE TEXT
--  `role_label` is plain text, not an enum, so the Owner can write any job title
--  they like. `role_color` is a hex string rendered as the badge colour, so two
--  people can share a role and a colour without either being constrained by the
--  other. Both are validated for shape only.
--
--  IDEMPOTENT: safe to paste more than once.
--  ASCII ONLY, no BOM.
-- =============================================================================

create table if not exists public.credits_people (
  id           uuid primary key default gen_random_uuid(),
  name         text        not null,
  -- Free text on purpose. Deliberately NOT a foreign key to staff.id: most
  -- people credited here will never have an account.
  role_label   text        not null default 'Contributor',
  -- '#rrggbb'. Nullable so the site default applies; never a bare colour name,
  -- because a name would have to be resolved in CSS and could drift.
  role_color   text,
  blurb        text,
  portrait_url text,
  sort_order   integer     not null default 100,
  created_at   timestamptz not null default now()
);

create index if not exists credits_people_order_idx
  on public.credits_people (sort_order, name);

alter table public.credits_people enable row level security;

-- Public read. This is a published page and the table holds nothing but what the
-- page already displays -- no e-mail, no account id, no shadow address.
drop policy if exists credits_people_public_read on public.credits_people;
create policy credits_people_public_read on public.credits_people
  for select using (true);

-- Deliberately NO insert / update / delete policies. Their absence is the
-- enforcement: RLS denies by default, so the direct PostgREST paths return
-- 42501 for every role including the Owner. Writes go through the functions.

grant select on public.credits_people to anon, authenticated;

-- -----------------------------------------------------------------------------
--  Shape checks
--
--  Kept loose deliberately. role_label must merely be non-blank text; role_color
--  must merely look like a hex colour. Constraining either to a fixed list would
--  defeat the point of the feature.
-- -----------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'credits_people_name_check'
  ) then
    alter table public.credits_people
      add constraint credits_people_name_check
      check (length(trim(name)) between 1 and 120);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'credits_people_role_label_check'
  ) then
    alter table public.credits_people
      add constraint credits_people_role_label_check
      check (length(trim(role_label)) between 1 and 80);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'credits_people_role_color_check'
  ) then
    alter table public.credits_people
      add constraint credits_people_role_color_check
      check (role_color is null or role_color ~* '^#[0-9a-f]{6}$');
  end if;
end $$;

-- -----------------------------------------------------------------------------
--  1. LIST (owner)
--  Returns the roster including any row the Owner has not finished filling in,
--  ordered, so the tab needs a single query rather than a client-side sort.
-- -----------------------------------------------------------------------------
create or replace function public.wire_credits_people_list()
returns setof public.credits_people
language sql
stable
security definer
set search_path = public
as $$
  select * from public.credits_people order by sort_order asc, name asc;
$$;

revoke all on function public.wire_credits_people_list() from public;
grant  execute on function public.wire_credits_people_list() to authenticated;

-- -----------------------------------------------------------------------------
--  2. CREATE / UPDATE (owner only)
--
--  One function for both so the client has a single call to get right. A null
--  p_id inserts; a uuid updates. `coalesce` on the optional arguments means a
--  partial update can never blank a field the caller did not mean to touch.
-- -----------------------------------------------------------------------------
create or replace function public.wire_credits_people_upsert(
  p_id         uuid,
  p_name       text,
  p_role_label text,
  p_role_color text,
  p_blurb      text,
  p_portrait   text,
  p_sort_order integer
)
returns public.credits_people
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row     public.credits_people;
  v_color   text;
  v_portrait text;
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

  if p_id is null then
    insert into public.credits_people
      (name, role_label, role_color, blurb, portrait_url, sort_order)
    values
      (left(trim(p_name), 120),
       left(coalesce(nullif(trim(p_role_label), ''), 'Contributor'), 80),
       v_color,
       nullif(left(coalesce(p_blurb, ''), 300), ''),
       v_portrait,
       coalesce(p_sort_order, 100))
    returning * into v_row;
  else
    update public.credits_people
       set name         = left(trim(p_name), 120),
           role_label   = left(coalesce(nullif(trim(p_role_label), ''), 'Contributor'), 80),
           role_color   = v_color,
           blurb        = nullif(left(coalesce(p_blurb, ''), 300), ''),
           portrait_url = coalesce(v_portrait, portrait_url),
           sort_order   = coalesce(p_sort_order, sort_order)
     where id = p_id
    returning * into v_row;

    if v_row.id is null then
      raise exception 'that person is no longer on the Credits page';
    end if;
  end if;

  return v_row;
end;
$$;

revoke all on function public.wire_credits_people_upsert(uuid, text, text, text, text, text, integer) from public;
grant  execute on function public.wire_credits_people_upsert(uuid, text, text, text, text, text, integer) to authenticated;

-- -----------------------------------------------------------------------------
--  3. DELETE (owner only)
--
--  Returns whether a row actually went. The tab uses that to distinguish
--  "removed" from "someone already removed it", which a bare 204 would hide.
-- -----------------------------------------------------------------------------
create or replace function public.wire_credits_people_delete(p_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_removed integer;
begin
  if not public.is_owner() then
    raise exception 'only the Owner can change the Credits page';
  end if;

  delete from public.credits_people where id = p_id;
  get diagnostics v_removed = row_count;
  return v_removed > 0;
end;
$$;

revoke all on function public.wire_credits_people_delete(uuid) from public;
grant  execute on function public.wire_credits_people_delete(uuid) to authenticated;

-- -----------------------------------------------------------------------------
--  4. REORDER (owner only)
--
--  One array of ids in the order they should appear, applied in a single
--  function so a half-applied order is impossible. Returns how many rows moved.
-- -----------------------------------------------------------------------------
create or replace function public.wire_credits_people_reorder(p_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_idx     integer;
  v_id      uuid;
  v_touched integer := 0;
begin
  if not public.is_owner() then
    raise exception 'only the Owner can change the Credits page';
  end if;

  if p_ids is null then
    return 0;
  end if;

  for v_idx in 1 .. array_length(p_ids, 1) loop
    v_id := p_ids[v_idx];
    update public.credits_people set sort_order = v_idx * 10 where id = v_id;
    if found then
      v_touched := v_touched + 1;
    end if;
  end loop;

  return v_touched;
end;
$$;

revoke all on function public.wire_credits_people_reorder(uuid[]) from public;
grant  execute on function public.wire_credits_people_reorder(uuid[]) to authenticated;

-- -----------------------------------------------------------------------------
--  5. ONE-TIME CARRY-OVER OF THE OLD ROSTER
--
--  The previous Credits page listed `staff` rows the Owner had ticked. Carry the
--  genuinely listed ones over so applying this does not silently empty a page
--  that is already live. Accounts that were never listed stay behind on purpose:
--  from now on the page is a list the Owner curates, not a projection of logins.
--
--  Guarded twice, deliberately:
--    * on the destination being empty, so re-running is a no-op; and
--    * on migration 005 having been applied, because staff.credits_visible
--      only exists once it has. Without the second guard, pasting 009 before
--      005 aborts the whole transaction and leaves the site with no credits
--      table at all -- strictly worse than before the paste.
--  The documented order is 005 then 009; this only means a mistake in one
--  paste cannot make things worse.
-- -----------------------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'staff'
      and column_name = 'credits_visible'
  )
  and not exists (select 1 from public.credits_people) then
    insert into public.credits_people (name, role_label, blurb, portrait_url, sort_order)
    select
      s.name,
      coalesce(nullif(s.role, ''), 'Contributor'),
      s.credits_blurb,
      s.portrait_url,
      coalesce(s.credits_order, 100)
    from public.staff s
    where s.credits_visible
      and s.portrait_status = 'approved'
    order by coalesce(s.credits_order, 100), s.name;
  end if;
end $$;

-- -----------------------------------------------------------------------------
--  6. REPORT
--  Raises a notice at the end so the SQL editor output confirms what happened.
-- -----------------------------------------------------------------------------
do $$
declare
  v_total    integer;
  v_coloured integer;
begin
  select count(*), count(role_color) into v_total, v_coloured
    from public.credits_people;
  raise notice 'credits page: % people listed (% with a custom role colour)', v_total, v_coloured;
end $$;