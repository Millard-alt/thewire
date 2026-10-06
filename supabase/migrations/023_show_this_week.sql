-- 023_show_this_week.sql
-- -----------------------------------------------------------------------------
-- Paste THIS file into the Supabase SQL Editor.
--
-- One boolean on the singleton site_settings row: whether the "This Week In
-- The Pulse" band renders on the homepage. The Curation tab writes it through
-- saveCuration() (src/lib/store.js), hydrate() reads it back as
-- `show_this_week`, and public.js omits the whole <section id="weekly">
-- container from the front page when it is false.
--
-- DEFAULT TRUE IS THE POINT
--   The band shipped visible. A column default of true means every existing
--   row starts enabled the moment this file runs, and an un-patched database
--   (PostgREST omits the key entirely) is treated as enabled by the client
--   too -- see the `?? true` fallback in hydrate(). The section can therefore
--   only disappear when the Owner actively switches it off; no deploy of this
--   migration hides anything by itself.
--
-- PURE ASCII, no BOM. Every statement is idempotent, safe to run twice.
-- -----------------------------------------------------------------------------

begin;

-- 1. The column --------------------------------------------------------------

alter table public.site_settings
  add column if not exists show_this_week boolean not null default true;

commit;

-- 2. Tell PostgREST to re-read the schema ------------------------------------
-- Without this the new column is invisible to the client until the cache
-- reloads, and every settings save would fail with an unknown-column error.

notify pgrst, 'reload schema';
