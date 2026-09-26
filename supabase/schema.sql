-- ============================================================================
--  THE WIRE - SUPABASE SCHEMA
-- ----------------------------------------------------------------------------
--  Run this once in the Supabase SQL Editor (Dashboard -> SQL Editor -> New).
--  It is idempotent, so re-running is safe.
--
--  It creates every table the front end reads/writes plus the Row Level
--  Security policies that are the *authoritative* access gate. The
--  VITE_ADMIN_EMAILS allow-list in .env is only a UX convenience; these
--  policies are what actually protect the data.
-- ============================================================================

create extension if not exists "pgcrypto";

-- ----------------------------------------------------------------------------
-- 1. TABLES
-- ----------------------------------------------------------------------------

create table if not exists public.articles (
  id           uuid primary key default gen_random_uuid(),
  title        text        not null,
  author       text        not null default 'The Wire Staff',
  category     text        not null default 'Civic Dispatch',
  published_at text,
  image_url    text,
  caption      text,
  body         text,
  status       text        not null default 'Pending Review'
                           check (status in ('Published','Pending Review','Rejected','Archived')),
  featured     boolean     not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists articles_status_idx  on public.articles (status);
create index if not exists articles_created_idx on public.articles (created_at desc);

create table if not exists public.assignments (
  id         uuid primary key default gen_random_uuid(),
  title      text        not null,
  reporter   text,
  status     text        not null default 'Open',
  deadline   text,
  created_at timestamptz not null default now()
);

create table if not exists public.staff (
  id           uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique references auth.users (id) on delete set null,
  name         text        not null,
  username     text        not null unique,
  -- The hidden Supabase address derived from the username
  -- (`<username>@<VITE_AUTH_EMAIL_DOMAIN>`). Staff never see or type it.
  shadow_email text        unique,
  email        text,
  role         text        not null default 'Editor',
  status       text        not null default 'Active',
  created_at   timestamptz not null default now()
);

create table if not exists public.top_performers (
  id             uuid primary key default gen_random_uuid(),
  name           text        not null,
  role           text,
  articles_count integer     not null default 0,
  created_at     timestamptz not null default now()
);

create table if not exists public.media_assets (
  id         uuid primary key default gen_random_uuid(),
  url        text not null,
  caption    text,
  created_at timestamptz not null default now()
);

create table if not exists public.broadcasts (
  id              uuid primary key default gen_random_uuid(),
  title           text        not null,
  message         text,
  audience        text        not null default 'Everyone',
  delivered_count integer     not null default 0,
  created_at      timestamptz not null default now()
);

create table if not exists public.audit_logs (
  id          uuid primary key default gen_random_uuid(),
  actor_id    uuid references auth.users (id) on delete set null,
  actor_name  text,
  action      text not null,
  created_at  timestamptz not null default now()
);

create index if not exists audit_logs_created_idx on public.audit_logs (created_at desc);

-- Single-row table holding masthead branding, the breaking banner and curation.
create table if not exists public.site_settings (
  id                   integer primary key default 1 check (id = 1),
  title                text not null default 'THE WIRE',
  subtitle             text not null default 'NAKURU PRESS CLUB - INDEPENDENT VERIFIED DISPATCHES',
  -- Every text column needs a non-null default. The masthead renders these
  -- values directly, so a NULL here shows up on the page as the literal text
  -- "undefined" rather than falling back to anything sensible.
  edition              text not null default 'Nakuru Edition',
  breaking_news        jsonb not null default '{}'::jsonb,
  weekly_slots         jsonb not null default '{}'::jsonb,
  todays_pick_id       uuid references public.articles (id) on delete set null,
  forced_notifications boolean not null default false,
  updated_at           timestamptz not null default now()
);

insert into public.site_settings (id) values (1) on conflict (id) do nothing;

-- ----------------------------------------------------------------------------
-- 2. HELPER - is the caller a member of the active staff roster?
--    NOTE: is_staff() itself is NOT defined here. It lives in credentials.sql
--    and authenticates off the `x-wire-token` bearer header, not Supabase Auth.
--    If you re-run schema.sql after credentials.sql, nothing here overwrites it.
--    A guard block in credentials.sql fails loudly if that ever stops being true.
-- ----------------------------------------------------------------------------

-- Backfill the shadow address for any roster rows created before it existed.
-- Mirrors config.authEmailDomain (default users.thewire.press). If you change
-- that variable, update the literal below to match, then re-run this script.
update public.staff
   set shadow_email = username || '@users.thewire.press'
 where shadow_email is null
   and username is not null;

-- NOTE: public.is_staff() is deliberately NOT defined here.
--
-- It used to be defined in this file against Supabase Auth:
--
--     select exists (select 1 from public.staff
--                     where status = 'Active' and auth_user_id = auth.uid())
--
-- The project no longer uses Supabase Auth. Staff sign in with a username and
-- password through the wire_login() function, which mints an opaque bearer
-- token that the browser sends in the `x-wire-token` header. If this file
-- redefines is_staff() with the old auth.uid() logic, it OVERWRITES the
-- correct token-based version from credentials.sql, auth.uid() is always NULL
-- (there is no JWT), and every privileged call fails with "Not authorised."
-- even though the credentials are correct.
--
-- The authoritative definition now lives in credentials.sql, section 2
-- ("SESSION RESOLUTION"). Run credentials.sql AFTER this file.

-- ----------------------------------------------------------------------------
-- 3. ROW LEVEL SECURITY
--    Public can read published content; only staff can write anything.
-- ----------------------------------------------------------------------------

alter table public.articles        enable row level security;
alter table public.assignments     enable row level security;
alter table public.staff           enable row level security;
alter table public.top_performers  enable row level security;
alter table public.media_assets    enable row level security;
alter table public.broadcasts      enable row level security;
alter table public.audit_logs      enable row level security;
alter table public.site_settings   enable row level security;

-- ARTICLES: anyone may read published stories; staff read and write everything.
drop policy if exists articles_public_read on public.articles;
create policy articles_public_read on public.articles
  for select using (lower(status) = 'published' or public.is_staff());

drop policy if exists articles_staff_write on public.articles;
create policy articles_staff_write on public.articles
  for all using (public.is_staff()) with check (public.is_staff());

-- ASSIGNMENTS: the board is public (read-only to the public).
drop policy if exists assignments_public_read on public.assignments;
create policy assignments_public_read on public.assignments
  for select using (true);

drop policy if exists assignments_staff_write on public.assignments;
create policy assignments_staff_write on public.assignments
  for all using (public.is_staff()) with check (public.is_staff());

-- STAFF: only staff can list the roster. Plain readers cannot enumerate users.
-- NOTE: this used to read `auth_user_id = auth.uid()`, a leftover from the old
-- Supabase Auth design. There is no JWT in this project, so auth.uid() is always
-- NULL and the clause was dead weight that only invited confusion. The roster is
-- now gated purely on the bearer-token session resolved by is_staff().
drop policy if exists staff_self_or_staff_read on public.staff;
create policy staff_self_or_staff_read on public.staff
  for select using (public.is_staff());

drop policy if exists staff_staff_write on public.staff;
create policy staff_staff_write on public.staff
  for all using (public.is_staff()) with check (public.is_staff());

-- TOP PERFORMERS / MEDIA: public read, staff write.
drop policy if exists performers_public_read on public.top_performers;
create policy performers_public_read on public.top_performers
  for select using (true);

drop policy if exists performers_staff_write on public.top_performers;
create policy performers_staff_write on public.top_performers
  for all using (public.is_staff()) with check (public.is_staff());

drop policy if exists media_public_read on public.media_assets;
create policy media_public_read on public.media_assets
  for select using (true);

drop policy if exists media_staff_write on public.media_assets;
create policy media_staff_write on public.media_assets
  for all using (public.is_staff()) with check (public.is_staff());

-- BROADCASTS: staff-only (they carry audience data).
drop policy if exists broadcasts_staff_all on public.broadcasts;
create policy broadcasts_staff_all on public.broadcasts
  for all using (public.is_staff()) with check (public.is_staff());

-- AUDIT LOG: staff read/append, nobody edits or deletes history.
drop policy if exists audit_staff_read on public.audit_logs;
create policy audit_staff_read on public.audit_logs
  for select using (public.is_staff());

drop policy if exists audit_staff_insert on public.audit_logs;
create policy audit_staff_insert on public.audit_logs
  for insert with check (public.is_staff());

-- SITE SETTINGS: everyone needs to read the masthead; staff write.
drop policy if exists settings_public_read on public.site_settings;
create policy settings_public_read on public.site_settings
  for select using (true);

drop policy if exists settings_staff_write on public.site_settings;
create policy settings_staff_write on public.site_settings
  for all using (public.is_staff()) with check (public.is_staff());

--  This file covers tables, the masthead row and the original RLS policies.
--  Stage 2 (username + password credentials) lives in `credentials.sql`.
--  Run schema.sql FIRST, then credentials.sql.
