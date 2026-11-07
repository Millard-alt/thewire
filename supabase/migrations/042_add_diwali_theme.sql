-- 042_add_diwali_theme.sql
-- Allow 'diwali' as a published edition.

begin;

-- Drop whatever CHECK constraint currently guards published_theme, regardless
-- of the name 041 (or anything else) gave it.
do $$
declare c record;
begin
  for c in
    select conname
      from pg_constraint
     where conrelid = 'public.site_theme'::regclass
       and contype = 'c'
       and pg_get_constraintdef(oid) ilike '%published_theme%'
  loop
    execute format('alter table public.site_theme drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.site_theme
  add constraint site_theme_published_theme_check
  check (published_theme in ('default', 'christmas', 'sports', 'diwali'));

commit;