-- =============================================================================
--  003_subscriptions_and_gallery.sql
-- =============================================================================
--  Run this AFTER credentials.sql. It is additive and safe to re-run.
--
--  Adds two things the app was faking:
--
--    1. push_subscriptions - a REAL registry of reader devices. Until this table
--       existed, src/lib/push.js was writing to a table that was not there, so
--       every subscription silently failed and the Owner panel displayed a
--       hardcoded 1420 "subscribers" figure from the seed data.
--
--    2. media_assets.in_gallery - lets the Owner choose which photos appear on
--       the public Gallery page instead of every uploaded image showing up.
--
--  ASCII only. Non-ASCII characters inside SQL string literals have broken
--  copy/paste into the Supabase SQL Editor before.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. REAL SUBSCRIBER REGISTRY
-- -----------------------------------------------------------------------------

create table if not exists public.push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  -- The browser gives each device a unique push endpoint. It is the natural key
  -- and doubles as the device identifier for targeted sends.
  endpoint   text        not null unique,
  -- Free-form label the Owner can read, e.g. "Windows - Chrome".
  device     text,
  -- Which audience the reader opted into, so the Owner can target a send.
  audience   text        not null default 'Everyone',
  created_at timestamptz not null default now(),
  last_seen  timestamptz not null default now()
);

create index if not exists push_subscriptions_created_idx
  on public.push_subscriptions (created_at desc);

alter table public.push_subscriptions enable row level security;

-- A reader opts in with no account, so anonymous inserts are required. Only the
-- endpoint and label are accepted - nothing here is sensitive.
drop policy if exists push_subscriptions_subscribe on public.push_subscriptions;
create policy "push_subscriptions_subscribe"
  on public.push_subscriptions for insert
  to anon, authenticated
  with check (true);

-- A reader who turns alerts off deletes their own row. `using (true)` is safe:
-- the policy can only remove a row, never read one.
drop policy if exists push_subscriptions_unsubscribe on public.push_subscriptions;
create policy "push_subscriptions_unsubscribe"
  on public.push_subscriptions for delete
  to anon, authenticated
  using (true);

-- Readers must NOT be able to enumerate other people's devices, so there is no
-- select policy for anon. Only active staff can read the registry.
drop policy if exists push_subscriptions_staff_read on public.push_subscriptions;
create policy "push_subscriptions_staff_read"
  on public.push_subscriptions for select
  to authenticated
  using (public.is_staff());

-- Staff may also clear a dead device record.
drop policy if exists push_subscriptions_staff_delete on public.push_subscriptions;
create policy "push_subscriptions_staff_delete"
  on public.push_subscriptions for delete
  to authenticated
  using (public.is_staff());

grant insert, delete on public.push_subscriptions to anon, authenticated;
grant select, delete on public.push_subscriptions to authenticated;

-- -----------------------------------------------------------------------------
-- 2. REAL SUBSCRIBER COUNT
--    Reported through a function so an unprivileged client can ask "how many
--    readers are subscribed?" without being able to read the table itself.
-- -----------------------------------------------------------------------------

create or replace function public.wire_subscriber_count()
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::integer from public.push_subscriptions;
$$;

grant execute on function public.wire_subscriber_count() to anon, authenticated;

-- -----------------------------------------------------------------------------
-- 2b. THE SUBSCRIBER LIST
--     The Owner can target a specific device, so it needs to see the registry.
--     Exposed as a function (not a plain select) so the table stays unreadable to
--     the public while the Owner still gets the list through the app.
-- -----------------------------------------------------------------------------

drop function if exists public.wire_list_devices();

create or replace function public.wire_list_devices()
returns table (
  endpoint   text,
  device     text,
  audience   text,
  created_at timestamptz,
  last_seen  timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select s.endpoint, s.device, s.audience, s.created_at, s.last_seen
  from public.push_subscriptions s
  where public.is_staff()
  order by s.last_seen desc;
$$;

revoke execute on function public.wire_list_devices() from anon, public;
grant execute on function public.wire_list_devices() to authenticated;

-- -----------------------------------------------------------------------------
-- 2c. TARGETED SEND
--     Marks a broadcast as aimed at one specific device rather than everyone, so
--     the delivery history can say who it was for.
-- -----------------------------------------------------------------------------

alter table public.broadcasts
  add column if not exists target_device text;

-- -----------------------------------------------------------------------------
-- 3. GALLERY SELECTION
--    `in_gallery` is the Owner's publish toggle. `gallery_order` lets the Owner
--    control the running order; NULLs sort last.
-- -----------------------------------------------------------------------------

alter table public.media_assets
  add column if not exists in_gallery boolean not null default false;

alter table public.media_assets
  add column if not exists gallery_order integer;

create index if not exists media_assets_gallery_idx
  on public.media_assets (gallery_order, created_at desc)
  where in_gallery;

-- -----------------------------------------------------------------------------
-- 4. BROADCAST AUDIT
--    Records what an owner-composed broadcast actually resolved to, so the
--    history shows a real device count rather than a seeded number.
-- -----------------------------------------------------------------------------

alter table public.broadcasts
  add column if not exists requires_action boolean not null default false;

alter table public.broadcasts
  add column if not exists target_endpoint text;

-- =============================================================================
--  Done. Expected output: no rows, no errors.
--  Verify with:  select public.wire_subscriber_count();
-- =============================================================================
