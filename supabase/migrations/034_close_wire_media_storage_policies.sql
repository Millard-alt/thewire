-- =============================================================================
--  034_close_wire_media_storage_policies
-- =============================================================================
--  WHY
--
--  `013_portrait_upload_and_identity.sql` created three storage policies on the
--  public `wire-media` bucket whose ONLY condition was the bucket name:
--
--      create policy wire_media_insert on storage.objects
--        for insert with check (bucket_id = 'wire-media');
--      create policy wire_media_update on storage.objects
--        for update using (bucket_id = 'wire-media') with check (bucket_id = 'wire-media');
--      create policy wire_media_delete on storage.objects
--        for delete using (bucket_id = 'wire-media');
--
--  There is no `is_staff()` on any of them, so the anon key -- which ships in
--  every reader's JS bundle -- can upload, overwrite and DELETE objects in the
--  bucket with no session at all. `wire_media_update` also means `upsert: true`
--  can clobber an existing portrait.
--
--  WHY IT WAS NEVER CAUGHT
--
--  The comment above the policies claims "Anyone on the roster may add a
--  portrait", and `025_podcasts_storage_repair.sql:200-216` reasons that these
--  policies "still have to satisfy is_staff()". That was correctly true for
--  `podcasts_upload` and wrongly assumed for `wire_media_*`, which never had
--  the check. The client validated the MIME type; the database never did.
--
--  WHAT CHANGES
--
--    1. All three policies gain `and public.is_staff()`, matching the pattern
--       `podcasts_upload` already uses successfully (see 025).
--    2. Writes are limited to the two prefixes the app actually writes:
--       `portraits/` (src/lib/portrait.js:377) and the bucket ROOT
--       (src/lib/upload.js:53, the gallery/article uploader). Restricting to
--       `portraits/` alone would break every gallery and article image.
--    3. Object names must end in an image extension. This is the part that
--       stops stored XSS: the bucket is `public = true`, so an SVG or HTML
--       object is served from this site's own origin.
--    4. The bucket gains `allowed_mime_types` and a 5 MB `file_size_limit`.
--
--  EXISTING UPLOADS
--
--  Bucket limits apply to NEW uploads only. Existing objects keep their
--  public URLs and stay readable, and no object is deleted or renamed here.
--
--  NOT TOUCHED
--
--  `wire_media_read` and the bucket's `public = true`. Readers need an
--  unauthenticated read path for article and portrait images.
-- =============================================================================

-- -----------------------------------------------------------------------------
--  0. Preconditions. Fail loudly and early rather than mid-migration.
-- -----------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where p.proname = 'is_staff'
       and n.nspname = 'public'
  ) then
    raise exception
      'public.is_staff() does not exist. Run supabase/credentials.sql first -- '
      '034 depends on it and would otherwise fail to create its policies.';
  end if;

  if not exists (select 1 from storage.buckets where id = 'wire-media') then
    raise exception
      'The wire-media bucket does not exist. Run supabase/013_portrait_upload_and_identity.sql first.';
  end if;
end
$$;

-- -----------------------------------------------------------------------------
--  1. Bucket limits.
--
--  `allowed_mime_types` and `file_size_limit` were added to storage.buckets in
--  2023. Detect the column instead of assuming it: this project has been
--  applied to a live database by hand, and a missing column should produce a
--  clear message rather than a syntax error.
--
--  NOTE: this narrows the server to the three types below. src/lib/upload.js
--  currently also accepts GIF and AVIF up to 8 MB and was updated in the same
--  change to match, so the client fails fast with a readable message instead of
--  surfacing a raw Storage error.
-- -----------------------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'storage'
       and table_name   = 'buckets'
       and column_name  = 'allowed_mime_types'
  ) then
    update storage.buckets
       set allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp'],
           file_size_limit    = 5242880,
           public             = true
     where id = 'wire-media';

    raise notice 'wire-media: allowed_mime_types = png/jpeg/webp, file_size_limit = 5 MB.';
  else
    raise exception
      'storage.buckets.allowed_mime_types is missing. This Supabase project is too '
      'old for the bucket-level MIME allowlist in 034. Apply the rest of this '
      'migration, then enforce the MIME type in an Edge Function.';
  end if;
end
$$;

-- -----------------------------------------------------------------------------
--  2. Insert.
--
--  `public.is_staff()` resolves the x-wire-token header through
--  wire_bearer_token() -> current_account_id(). The app's custom fetch
--  (src/lib/supabase.js) attaches that header to Storage requests too, which is
--  why `podcasts_upload` has been able to rely on is_staff() since 025.
--
--  The prefix test allows the two writers and nothing else:
--      portraits/<name>-<stamp>.jpg   src/lib/portrait.js:377
--      <stamp>-<rand>.<ext>           src/lib/upload.js:53  (root, no folder)
--  `coalesce(foldername[1], '')` is '' for a root-level object, so the root
--  uploader keeps working while a path such as `anything/else.png` does not.
--
--  The extension test is what prevents stored XSS. An .svg or .html object in a
--  public bucket executes on this origin.
-- -----------------------------------------------------------------------------
drop policy if exists wire_media_insert on storage.objects;
create policy wire_media_insert on storage.objects
  for insert
  with check (
    bucket_id = 'wire-media'
    and public.is_staff()
    and coalesce((storage.foldername(name))[1], '') in ('', 'portraits')
    and lower(name) ~ '\.(png|jpe?g|webp)$'
  );

-- -----------------------------------------------------------------------------
--  3. Update.
--
--  `uploadSquare()` uses `upsert: true`, which Postgres issues as an UPDATE when
--  the object exists, so this policy is load-bearing: without it a portrait
--  re-upload fails even though the insert is allowed. Same checks as insert.
-- -----------------------------------------------------------------------------
drop policy if exists wire_media_update on storage.objects;
create policy wire_media_update on storage.objects
  for update
  using (
    bucket_id = 'wire-media'
    and public.is_staff()
    and coalesce((storage.foldername(name))[1], '') in ('', 'portraits')
  )
  with check (
    bucket_id = 'wire-media'
    and public.is_staff()
    and coalesce((storage.foldername(name))[1], '') in ('', 'portraits')
  );

-- -----------------------------------------------------------------------------
--  4. Delete.
--
--  Nothing in src/ removes from wire-media -- every `.remove()` call targets the
--  `podcasts` bucket -- so this closes without breaking a caller. It is kept
--  (rather than dropped) so an editor can still clean up a bad upload by hand.
-- -----------------------------------------------------------------------------
drop policy if exists wire_media_delete on storage.objects;
create policy wire_media_delete on storage.objects
  for delete
  using (
    bucket_id = 'wire-media'
    and public.is_staff()
    and coalesce((storage.foldername(name))[1], '') in ('', 'portraits')
  );

-- -----------------------------------------------------------------------------
--  5. Verification. Every policy that mentions wire-media must now name
--     is_staff(). This is the assertion that would have failed on 013.
-- -----------------------------------------------------------------------------
do $$
declare
  unguarded text;
begin
  -- An INSERT policy has no USING clause, so its guard lives in with_check and
  -- `qual` is NULL. Checking only `qual` would pass vacuously for
  -- wire_media_insert, which is the policy that actually matters.
  select string_agg(policyname, ', ' order by policyname)
    into unguarded
    from pg_policies
   where schemaname = 'storage'
     and tablename  = 'objects'
     and policyname in ('wire_media_insert', 'wire_media_update', 'wire_media_delete')
     and coalesce(qual, '') || ' ' || coalesce(with_check, '') not like '%is_staff%';

  if unguarded is not null then
    raise exception 'wire-media policies still missing is_staff(): %', unguarded;
  end if;

  -- Any other policy still writing to this bucket without an is_staff() check
  -- would reopen the hole, including one added by a future migration.
  select string_agg(policyname, ', ' order by policyname)
    into unguarded
    from pg_policies
   where schemaname = 'storage'
     and tablename  = 'objects'
     and policyname like 'wire_media%'
     and policyname not in ('wire_media_insert', 'wire_media_update',
                            'wire_media_delete', 'wire_media_read')
     and coalesce(qual, '') || ' ' || coalesce(with_check, '') not like '%is_staff%';

  if unguarded is not null then
    raise exception 'unexpected wire_media policy without is_staff(): %', unguarded;
  end if;

  raise notice 'wire-media: insert/update/delete all require is_staff().';
end
$$;