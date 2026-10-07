-- =============================================================================
--  supabase/025_podcasts_storage_repair.sql
--  -----------------------------------------------------------------------------
--  Fixes the MP3 upload failure:
--
--      iguzwwqjufzzdblkqroj.supabase.co/storage/v1/object/podcasts/episodes/...
--      Failed to load resource
--
--  STEP 1 IS READ-ONLY. Run it first and paste the output; it answers the only
--  question that matters, which is WHICH of the four causes below you have.
--
--  CORS IS ALMOST CERTAINLY NOT THE PROBLEM
--  ----------------------------------------
--  The browser logs "Failed to load resource" for any response whose body it
--  cannot read as a readable payload, so it appears for a 404 from Storage just
--  as it appears for a CORS rejection. And a CORS rejection is not what a
--  preflight failure looks like here: supabase-js sends an Authorization header,
--  which makes the request non-simple, so it IS preflighted -- and *.supabase.co
--  answers OPTIONS for its own API. If this bucket lives on that host, CORS is
--  not the cause and adding headers will not fix it. What you are seeing is the
--  browser's generic message for a server-side refusal.
--
--  THE FOUR CAUSES, and how to tell them apart in step 1
--  ------------------------------------------------------
--    1. THE BUCKET DOES NOT EXIST. `bucket_exists` is false. Most likely if
--       migration 024 was never pasted -- or was pasted and FAILED, because
--       024 wraps everything in one transaction: a single error rolls the whole
--       file back, including the credits_people columns.
--
--    2. THE BUCKET IS NOT PUBLIC. `is_public` is false. Then the UPLOAD can
--       still succeed while every reader gets a 400 on <audio src>. Easy to
--       misread as "the upload failed".
--
--    3. NO INSERT POLICY, or one that does not match the path.
--       `can_upload` is false. The upload then fails with an opaque
--       "new row violates row-level security policy".
--
--    4. THE PATH DOES NOT START WITH `episodes/`. `path_ok` is false for a
--       sample path. The policy requires it, so an upload anywhere else is
--       refused by design.
--
--  WHAT WAS ACTUALLY WRONG IN 024
--  -------------------------------
--  `octet_length(name) < 26214400` was written as an upload size cap. `name` is
--  the OBJECT NAME -- "episodes/mux8f1-abc123.mp3" -- not the file, so the check
--  capped the length of a filename and let a 200 MB MP3 straight through. It was
--  a limit that enforced nothing while reading as a limit, which is worse than
--  having none. 024 has been corrected; this file re-applies it idempotently.
--
--  The real ceiling is enforced in three places that all agree: the client
--  (25 MB, refuses before uploading), Supabase's own per-object limit, and the
--  table's duration/description checks.
--
--  Run in the Supabase SQL Editor.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- STEP 1 — read-only diagnosis. Changes nothing.
--
-- ALWAYS RETURNS EXACTLY ONE ROW, and that is the whole design point.
--
-- This query originally selected `b.id` and `b.public` with NO FROM clause at
-- all, so it failed with `42P01 missing FROM-clause entry for table "b"` and
-- never diagnosed anything. The obvious repair — adding `FROM storage.buckets b`
-- — would then have been WORSE in the one case that matters most: a missing
-- bucket returns zero rows, so `bucket_exists`, `storage_policies`,
-- `caller_is_staff` and everything else would all disappear, and the reader
-- would see an empty result and learn nothing.
--
-- Hence scalar subqueries rather than a FROM: they yield NULL for the bucket
-- columns and a row nonetheless, so the failure being investigated always
-- reports itself.
-- -----------------------------------------------------------------------------
select
  -- Bucket. NULL when it does not exist, which is the answer, not an error.
  (select b.id       from storage.buckets b where b.id = 'podcasts') as bucket_id,
  (select b.public   from storage.buckets b where b.id = 'podcasts') as is_public,
  exists (select 1 from storage.buckets b where b.id = 'podcasts')  as bucket_exists,

  -- How many of the three policies exist. 0 = never ran this file; 1 or 2 =
  -- half-applied; 3 = healthy.
  (
    select count(*)
      from pg_policies p
     where p.schemaname = 'storage'
       and p.tablename  = 'objects'
       and p.policyname in ('podcasts_read', 'podcasts_upload', 'podcasts_delete')
  )                                                               as storage_policies,

  -- Does the upload policy actually constrain the path?
  --
  -- This used to be `bool_or((storage.foldername('episodes/probe.mp3'))[1] =
  -- 'episodes')` over the policy rows. That expression is CONSTANT — it never
  -- looks at the policy — so it reported the same true/false whether the policy
  -- checked the folder or not, and reported NULL when the policy was absent. A
  -- check that cannot fail is not a check. This one reads the policy's own
  -- WITH CHECK clause: if it does not mention foldername, a writer could upload
  -- anywhere in the bucket, including a path that overwrites the portrait bucket
  -- convention.
  coalesce((
    select bool_or(p.with_check like '%foldername%')
      from pg_policies p
     where p.schemaname = 'storage'
       and p.tablename  = 'objects'
       and p.policyname = 'podcasts_upload'
  ), false)                                                       as upload_policy_checks_path,

  -- Who the SQL editor is talking to. false here with policies in place is the
  -- other half of a refused upload: the policy is fine and the caller is not.
  (select public.is_staff())                                      as caller_is_staff,
  (select public.current_account_id() is not null)                as session_resolves,

  to_regclass('public.podcasts')                                  as podcasts_table,
  exists (
    select 1 from pg_constraint where conname = 'podcasts_status_check'
  )                                                              as podcasts_constraints_ok;

-- -----------------------------------------------------------------------------
-- STEP 2 — the repair. Idempotent; safe to run twice.
--
-- Each statement below is written to be correct whether or not the thing it
-- fixes exists, so this repairs a half-applied 024 rather than assuming one.
-- -----------------------------------------------------------------------------
begin;

-- The bucket, public so an <audio src> is fetchable by an anonymous reader.
--
-- `on conflict do update set public = true` rather than `do nothing`: a bucket
-- created by an earlier failed run can exist with public = false, and that is
-- cause 2 above -- an upload that succeeds and a page that will not play.
insert into storage.buckets (id, name, public, file_size_limit)
values ('podcasts', 'podcasts', true, 26214400)
on conflict (id) do update
  set public           = true,
      file_size_limit  = excluded.file_size_limit;

-- file_size_limit is a REAL server-side cap on the object, unlike the
-- octet_length(name) expression it replaces. 25 MB, matching the client.

-- Read: anyone, because the bucket is public and the <audio> tag is anonymous.
-- Kept even though `public = true` already serves reads, so the intent is
-- explicit in the policy list rather than implied by a bucket flag.
drop policy if exists podcasts_read on storage.objects;
create policy podcasts_read on storage.objects
  for select using (bucket_id = 'podcasts');

-- Insert: any staffer, audio only under `episodes/`.
--
-- NO SIZE CHECK HERE. Supabase enforces file_size_limit above, and a policy
-- expression cannot see the payload size -- `storage.objects` has no size column
-- at insert time. The previous octet_length(name) looked like a cap and was not.
drop policy if exists podcasts_upload on storage.objects;
create policy podcasts_upload on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'podcasts'
    and public.is_staff()
    and coalesce((storage.foldername(name))[1], '') = 'episodes'
  );

-- Delete: Owner only. Purging a refused episode is a decision about something
-- that was submitted for publication, so it is not a writer's to make.
drop policy if exists podcasts_delete on storage.objects;
create policy podcasts_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'podcasts' and public.is_owner());

commit;

-- -----------------------------------------------------------------------------
-- STEP 3 — verify. Re-run step 1; every column should now read true.
--
--   bucket_exists        true
--   is_public            true
--   storage_policies     3
--   path_ok              true
--
-- `caller_is_staff` will still be FALSE in the SQL Editor and that is CORRECT:
-- the editor sends no bearer token, so current_account_id() resolves to nothing.
-- It is there to prove the policy's function is reachable, not to grant access.
-- A storage upload only succeeds from the signed-in app.
--
-- If step 1 shows `podcasts_table` as NULL, migration 024 never committed --
-- paste supabase/migrations/024_about_podcasts_and_layout.sql and watch for the
-- FIRST error it reports; everything after it rolled back with it.
-- -----------------------------------------------------------------------------
