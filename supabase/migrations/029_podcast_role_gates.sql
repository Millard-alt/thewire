-- =============================================================================
--  029_podcast_role_gates.sql
--  THE SAME BUG AS 025, ONE LAYER DOWN: the TABLE, not the bucket
-- =============================================================================
--
-- THE SYMPTOM
--
--   "The episode could not be saved: new row violates row-level security policy
--    for table 'podcasts'"
--
-- with a 401 in the console on the POST. Note the object: STORAGE. That is the
-- important part, and it means 025 worked -- the audio now uploads, the bucket
-- accepted the object, and the failure moved to the very next statement, which
-- inserts the row.
--
-- 024 wrote these policies:
--
--   podcasts_staff_submit         for insert to authenticated
--   podcasts_owner_all            for all     to authenticated
--   podcasts_delete_own_pending   for delete  to authenticated
--
-- and granted `insert, update, delete ... to authenticated`.
--
-- This project issues its own opaque token in the `x-wire-token` header and has
-- NO Supabase Auth JWT -- credentials.sql says so outright. So every request
-- arrives as Postgres role `anon`. `to authenticated` matches no policy, the
-- GRANT does not apply, and the insert is refused.
--
-- It was never a missing policy, and never anybody's account. 9 accounts, all 9
-- Active, 1 Owner, 23 live sessions, and the upload still could not be saved.
--
-- THE PROJECT ALREADY HAS THE RIGHT PATTERN, 20 FILES EARLIER
--
--   articles_*      (007)  ->  for insert to anon, authenticated
--   interviews_*    (022)  ->  for insert to anon, authenticated
--   push_subscriptions_subscribe (003) -> to anon, authenticated
--
-- Every feature that works in this application names `anon` as well. The podcast
-- policies are the only ones that do not. That is the whole difference between
-- working and not, and it is why this is a defect rather than a design choice.
--
-- WHY THIS IS SAFE
--
-- In this architecture `anon` IS the signed-in role: `anon` is simply the name
-- PostgREST gives a request that carries no Supabase Auth session, which is all
-- of them. Naming it is naming the request, not granting it anything.
--
-- Removing the role clause widens WHICH ROLES ARE EVALUATED. It does not widen
-- WHO IS ALLOWED, because every row still has to satisfy `is_staff()` or
-- `is_owner()`, and those resolve the account from the request's bearer token. A
-- visitor with no token, or a stale token, or an account that is not Active, still
-- evaluates false and is still refused. Nothing here trusts the client.
--
-- THE GRANT IS FIXED TOO, and it is easy to miss: RLS is only consulted AFTER the
-- table privilege is checked, so leaving `grant insert ... to authenticated` in
-- place would refuse the insert with "permission denied for table podcasts"
-- before any policy is ever evaluated.
--
-- SAFE TO RE-RUN. Every statement is idempotent. Run it AFTER 024 and 025.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. GRANTS: `anon` needs the privilege, because `anon` is the role
-- -----------------------------------------------------------------------------
-- `authenticated` is retained. It costs nothing and keeps the policies correct
-- should this project ever adopt Supabase Auth alongside its own token.
grant select on public.podcasts to anon, authenticated;
grant insert on public.podcasts to anon, authenticated;
grant update, delete on public.podcasts to anon, authenticated;

-- -----------------------------------------------------------------------------
-- 2. THE SUBMIT POLICY
-- -----------------------------------------------------------------------------
-- Public read: approved rows only. An anon key must never be able to list the
-- approval queue by trying to read the table.
drop policy if exists podcasts_public_read on public.podcasts;
create policy podcasts_public_read on public.podcasts
  for select using (status = 'approved' or public.is_staff());

-- A writer files a submission. The WITH CHECK is the whole gate: it pins the
-- status to 'pending' on the way IN, so a crafted request cannot self-approve,
-- and it stamps the filer from the session rather than trusting a sent id.
--
-- ROLE CLAUSE REMOVED -- see the header.
drop policy if exists podcasts_staff_submit on public.podcasts;
create policy podcasts_staff_submit on public.podcasts
  for insert
  with check (
    public.is_staff()
    and status = 'pending'
    and author_account_id = public.current_account_id()
  );

-- The Owner edits anything: the description, the title, the audio, and the
-- approve/reject decision. Writers get no UPDATE at all -- a writer who cannot
-- approve must not be able to edit an approved row either.
--
-- This is ALSO the policy that permits the Owner's publish-now insert, whose
-- status is 'approved' and which podcasts_staff_submit rejects on purpose.
-- Permissive policies are OR'd, so is_owner() is what allows that row. This is
-- the intended shape, and it is why removing the role clause here is safe rather
-- than a widening: podcasts_staff_submit still refuses self-approval for
-- everyone who is not the Owner.
drop policy if exists podcasts_owner_all on public.podcasts;
create policy podcasts_owner_all on public.podcasts
  for all
  using (public.is_owner())
  with check (public.is_owner());

-- A writer may withdraw their own pending submission. Scoped to status =
-- 'pending' so it cannot be used to delete an episode that is already live.
drop policy if exists podcasts_delete_own_pending on public.podcasts;
create policy podcasts_delete_own_pending on public.podcasts
  for delete
  using (
    public.is_staff()
    and status = 'pending'
    and author_account_id = public.current_account_id()
  );

-- -----------------------------------------------------------------------------
-- 3. PUSH SUBSCRIPTIONS: THE SAME DEFECT, STILL LATENT
-- -----------------------------------------------------------------------------
-- Audited every policy in the repository while fixing the podcast ones. These two
-- name `authenticated` and nothing else, so push notification management has been
-- unreachable for the same reason podcasts were:
--
--   push_subscriptions_staff_read     staff see who is subscribed
--   push_subscriptions_staff_delete   staff remove a stale subscription
--
-- The two subscribe/unsubscribe policies are already correct (`to anon,
-- authenticated`) because an anonymous reader is allowed to subscribe -- which is
-- why that feature works and these two do not.
drop policy if exists push_subscriptions_staff_read on public.push_subscriptions;
create policy push_subscriptions_staff_read on public.push_subscriptions
  for select to anon, authenticated
  using (public.is_staff());

drop policy if exists push_subscriptions_staff_delete on public.push_subscriptions;
create policy push_subscriptions_staff_delete on public.push_subscriptions
  for delete to anon, authenticated
  using (public.is_staff());

commit;

-- -----------------------------------------------------------------------------
-- 4. VERIFY (read-only, changes nothing)
-- -----------------------------------------------------------------------------
-- Every policy must now be reachable for an anon-role request. `role_clauses` is
-- the count of policies still naming a role WITHOUT also naming anon -- it must
-- be 0.
select
  policyname,
  permissive,
  roles,
  cmd
  from pg_policies
 where schemaname = 'public'
   and tablename in ('podcasts', 'push_subscriptions')
 order by tablename, policyname;

-- The count that matters. Must be 0.
select count(*) as policies_unreachable_by_anon
  from pg_policies p
 where p.schemaname = 'public'
   and p.tablename in ('podcasts', 'push_subscriptions')
   and array_to_string(p.roles, ',') not like '%anon%'
   and array_to_string(p.roles, ',') <> 'PUBLIC';

-- And the privileges, since RLS is only reached after these are granted.
select table_name, privilege_type
  from information_schema.role_table_grants
 where table_schema = 'public'
   and table_name = 'podcasts'
   and grantee = 'anon'
 order by privilege_type;