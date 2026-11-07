-- 042_add_diwali_theme.sql
-- Allow 'diwali' as a published edition.

begin;

alter table public.site_theme
  drop constraint if exists site_theme_published_theme_check;

alter table public.site_theme
  add constraint site_theme_published_theme_check
  check (published_theme in ('default', 'christmas', 'sports', 'diwali'));

commit;