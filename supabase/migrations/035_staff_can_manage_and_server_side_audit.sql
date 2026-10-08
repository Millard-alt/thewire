-- =============================================================================
--  035_staff_can_manage_and_server_side_audit
-- =============================================================================
--  WHY
--
--  schema.sql created nine write policies whose only condition was
--  `public.is_staff()` -- true for ANY active staff account, including a
--  Writer. The Owner Panel gates nine tabs by role in the browser, but the
--  database did not agree with it, so every one of those gates was decorative:
--
--      table              policy                     UI gate            actual
--      -----------------  -------------------------  -----------------  --------
--      site_settings      settings_staff_write       OWNER              Writer
--      broadcasts         broadcasts_staff_all       Board Manager      Writer
--      assignments        assignments_staff_write    Board Manager      Writer
--      staff              staff_staff_write          Board Manager      Writer
--      audit_logs         audit_staff_read           OWNER              Writer
--      audit_logs         audit_staff_insert         (server should own) Writer
--      media_assets       media_staff_write          Writer             Writer  ok
--      top_performers     performers_staff_write     Writer             Writer  ok
--      articles           articles_staff_write       (superseded by 007) Writer
--
--  Two distinct problems, and the audit column is the one that matters most:
--
--    * A Writer could insert a broadcast and push it to every subscriber, or
--      rewrite the masthead, without the panel ever showing them the tab.
--
--    * `audit_logs.actor_name` was supplied BY THE CLIENT
--      (src/lib/store.js:801 sent `{ action, actor_name: actor }`). Combined
--      with an insert policy open to all staff, that is not an audit trail --
--      any Writer could write a line naming anyone. An audit log nobody can
--      forge has to derive the actor from the session, server-side.
--
--  WHAT CHANGES
--
--    1. `public.can_manage()` -- Owner or an ACTIVE Board Manager.
--    2. The four manager/owner policies re-scoped to match the UI.
--    3. `audit_logs` reads become Owner-only; inserts go through a SECURITY
--       DEFINER function that fills `actor_name` from the session.
--    4. Direct INSERT on `audit_logs` is revoked, so the function is the only
--       way in.
--    5. media_assets / top_performers keep Writer writes but DELETE becomes
--       Owner-only: deleting someone's portrait or a gallery photo is not a
--       Writer's decision.
--
--  NOT CHANGED
--
--  `articles_staff_write` is left alone. 007 replaces it with per-operation
--  ownership policies and 033 adds the approver tier; dropping it here would
--  silently remove every article write path on any database where 007 has not
--  been applied. Section 6 asserts its absence instead, so a partially
--  migrated database is reported rather than quietly half-secured.
--
--  `actor_id` still references `auth.users(id)`. This project has no Supabase
--  Auth, so that column is permanently NULL and the FK is inert. The
--  authoritative actor now lives in `actor_name`, filled by the database.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
--  1. can_manage()
--
--  Identical to can_approve() today (033:64), and deliberately a separate
--  function: "may approve a row" and "may administer the newsroom" are the
--  same set of people by accident, not by definition, and they should be able
--  to diverge without editing every policy that uses them.
--
--  SECURITY DEFINER because staff_accounts is not readable by the anon role
--  that PostgREST evaluates these policies as.
-- -----------------------------------------------------------------------------
create or replace function public.can_manage()
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select public.is_owner()
      or exists (
    select 1
      from public.staff_accounts a
     where a.id = public.current_account_id()
       and a.status = 'active'
       and a.role = 'Board Manager'
  );
$$;

comment on function public.can_manage() is
  'May this session administer newsroom configuration? The Owner seat, or an '
  'ACTIVE Board Manager. Gates roster, assignments, broadcasts and settings.';

revoke all on function public.can_manage() from public;
grant execute on function public.can_manage() to anon, authenticated;

-- -----------------------------------------------------------------------------
--  2. Re-scope the policies that disagreed with the panel.
-- -----------------------------------------------------------------------------

-- MASTHEAD / BREAKING / CURATION: Owner-only in the panel (Branding, Breaking).
drop policy if exists settings_staff_write on public.site_settings;
create policy settings_staff_write on public.site_settings
  for all using (public.is_owner()) with check (public.is_owner());

-- BROADCASTS: Board Manager+. Firing one reaches every subscriber, so this is
-- the widest blast radius of any table here.
drop policy if exists broadcasts_staff_all on public.broadcasts;
create policy broadcasts_staff_all on public.broadcasts
  for all using (public.can_manage()) with check (public.can_manage());

-- ASSIGNMENTS: Board Manager+.
drop policy if exists assignments_staff_write on public.assignments;
create policy assignments_staff_write on public.assignments
  for all using (public.can_manage()) with check (public.can_manage());

-- ROSTER: Board Manager+. A Writer previously could rewrite or delete any
-- staff row, including portrait approval state and the credits metadata.
drop policy if exists staff_staff_write on public.staff;
create policy staff_staff_write on public.staff
  for all using (public.can_manage()) with check (public.can_manage());

-- AUDIT READ: Owner-only, matching the panel's Changelog/audit tab.
drop policy if exists audit_staff_read on public.audit_logs;
create policy audit_staff_read on public.audit_logs
  for select using (public.is_owner());

-- -----------------------------------------------------------------------------
--  3. AUDIT WRITES: server-side only.
--
--  SECURITY DEFINER so the insert bypasses the (now absent) staff insert policy
--  and RLS. The actor is read from the session, never from the arguments --
--  that is the whole point. `wire_log_audit` takes only the action text.
--
--  42501 is `insufficient_privilege`, so a rejected call surfaces in the client
--  as a permission error rather than a generic failure.
-- -----------------------------------------------------------------------------
create or replace function public.wire_log_audit(p_action text)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_actor text;
begin
  if p_action is null or btrim(p_action) = '' then
    raise exception 'audit_action_required' using errcode = '22023';
  end if;

  select coalesce(a.username, s.display_name, a.username)
    into v_actor
    from public.staff_accounts a
    left join public.staff s
           on lower(trim(s.username)) = lower(trim(a.username))
   where a.id = public.current_account_id()
     and a.status = 'active'
   limit 1;

  if v_actor is null then
    raise exception 'audit_not_permitted' using errcode = '42501';
  end if;

  insert into public.audit_logs (actor_name, action)
  values (left(v_actor, 120), left(btrim(p_action), 500));
end;
$$;

comment on function public.wire_log_audit(text) is
  'Append an audit entry for the current session. The actor is derived from the '
  'bearer token, so a caller cannot write a log line naming somebody else.';

revoke all on function public.wire_log_audit(text) from public;
grant execute on function public.wire_log_audit(text) to anon, authenticated;

-- Remove the open insert policy, then remove the table privilege behind it, so
-- a direct POST to /rest/v1/audit_logs fails even if a future migration
-- re-creates a permissive policy by accident.
drop policy if exists audit_staff_insert on public.audit_logs;
revoke insert on public.audit_logs from anon, authenticated;

-- -----------------------------------------------------------------------------
--  4. Writer keeps the Media and Performers tabs; DELETE becomes Owner-only.
--
--  These two were already correctly open to a Writer for insert and update, so
--  the only change is taking the destructive half away.
-- -----------------------------------------------------------------------------
drop policy if exists media_staff_write on public.media_assets;
create policy media_staff_write on public.media_assets
  for insert with check (public.is_staff());
drop policy if exists media_staff_update on public.media_assets;
create policy media_staff_update on public.media_assets
  for update using (public.is_staff()) with check (public.is_staff());
drop policy if exists media_owner_delete on public.media_assets;
create policy media_owner_delete on public.media_assets
  for delete using (public.is_owner());

drop policy if exists performers_staff_write on public.top_performers;
create policy performers_staff_write on public.top_performers
  for insert with check (public.is_staff());
drop policy if exists performers_staff_update on public.top_performers;
create policy performers_staff_update on public.top_performers
  for update using (public.is_staff()) with check (public.is_staff());
drop policy if exists performers_owner_delete on public.top_performers;
create policy performers_owner_delete on public.top_performers
  for delete using (public.is_owner());

-- -----------------------------------------------------------------------------
--  5. Verification.
-- -----------------------------------------------------------------------------
do $$
declare
  loose text;
begin
  -- (a) nothing may still write these tables on a bare is_staff().
  -- `tablename`, NOT `table_name`. pg_policies exposes schemaname / tablename /
  -- policyname / permissive / roles / cmd / qual / with_check. `table_name`
  -- exists on information_schema.columns, which is where this mistake came
  -- from, but not here -- so the whole statement failed with 42703.
  --
  -- The regex, and not `= 'public.is_staff()'`, is load-bearing. pg_policies
  -- renders `qual` through pg_get_expr, which DEQUALIFIES any schema name that
  -- is visible in the current search_path. A policy written
  -- `using (public.is_staff())` therefore reads back as `is_staff()`, so an
  -- exact comparison against the qualified spelling never matches and this
  -- check silently passed forever -- a verification that verified nothing.
  -- `^(public\.)?is_staff\(\)$` accepts either rendering and still refuses
  -- anything that has grown a real condition around it.
  select string_agg(tablename || '.' || policyname, ', ' order by tablename)
    into loose
    from pg_policies
   where schemaname = 'public'
     and tablename in ('site_settings', 'broadcasts', 'assignments', 'staff')
     and coalesce(qual, '') ~ '^(public\.)?is_staff\(\)$'
     and coalesce(with_check, '') ~ '^(public\.)?is_staff\(\)$';

  if loose is not null then
    raise exception 'still gated on a bare is_staff(): %', loose;
  end if;

  -- (b) audit_logs must have no insert path for anon/authenticated.
  if exists (
    select 1 from pg_policies
     where schemaname = 'public'
       and tablename  = 'audit_logs'
       and cmd in ('INSERT', 'ALL')
  ) then
    raise exception
      'audit_logs still has an insert policy. A Writer could still forge a log line.';
  end if;

  -- (c) audit read must be Owner-only.
  select coalesce(qual, '') into loose
    from pg_policies
   where schemaname = 'public'
     and tablename  = 'audit_logs'
     and cmd        = 'SELECT';

  -- `<>`/regex, not `IS NOT`. `IS NOT` is not a text comparison
  -- operator (it is NULL/TRUE/DISTINCT FROM), so writing it here is a 42601
  -- syntax error. The coalesce also matters: if no SELECT policy existed, `loose`
  -- would be NULL and `NULL <> '...'` is NULL, which is not TRUE -- the missing
  -- policy would sail through the very check meant to catch it.
  --
  -- Prefix tolerance for the same reason as check (a): pg_policies renders this
  -- predicate as `is_owner()`, without the `public.` schema qualifier. An exact
  -- comparison against 'public.is_owner()' therefore always mismatched, and the
  -- migration aborted on a policy that was in fact correct.
  if coalesce(loose, '') !~ '^(public\.)?is_owner\(\)$' then
    raise exception 'audit_logs read policy is not is_owner(): %', coalesce(loose, 'MISSING');
  end if;

  -- (d) the RPC must exist and be executable, or every audit write in the app
  --     breaks at the next admin action.
  if not exists (
    select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = 'wire_log_audit'
  ) then
    raise exception 'public.wire_log_audit(text) was not created.';
  end if;

  -- (e) 007 must have run. If it has not, articles_staff_write is still the
  --     broad `for all ... is_staff()` policy from schema.sql, and this
  --     migration has NOT secured article writes.
  if exists (
    select 1 from pg_policies
     where schemaname = 'public'
       and tablename  = 'articles'
       and policyname = 'articles_staff_write'
  ) then
    raise exception
      'articles_staff_write still exists, so migration 007 has not been applied '
      'to this database. Article writes remain open to every staff member. Run '
      '007 and 033, then re-run 035.';
  end if;

  raise notice '035 verified: policies re-scoped, audit writes server-side only.';
end;
$$;

commit;
