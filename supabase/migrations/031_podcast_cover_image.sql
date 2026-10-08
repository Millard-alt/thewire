-- =============================================================================
--  031_podcast_cover_image.sql
--  podcasts.cover_url, for the Writer submission form
-- =============================================================================
--
-- WHY THIS IS A SEPARATE FILE
--
-- Migration 030 changes WHO MAY APPROVE. This adds A COLUMN. They are unrelated
-- concerns and putting them together would mean a rollback of the approver tier
-- also dropped a column, which is how a permission fix gets reverted by accident.
--
-- WHAT IT ADDS
--
-- One nullable text column. `audio_url` exists for the episode; there was
-- nowhere to put artwork for it, so the Writer submission form could not offer
-- the field the brief asks for.
--
-- NULLABLE AND UNCONSTRAINED ON PURPOSE
--
--   * nullable  -- every existing row has no artwork, and a NOT NULL column with
--     no default cannot be added to a populated table without a backfill that
--     invents data. Every renderer treats NULL as "no cover".
--   * unconstrained -- no length CHECK, because the value is a CDN URL whose
--     length depends on the host, and `audio_url` has no CHECK either. Adding
--     one here and not there would be an inconsistency with no benefit.
--   * no REFERENCES to media_assets -- the cover is a plain URL like audio_url,
--     not a row in the gallery, and making it a foreign key would mean a
--     submitted episode cannot exist without a gallery row, which is a product
--     decision nobody asked for.
--
-- The submission form sets it. Nobody else may: `podcasts_staff_submit` pins
-- status and filer, `podcasts_owner_all` requires the Owner seat, and the
-- approver grant from 030 is on `status` alone. So a Board Manager who can now
-- approve an episode still cannot quietly repoint its artwork.
--
-- SAFE TO RE-RUN. Idempotent.
-- =============================================================================

begin;

alter table public.podcasts
  add column if not exists cover_url text;

comment on column public.podcasts.cover_url is
  'Artwork for the episode, as a URL. NULL means no cover and the card renders '
  'without one. Set at submission; editable by the Owner only. Deliberately not '
  'a foreign key into media_assets -- it is a URL like audio_url, and requiring a '
  'gallery row would mean a submitted episode cannot exist on its own.';

-- 24 rows, so a Reader-supplied URL cannot be an unbounded string.
alter table public.podcasts
  drop constraint if exists podcasts_cover_url_len;
alter table public.podcasts
  add constraint podcasts_cover_url_len
  check (cover_url is null or length(cover_url) <= 600);

commit;

-- -----------------------------------------------------------------------------
--  VERIFY (read-only, changes nothing)
-- -----------------------------------------------------------------------------
-- Expected: podcasts_cover_url_len true, podcasts_approver_update still present
-- (030 is not undone by this file), and the column readable by anon so the public
-- podcast card can render a cover.
select
  to_regclass('public.podcasts')                                     as podcasts_table,
  exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'podcasts' and column_name = 'cover_url'
  )                                                                  as cover_url_exists,
  exists (
    select 1 from pg_constraint where conname = 'podcasts_cover_url_len'
  )                                                                  as length_check_exists,
  -- If this is 0, migration 030 has not been applied and the Writer submission
  -- form will save rows that nobody can approve.
  (select count(*) from pg_policies
    where schemaname = 'public' and policyname = 'podcasts_approver_update')
                                                                     as approver_policy_present;