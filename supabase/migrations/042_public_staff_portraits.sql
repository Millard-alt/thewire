-- 042_public_staff_portraits.sql
-- Public read access to APPROVED staff portraits.
--
-- THE BUG THIS CLOSES
-- -------------------
-- Every byline portrait on the site is resolved through the name-keyed staff
-- index built by indexStaffPortraits() (src/lib/credits.js). The `staff` table
-- itself is RLS-gated on is_staff(), so a signed-out visitor can never read it,
-- and the only client call site that fed the index (primeStaffPortraits() in
-- the admin panel) only runs with the Staff tab open. Signed-in staff saw the
-- corrected "one author, one face" resolution; anonymous readers silently fell
-- through to the Credits-roster index, which is the lower-precedence source
-- that resolution was written to stop using. That is why the profile-picture
-- mismatch the Owner fixed kept coming back for everybody not signed in.
--
-- THE FIX
-- -------
-- One SECURITY DEFINER function that hands out exactly the rows the public is
-- already entitled to see: active staffers whose portrait has been through the
-- approval pipeline (migration 014) and therefore may be published. Unapproved,
-- missing or emptied portraits are excluded here, at the source, so the client
-- cannot accidentally widen the scope later.
--
-- Existing public surfaces for portraits (the Credits roster, credits_people)
-- are unaffected. This is additive: the same approved photo, from the same
-- table, now reachable without a session.

create or replace function public.wire_public_portraits()
returns table (name text, portrait_url text)
language sql
stable
security definer
set search_path = public, extensions
as $$
  select s.name, s.portrait_url
    from public.staff s
   where s.status = 'Active'
     and s.portrait_status = 'approved'
     and coalesce(s.portrait_url, '') <> ''
   order by s.name;
$$;

grant execute on function public.wire_public_portraits() to anon, authenticated;
