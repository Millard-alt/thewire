-- 043_add_article_author_photo_url.sql
-- -----------------------------------------------------------------------------
-- Adds the optional per-article byline photo column that the "Add optional
-- byline photo for articles" feature (commit 1515967) expects. Without it,
-- creating or updating an article that carries a byline photo fails with
-- PGRST204 "could not find the 'author_photo_url' column of 'articles'".
--
-- Idempotent: safe to run twice.
-- -----------------------------------------------------------------------------

begin;

alter table public.articles
  add column if not exists author_photo_url text;

commit;