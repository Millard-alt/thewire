-- Rollback for 042_add_diwali_theme.sql
-- 1. Revert any published diwali rows to default.
-- 2. Restore the 3-value CHECK.

begin;

update public.site_theme
   set published_theme = 'default'
 where published_theme = 'diwali';

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
  check (published_theme in ('default', 'christmas', 'sports'));

commit;