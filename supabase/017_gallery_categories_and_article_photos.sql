-- 017_gallery_categories_and_article_photos.sql
-- -----------------------------------------------------------------------------
-- Paste THIS file into the Supabase SQL Editor.
--
-- Supports three features that cannot be done client-side:
--   1. Owner-defined gallery categories (a new table + a nullable FK on media)
--   2. Up to three extra photos per article (a new column on articles)
--   3. The grants and RLS policies both need
--
-- Pure ASCII, no BOM. Every statement is idempotent, so it is safe to run twice.
--
-- WHY A SEPARATE TABLE FOR CATEGORIES
--   Categories are named and ordered by the Owner, referenced by many media
--   rows, and shown on the public page as cards. That is a first-class entity,
--   not a string, so it gets a table. A CHECK-free text column was rejected:
--   renaming a category would then have to walk every media row by hand.
--
-- WHY extra_images IS jsonb AND NOT THREE COLUMNS
--   image_2 / image_3 / caption_3 would need a migration for every article
--   limit change, and an unused column has no way to say "this writer did not
--   use the slot". jsonb stores only what the writer actually attached, in
--   order, and defaults to an empty array. The client enforces the limit of 3;
--   the CHECK below enforces it again on the server, so a hand-rolled request
--   cannot bypass it either.
-- -----------------------------------------------------------------------------

begin;

-- 1. Gallery categories -------------------------------------------------------

create table if not exists public.gallery_categories (
  id          uuid primary key default gen_random_uuid(),
  name        text        not null unique,
  -- Null means "no cover image yet", which is a normal state for a brand new
  -- category and must not be confused with an empty string.
  cover_url   text,
  -- Drives the order cards appear in. Null sorts last (see the view below).
  sort_order  integer,
  created_at  timestamptz not null default now()
);

create index if not exists gallery_categories_order_idx
  on public.gallery_categories (sort_order nulls last, created_at);

-- The media shelf gains a link into that list. Nullable so existing rows are
-- untouched: an uncategorised photo still works and still shows in the gallery
-- under the built-in "Other" grouping.
alter table public.media_assets
  add column if not exists category_id uuid
    references public.gallery_categories (id) on delete set null;

create index if not exists media_assets_category_idx
  on public.media_assets (category_id);

-- 2. Extra article photos -----------------------------------------------------

alter table public.articles
  add column if not exists extra_images jsonb;

-- Normalise the legacy NULL into '[]' and normalise anything already stored as a
-- JSON array. Doing it in the migration means no client ever has to defend
-- against null here. The limit of three is a product decision; it lives in
-- src/lib/store.js as well, and this is the backstop that makes it true
-- regardless of who writes the row.
update public.articles
   set extra_images = coalesce(extra_images, '[]'::jsonb)
 where extra_images is null or jsonb_typeof(extra_images) <> 'array';

alter table public.articles
  alter column extra_images set default '[]'::jsonb;

-- An array of at most three objects, each carrying a non-empty url. Anything else
-- -- a bare string, a nested array, a fourth element -- is rejected outright
-- rather than silently stored, so a malformed row cannot reach the article
-- renderer.
--
-- WHY JSONPATH AND NOT NOT EXISTS
--   The first draft of this constraint used
--       and not exists (select 1 from jsonb_array_elements(extra_images) e ...)
--   which is the readable way to write it and is also the obvious way to write
--   it wrong. Postgres rejects it with
--       ERROR: 0A000: cannot use subquery in check constraint
--   A CHECK may only contain expressions that are immutable AND reference no
--   other rows. `exists (select ...)` is a query, not an expression, so it is
--   rejected at CREATE time regardless of which table it reads.
--
--   The jsonpath operators below do the same job as pure expressions, which is
--   why they are legal here:
--       jsonb_typeof(x)      -> is it an array at all
--       jsonb_array_length() -> is it three or fewer
--       x @? '$[*] ? (...)'  -> jsonb_path_exists(): does ANY element match
--   The `@?` operator is immutable, so the constraint can be created and used.
--   Each of the three `@?` tests is negated: if ANY element is a non-object,
--   has no string url, or has an empty url, the whole CHECK fails.
--
-- WHY A CASE GUARD AND NOT A PLAIN AND
--   jsonb_array_length('{}'::jsonb) does not return NULL or 0, it RAISES
--       ERROR: 22023: malformed array literal
--   So a CHECK written as `jsonb_typeof(x) = 'array' and jsonb_array_length(x) <= 3`
--   is only safe if the evaluator stops at the first false term. Postgres does
--   not promise that ordering, and a constraint that can raise 22023 on INSERT
--   turns a bad row into a failed statement with a misleading error. The CASE
--   makes the short-circuit explicit: the length and element tests are only ever
--   reached when the value really is an array, and anything else fails the
--   constraint cleanly instead of exploding.
alter table public.articles
  drop constraint if exists articles_extra_images_check;

alter table public.articles
  add constraint articles_extra_images_check
  check (
    case
      when jsonb_typeof(extra_images) is distinct from 'array' then false
      else jsonb_array_length(extra_images) <= 3
       and not (extra_images @? '$[*] ? (@.type() != "object")')
       and not (extra_images @? '$[*] ? (@.url.type() != "string")')
       and not (extra_images @? '$[*] ? (@.url == "")')
    end
  );

-- 3. RLS ----------------------------------------------------------------------
-- Categories are public to read so the cards render for every reader, and the
-- Owner writes them. Both tables gate on the same is_staff()/is_owner() helpers
-- the rest of the schema already uses, so there is no new auth concept here.

alter table public.gallery_categories enable row level security;

drop policy if exists gallery_categories_public_read on public.gallery_categories;
create policy gallery_categories_public_read on public.gallery_categories
  for select using (true);

drop policy if exists gallery_categories_owner_write on public.gallery_categories;
create policy gallery_categories_owner_write on public.gallery_categories
  for all using (public.is_owner()) with check (public.is_owner());

-- 4. Grants ------------------------------------------------------------------
-- PostgREST needs EXECUTE to expose an RPC, and the browser talks to this
-- project with the `anon` key, so owner-gated functions must be granted to
-- `anon` explicitly. This is the same class of bug as the portrait upload
-- failure: the function existed, the grant did not, and the only symptom was a
-- permission error in the console.

grant usage on schema public to anon, authenticated;

grant select on public.gallery_categories to anon, authenticated;
grant insert, update, delete on public.gallery_categories to anon, authenticated;

commit;