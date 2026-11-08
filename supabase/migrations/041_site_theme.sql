-- 041_site_theme.sql
-- Editorial edition (theme) settings. Singleton row, id = 1.
-- Scheduling columns starts_at/ends_at are present for future use but are
-- intentionally ignored by the client and Owners Panel in this version.

create table if not exists public.site_theme (
  id                integer primary key default 1 check (id = 1),
  published_theme   text not null default 'default'
    check (published_theme in ('default', 'christmas', 'sports')),
  published_options jsonb not null default '{}'::jsonb,
  updated_by        uuid references public.staff_accounts (id) on delete set null,
  updated_at        timestamptz not null default now(),
  starts_at         timestamptz,
  ends_at           timestamptz
);

insert into public.site_theme (id) values (1) on conflict (id) do nothing;

alter table public.site_theme enable row level security;

-- Owner-only writes. No public read policy on the base table.
drop policy if exists site_theme_owner_all on public.site_theme;
create policy site_theme_owner_all on public.site_theme
  for all using (public.is_owner()) with check (public.is_owner());

-- Public read exposes ONLY published_theme and published_options.
create or replace view public.site_theme_public
  with (security_invoker = false) as
  select id, published_theme, published_options
    from public.site_theme;

grant select on public.site_theme_public to anon, authenticated;
grant select, insert, update, delete on public.site_theme to anon, authenticated;
