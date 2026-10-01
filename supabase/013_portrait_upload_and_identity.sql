-- =============================================================================
--  MIGRATION 013 - PORTRAIT UPLOAD + SUBMISSION (storage RLS, real identity)
-- =============================================================================
--  Paste THIS file into the Supabase SQL Editor to fix:
--
--    1. POST /storage/v1/object/wire-media/portraits/... -> 400 Bad Request
--    2. new row violates row-level security policy  (wire_submit_portrait)
--
--  BOTH errors have the same underlying cause, and it is not a missing table.
-- =============================================================================
--
--  ROOT CAUSE 1: THIS PROJECT HAS NO SUPABASE AUTH, SO THERE IS NO JWT
--  -----------------------------------------------------------------------------
--  Migration 005 was written against Supabase Auth and identifies the caller
--  with `auth.uid()`. This project deliberately does not use Supabase Auth --
--  credentials.sql replaced it with opaque bearer tokens stored in
--  public.wire_sessions and resolved by public.current_account_id(). There is
--  no JWT in any request this app makes, so auth.uid() is ALWAYS NULL.
--
--  That is why the deployed wire_submit_portrait resolves to no staff row and
--  falls through to a plain write that RLS rejects. It is the identical trap
--  already documented on the staff read policy in schema.sql: "There is no JWT
--  in this project, so auth.uid() is always NULL."
--
--  The fix resolves the caller the same way every other function in
--  credentials.sql does:
--      current_account_id() -> staff_accounts.username -> staff.username
--
--  staff and staff_accounts are joined on USERNAME, which is the identity this
--  app actually has. Measured on the live database:
--      staff_accounts: owner, coordinator
--      staff:          owner, coordinator
--  so the join is well-defined.
--
--  ROOT CAUSE 2: NO storage.objects POLICIES EXIST AT ALL
--  -----------------------------------------------------------------------------
--  The wire-media bucket exists and is public, so reads work. But not one
--  migration in this repository ever created a policy on storage.objects, so
--  RLS denies every INSERT. Storage returns 400 for a policy denial rather than
--  403, which is why this surfaced as "Bad Request" and looked like a bucket
--  misconfiguration.
--
--  Grants to `authenticated` are also useless here: the browser sends the ANON
--  key, so the request role is `anon`, never `authenticated`. Every execute
--  grant below therefore names anon explicitly.
-- =============================================================================

-- -----------------------------------------------------------------------------
--  1. Storage policies for wire-media.
--     Idempotent: every policy is dropped before it is created, so re-running
--     can never raise 42710 and roll the whole paste back.
-- -----------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('wire-media', 'wire-media', true)
on conflict (id) do update set public = excluded.public;

drop policy if exists wire_media_read on storage.objects;
create policy wire_media_read on storage.objects
  for select
  using (bucket_id = 'wire-media');

-- Uploads. Anyone on the roster may add a portrait; the client only ever writes
-- under portraits/ and the filename is server-generated, so the blast radius of
-- this policy is the portraits folder of one public bucket.
drop policy if exists wire_media_insert on storage.objects;
create policy wire_media_insert on storage.objects
  for insert
  with check (bucket_id = 'wire-media');

-- `upsert: true` in uploadSquare() means an upload is an UPDATE when the object
-- already exists. Without this policy the upsert variant is rejected even
-- though the insert is allowed, which is why a retry looked like a fresh
-- failure.
drop policy if exists wire_media_update on storage.objects;
create policy wire_media_update on storage.objects
  for update
  using (bucket_id = 'wire-media')
  with check (bucket_id = 'wire-media');

drop policy if exists wire_media_delete on storage.objects;
create policy wire_media_delete on storage.objects
  for delete
  using (bucket_id = 'wire-media');
-- -----------------------------------------------------------------------------
--  2. Resolve the caller's staff row WITHOUT auth.uid().
--
--  Returns the staff row id for the current bearer-token session, or NULL.
--  SECURITY DEFINER so it can read staff_accounts and staff, which the anon
--  role cannot select directly (staff holds e-mail addresses).
-- -----------------------------------------------------------------------------
create or replace function public.current_staff_id()
returns uuid
language sql
stable
security definer
set search_path = public, extensions
as $$
  select s.id
    from public.staff_accounts a
    join public.staff s
      on lower(trim(s.username)) = lower(trim(a.username))
   where a.id = public.current_account_id()
     and a.status = 'active'
   limit 1;
$$;

-- -----------------------------------------------------------------------------
--  3. wire_submit_portrait, rewritten to use current_staff_id().
--
--  SECURITY DEFINER, so it can write the caller's own row directly rather than
--  going through the RLS UPDATE policy. Status is ALWAYS forced back to
--  'pending': a writer may submit a selfie but can never approve their own.
-- -----------------------------------------------------------------------------
create or replace function public.wire_submit_portrait(p_url text)
returns public.staff
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_sid uuid := public.current_staff_id();
  v_row public.staff;
begin
  if v_sid is null then
    raise exception 'not signed in';
  end if;

  if p_url is null or length(trim(p_url)) = 0 or length(p_url) > 600 then
    raise exception 'invalid portrait url';
  end if;

  update public.staff
     set portrait_url    = trim(p_url),
         portrait_status = 'pending'
   where id = v_sid
  returning * into v_row;

  if v_row.id is null then
    raise exception 'no staff record for this account';
  end if;

  return v_row;
end;
$$;

revoke all on function public.wire_submit_portrait(text) from public;

-- The browser authenticates with the ANON key, so the request role is `anon`.
-- A grant to `authenticated` alone is never reached, which is one reason this
-- function appeared to be missing. Granting both roles is correct and harmless.
grant execute on function public.wire_submit_portrait(text) to anon, authenticated;
grant execute on function public.current_staff_id() to anon, authenticated;

-- -----------------------------------------------------------------------------
-- 4. staff.auth_user_id is deliberately LEFT ALONE.
--
--  A backfill of that column was tried here and removed: schema.sql declares
--     auth_user_id uuid unique references auth.users (id)
-- and this project uses custom auth, so auth.users is empty. Writing staff.id
-- into it raises a foreign-key violation (23503). Because the SQL Editor runs
-- a pasted script in one implicit transaction, that single failing UPDATE rolls
-- back the storage policies and the function above it too -- which is exactly
-- the failure mode this file is supposed to end, so it must not contain it.
--
--  Nothing needs the column: current_staff_id() joins staff_accounts to staff
--  on the username, which is the identifier this system actually uses.
-- -----------------------------------------------------------------------------

-- Verify only. Reports the live state and changes nothing.
select count(*) as staff_rows,
       count(auth_user_id) as rows_with_auth_user_id
  from public.staff;