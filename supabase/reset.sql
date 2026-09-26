-- ============================================================================
--  THE WIRE — RESET  (run ONCE, immediately BEFORE supabase/schema.sql)
-- ----------------------------------------------------------------------------
--  WHY THIS EXISTS
--  This Supabase project already contained an `articles` and a `top_performers`
--  table created by some other tool. Their shape was incompatible with this app:
--  `articles.id` was an integer rather than a uuid, and the columns were
--  `cap`/`dek`/`photo_url` instead of `body`/`image_url`. Because schema.sql
--  uses `create table if not exists`, it silently skipped those two tables and
--  then failed on the site_settings foreign key. The app therefore read a schema
--  it was never written for.
--
--  A full content backup was taken first (see backup/), so this drop is
--  recoverable. The only things destroyed are the 11 foreign articles and the
--  4 foreign performer rows.
--
--  WHAT IT DOES
--  Drops the app's objects and any stray leftovers, then schema.sql recreates
--  all eight tables with the correct columns, RLS enabled and 16 policies.
-- ============================================================================

-- Drop in dependency order. CASCADE takes the policies, indexes and the
-- site_settings -> articles foreign key with it.
drop table if exists public.site_settings  cascade;
drop table if exists public.audit_logs     cascade;
drop table if exists public.broadcasts     cascade;
drop table if exists public.media_assets   cascade;
drop table if exists public.assignments    cascade;
drop table if exists public.staff          cascade;
drop table if exists public.articles       cascade;
drop table if exists public.top_performers cascade;

-- The helper depends on staff, so it goes last.
drop function if exists public.is_staff() cascade;

-- Confirmation query: every table should now report "does not exist".
-- Run schema.sql next, then re-check that all eight return data.
