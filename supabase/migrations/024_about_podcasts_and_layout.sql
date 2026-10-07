-- =============================================================================
--  supabase/migrations/024_about_podcasts_and_layout.sql
--  -----------------------------------------------------------------------------
--  Three features that need schema before any client code can talk to them:
--
--    1. credits_people.category  -> the About Us page's two rosters
--    2. articles.display_order  -> manual "Latest Coverage" ordering
--    3. public.podcasts         -> the podcast table, its RLS and its bucket
--
--  IDEMPOTENT. Safe to paste twice. ASCII only, no BOM.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. ABOUT US — a category on the credits roster
-- -----------------------------------------------------------------------------
-- The About page needs the same shape of record the Credits page already has --
-- name, photo, role label, role colour, a one-line note, a sort order -- and
-- splits it across TWO rosters: "Board Members" and "Behind the Bylines".
--
-- A category column is the whole feature. A second table would mean a second
-- uploader, a second avatar fallback, a second colour picker and a second
-- delete path in the Owner panel for the same six fields, and the two pages
-- would drift apart the way three hand-maintained id lists already have in this
-- project (see the note on data-reader-view in index.html).
--
-- NULL means "Credits page only", which is what every existing row means, so the
-- Credits page keeps working untouched and the About page simply filters.
-- -----------------------------------------------------------------------------
alter table public.credits_people
  add column if not exists category text;

comment on column public.credits_people.category is
  'About Us roster: ''Board Members'' | ''Behind the Bylines'', or NULL for Credits-page-only.';

-- Constrained rather than free text: the About page renders these as section
-- headings and the Owner panel offers them as a <select>, so a typo would
-- silently produce a third bucket nothing reads.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'credits_people_category_check'
  ) then
    alter table public.credits_people
      add constraint credits_people_category_check
      check (category is null or category in ('Board Members', 'Behind the Bylines'));
  end if;
end;
$$;

-- The About page reads the same table filtered by category and ordered by
-- sort_order, so this is the index that serves it.
create index if not exists credits_people_category_idx
  on public.credits_people (category, sort_order, name);

-- -----------------------------------------------------------------------------
-- 1b. A SEPARATE ORDER FOR THE ABOUT PAGE
-- -----------------------------------------------------------------------------
-- credits_people.sort_order already orders the Credits page. Reusing it for the
-- About rosters would mean one integer serving two independent lists: promoting
-- somebody to "Board Members" would drag them to the top of the Credits page
-- too, and reordering the board would silently reshuffle a published page. That
-- is the sort of invisible coupling this project keeps paying for elsewhere.
--
-- So the About rosters get their own column, and each page reads only its own.
-- Both are nullable: a person with no explicit position sorts after those who
-- have one, by name, which is a stable and predictable fallback.
-- -----------------------------------------------------------------------------
alter table public.credits_people
  add column if not exists about_order integer;

comment on column public.credits_people.about_order is
  'Position within the person''s About Us roster. Independent of sort_order, which orders the Credits page.';

create index if not exists credits_people_about_order_idx
  on public.credits_people (category, about_order, name);

-- -----------------------------------------------------------------------------
-- 2. LATEST COVERAGE — manual display order on articles
-- -----------------------------------------------------------------------------
-- The front page ordered by date alone, which is right for a newspaper and wrong
-- for an editor: once a story is chosen for the lead it stays there until
-- something newer lands, and "order this run" is the one thing a front page
-- always needs.
--
-- NULLABLE ON PURPOSE. display_order NULL means "no manual placement", and the
-- front page sorts those by date as before. So this migration cannot rearrange
-- a live front page by itself: every existing row starts NULL, keeps its current
-- date order, and only becomes explicitly ordered once the Owner saves a layout.
-- That is the same reasoning as 023's `show_this_week boolean default true`.
--
-- The client sends a batch of ids and rewrites the whole set in one statement
-- (see wire_set_article_layout in store.js), so a sparse column with nulls
-- interspersed is the normal state, not an edge case.
-- -----------------------------------------------------------------------------
alter table public.articles
  add column if not exists display_order integer;

comment on column public.articles.display_order is
  'Manual front-page position. NULL = order by date as before. Never inferred from the byline.';

create index if not exists articles_display_order_idx
  on public.articles (display_order)
  where display_order is not null;

-- -----------------------------------------------------------------------------
-- 3. PODCASTS
-- -----------------------------------------------------------------------------
-- Audio episodes submitted by writers and published by the Owner.
--
-- status is pending | approved | rejected. Writers may only ever create a
-- 'pending' row; the approve/reject decision is the Owner's and is enforced in
-- the policies below, not just hidden in the UI.
--
-- author_account_id follows the SAME convention as articles.author_account_id and
-- interviews.author_account_id: staff_accounts.id, NOT auth.users.id. This project
-- runs its own username/password sessions, so current_account_id() resolves to
-- staff_accounts. `author_name` is a display copy taken at submission time so the
-- public page never has to join to render a byline.
--
-- duration_seconds is INTEGER SECONDS, not the 'MM:SS' string the client shows.
-- An integer is what lets the player seek, and what lets a sort or a display
-- width be computed without parsing text.
-- -----------------------------------------------------------------------------
create table if not exists public.podcasts (
  id                uuid primary key default gen_random_uuid(),
  title             text        not null,
  -- One-line standfirst for the card. 140 characters is a hard limit in the UI,
  -- so it is a hard limit here too.
  description       text,
  audio_url         text,
  -- Storage path in the `podcasts` bucket, kept so a reject can purge the file.
  -- audio_url is the public CDN URL; without the path a purge would have to
  -- parse the URL back apart.
  storage_path      text,
  duration_seconds  integer,
  status            text        not null default 'pending',
  author_account_id uuid        references public.staff_accounts (id) on delete set null,
  author_name       text        not null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint podcasts_status_check check (status in ('pending', 'approved', 'rejected')),
  constraint podcasts_title_check   check (length(trim(title)) > 0),
  constraint podcasts_author_check  check (length(trim(author_name)) > 0),
  -- Enforced here as well as in the form. A description longer than this is
  -- silently truncated by the UI, and a row written by hand would otherwise
  -- overflow every card it appears on.
  constraint podcasts_description_check
    check (description is null or length(description) <= 140),
  constraint podcasts_duration_check
    check (duration_seconds is null or duration_seconds >= 0)
);

comment on table public.podcasts is
  'Audio episodes. Writers submit ''pending''; only the Owner approves or rejects.';
comment on column public.podcasts.duration_seconds is
  'Length in whole seconds. The MM:SS the reader sees is formatted client-side.';

create index if not exists podcasts_public_feed_idx
  on public.podcasts (created_at desc)
  where status = 'approved';

create index if not exists podcasts_status_idx
  on public.podcasts (status, created_at desc);

alter table public.podcasts enable row level security;

-- Public read: approved rows only. An anon key must never be able to list the
-- approval queue by trying to read the table.
drop policy if exists podcasts_public_read on public.podcasts;
create policy podcasts_public_read on public.podcasts
  for select using (status = 'approved' or public.is_staff());

-- A writer files a submission. The WITH CHECK is the whole gate: it pins the
-- status to 'pending' on the way IN, so a crafted request cannot self-approve,
-- and it stamps the filer from the session rather than trusting a sent id.
--
-- NO ROLE CLAUSE, AND THAT IS CORRECT. This was `for insert to authenticated`,
-- which made every writer submission impossible: the project has no Supabase Auth
-- JWT, so requests arrive as `anon` and the policy matched nothing. Every other
-- working policy in this repository names anon too -- articles_* in 007,
-- interviews_* in 022. Corrected here as well as in 029 so that replaying this
-- file cannot reintroduce the bug; see 029 for the full account.
drop policy if exists podcasts_staff_submit on public.podcasts;
create policy podcasts_staff_submit on public.podcasts
  for insert
  with check (
    public.is_staff()
    and status = 'pending'
    and author_account_id = public.current_account_id()
  );

-- The Owner edits anything: the description, the title, the audio, and the
-- approve/reject decision. Writers get no UPDATE at all -- a writer who cannot
-- approve must not be able to edit an approved row either.
--
-- This is also what permits the Owner's publish-now insert, whose status is
-- 'approved' and which podcasts_staff_submit rejects on purpose. Permissive
-- policies are OR'd, so is_owner() allows it.
drop policy if exists podcasts_owner_all on public.podcasts;
create policy podcasts_owner_all on public.podcasts
  for all
  using (public.is_owner())
  with check (public.is_owner());

-- A writer may withdraw their own pending submission. Scoped to status =
-- 'pending' so it cannot be used to delete an episode that is already live.
drop policy if exists podcasts_delete_own_pending on public.podcasts;
create policy podcasts_delete_own_pending on public.podcasts
  for delete
  using (
    public.is_staff()
    and status = 'pending'
    and author_account_id = public.current_account_id()
  );

-- `anon` IS the signed-in role in this architecture: it is the name PostgREST
-- gives a request carrying no Supabase Auth session, which is all of them. RLS is
-- only consulted after these privileges, so omitting anon here refuses the insert
-- with "permission denied" before any policy is evaluated.
grant select on public.podcasts to anon, authenticated;
grant insert on public.podcasts to anon, authenticated;
grant update, delete on public.podcasts to anon, authenticated;

-- -----------------------------------------------------------------------------
-- 3b. THE CREDITS RPC, REDEFINED TO CARRY A CATEGORY
-- -----------------------------------------------------------------------------
-- Adding a parameter changes the signature, and Postgres treats a different
-- signature as an OVERLOAD rather than a replacement: `create or replace` would
-- leave the old seven-argument function in place and add a second
-- eight-argument one beside it. PostgREST would then find two candidates and
-- refuse to resolve the call. So the old signature is dropped first, by exact
-- argument types -- that drop is the point of doing it this way rather than
-- with `if not exists`.
--
-- Everything else is unchanged from 009: same owner gate, same validation, same
-- "coalesce the optional arguments so a partial update cannot blank a field"
-- behaviour. Only the category is new, and it is validated here rather than
-- trusted, because it is constrained to two values.
-- -----------------------------------------------------------------------------
drop function if exists public.wire_credits_people_upsert(uuid, text, text, text, text, text, integer);

create or replace function public.wire_credits_people_upsert(
  p_id         uuid,
  p_name       text,
  p_role_label text,
  p_role_color text,
  p_blurb      text,
  p_portrait   text,
  p_sort_order integer,
  p_category   text default null,
  p_about_order integer default null
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

  -- NULL or empty means Credits-page-only, which is what every row written
  -- before this migration means. An unrecognised value is refused rather than
  -- stored: a bad category would become a section heading on the About page
  -- that no filter matches -- a section that renders for nobody and looks like
  -- a bug rather than a data error.
  v_category := null;
  if p_category is not null and length(trim(p_category)) > 0 then
    v_category := trim(p_category);
    if v_category not in ('Board Members', 'Behind the Bylines') then
      raise exception 'unknown About Us category: %', v_category;
    end if;
  end if;

  if p_id is null then
    insert into public.credits_people
      (name, role_label, role_color, blurb, portrait_url, sort_order, category, about_order)
    values
      (left(trim(p_name), 120),
       left(coalesce(nullif(trim(p_role_label), ''), 'Contributor'), 80),
       v_color,
       nullif(left(coalesce(p_blurb, ''), 300), ''),
       v_portrait,
       coalesce(p_sort_order, 100),
       v_category,
       coalesce(p_about_order, 100))
    returning * into v_row;
  else
    update public.credits_people
       set name         = left(trim(p_name), 120),
           role_label   = left(coalesce(nullif(trim(p_role_label), ''), 'Contributor'), 80),
           role_color   = v_color,
           blurb        = nullif(left(coalesce(p_blurb, ''), 300), ''),
           portrait_url = coalesce(v_portrait, portrait_url),
           sort_order   = coalesce(p_sort_order, sort_order),
           -- Assigned unconditionally, unlike every other optional field: taking
           -- somebody OFF the About page is a legitimate edit (they keep their
           -- Credits entry) and coalesce() cannot express it.
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

revoke all on function public.wire_credits_people_upsert(uuid, text, text, text, text, text, integer, text, integer) from public;
grant  execute on function public.wire_credits_people_upsert(uuid, text, text, text, text, text, integer, text, integer) to authenticated;

-- -----------------------------------------------------------------------------
-- 3c. THE FRONT-PAGE LAYOUT
-- -----------------------------------------------------------------------------
-- One statement for the whole reorder, by id. The Owner panel drags cards into
-- an order and saves once; writing them one UPDATE at a time would be N round
-- trips and could half-apply, leaving the front page in an order nobody chose.
--
-- display_order is written as the array POSITION, so the caller sends only the
-- ids in order and never has to invent numbers. Ids that no longer exist are
-- counted but ignored rather than raising: an article deleted between opening
-- the panel and pressing Save must not cost the whole layout.
--
-- Owner-only, because this decides what the front page looks like.
-- -----------------------------------------------------------------------------
drop function if exists public.wire_set_article_layout(uuid[]);

create or replace function public.wire_set_article_layout(p_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_position integer;
  v_touched  integer := 0;
begin
  if not public.is_owner() then
    raise exception 'Only the Owner can set the front page layout.';
  end if;

  if p_ids is null or coalesce(array_length(p_ids, 1), 0) = 0 then
    return 0;
  end if;

  foreach v_position in array array(SELECT generate_subscripts(p_ids, 1)) loop
    update public.articles
       set display_order = v_position
     where id = p_ids[v_position]
       -- One row is not the Owner's to move: whatever is currently Today's Pick.
       -- Dragging it would silently repoint a curation choice.
       and id is distinct from (
             select todays_pick_id from public.site_settings where id = 1
           );

    v_touched := v_touched + 1;
  end loop;

  return v_touched;
end;
$$;

revoke all on function public.wire_set_article_layout(uuid[]) from public;
grant  execute on function public.wire_set_article_layout(uuid[]) to authenticated;

-- -----------------------------------------------------------------------------
-- updated_at, without a trigger the client has to remember to fire.
-- -----------------------------------------------------------------------------
create or replace function public.podcasts_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists podcasts_touch_updated_at_trg on public.podcasts;
create trigger podcasts_touch_updated_at_trg
  before update on public.podcasts
  for each row execute function public.podcasts_touch_updated_at();

-- -----------------------------------------------------------------------------
-- 4. STORAGE — the `podcasts` bucket
-- -----------------------------------------------------------------------------
-- A dedicated bucket rather than a folder inside wire-media, so the storage
-- policies can say "audio only" and so purging an episode can never touch a
-- portrait. public = true, because the <audio> src has to be fetchable by an
-- anonymous reader.
--
-- Idempotent: `if not exists` on the bucket, and the policies are dropped and
-- recreated so a re-paste repairs them.
-- -----------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit)
values ('podcasts', 'podcasts', true, 26214400)
on conflict (id) do update
  set public          = true,
      file_size_limit = excluded.file_size_limit;

-- file_size_limit is the REAL server-side cap, and the reason the policy below
-- carries no size expression: a policy cannot see the payload, so `octet_length(name)`
-- there would measure the OBJECT NAME and cap nothing while looking like a guard.
-- 25 MB, matching the client's ceiling.

drop policy if exists podcasts_read on storage.objects;
create policy podcasts_read on storage.objects
  for select using (bucket_id = 'podcasts');

-- Any staffer may upload an episode. The size cap is 25MB, which is roughly an
-- hour of speech at a sensible bitrate -- a spoken-word episode, not a music
-- album, which is what this is for.
drop policy if exists podcasts_upload on storage.objects;
create policy podcasts_upload on storage.objects
  for insert
  with check (
    bucket_id = 'podcasts'
    and public.is_staff()
    -- `octet_length(name)` is the length of the OBJECT NAME, not of the file.
    -- It was written here as if it capped the upload and silently capped
    -- nothing; a 200 MB MP3 passed it. The real ceiling is the 25 MB one the
    -- client enforces and the table's own validation, and Supabase enforces its
    -- own per-object limit server-side regardless -- so the honest thing here is
    -- to drop the pretend check rather than keep a comment that lies.
    --
    -- What IS worth constraining is the path: audio only lands under
    -- `episodes/`, so nothing can be written to the bucket root and a stray
    -- upload cannot sit next to the bucket's public URL space unmanaged.
    and coalesce((storage.foldername(name))[1], '') = 'episodes'
  );

-- Deletion is Owner-only. A writer withdrawing a submission removes the ROW
-- (podcasts_delete_own_pending); the FILE goes when the Owner rejects it, and
-- that is a decision about something already published.
drop policy if exists podcasts_delete on storage.objects;
create policy podcasts_delete on storage.objects
  for delete
  using (bucket_id = 'podcasts' and public.is_owner());

commit;

-- -----------------------------------------------------------------------------
-- 5. Tell PostgREST to re-read the schema
-- -----------------------------------------------------------------------------
-- Without this the new columns are invisible to the client until the cache
-- reloads, and every write fails with PGRST204 / "column does not exist".
notify pgrst, 'reload schema';

-- -----------------------------------------------------------------------------
-- Verify by hand after pasting:
--
--   -- 1. the About categories exist and are constrained
--   select category, count(*) from public.credits_people group by category;
--
--   -- 2. no article has been given a manual position yet (must be 0 rows)
--   select count(*) from public.articles where display_order is not null;
--
--   -- 3. the podcast table and its bucket
--   select count(*) from public.podcasts;
--   select id, public from storage.buckets where id = 'podcasts';
--
--   -- 4. anon cannot read the approval queue (must return 0 rows)
--   --    (run as the anon role: set local role anon; select * from podcasts;)
-- -----------------------------------------------------------------------------
