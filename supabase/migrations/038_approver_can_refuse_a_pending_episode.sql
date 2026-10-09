-- =============================================================================
--  038_approver_can_refuse_a_pending_episode
-- =============================================================================
--
-- WHY
--
-- The panel offers a Board Manager a "Refuse" button on a Writer's pending
-- podcast -- admin.js:4346 renders it inside the branch gated on canApprove(),
-- and the handler at admin.js:7442 lets any approver through. But the database
-- has never permitted the act. Both halves are is_owner() only:
--
--     podcasts_delete            (table)   podcasts_owner_all
--     podcasts_delete_own_pending (table)   is_staff() AND status='pending'
--                                           AND author_account_id = me
--     podcasts_delete          (storage)   bucket_id='podcasts' AND is_owner()
--
-- A Manager refusing somebody else's submission matches none of them. And the
-- failure is SILENT, which is why nobody noticed: RLS filters rows rather than
-- raising, so a DELETE matching zero rows returns success. decidePodcast
-- (podcasts.js:698) then reports "Submission refused and its audio purged" and
-- the handler clears podcastQueue -- so the row is still live, still queued, and
-- reappears on the next repaint. The storage purge at podcasts.js:702 is refused
-- too, for the same reason.
--
-- This is not a 035/037 regression. 030 deliberately kept podcasts_delete
-- Owner-only ("the brief did not ask for it") and 033 kept it. So reject-by-
-- approver has never worked, on either half, since the approver tier landed.
--
--  WHAT CHANGES
--
--     1. `wire_can_refuse_episode(object_name)` -- SECURITY DEFINER. True when
--        the session may approve AND the named object is not the audio of a
--        row readers can currently hear. Storage cannot read `podcasts.status`
--        directly: the anon role has no SELECT grant that lets a storage policy
--        join across, so this is the bridge.
--     2. `podcasts_delete_approver_pending` -- may delete a PENDING row.
--        A published row stays Owner-only, so this cannot be used to unpublish.
--     3. `podcasts_delete` (storage) widened to `is_owner() OR
--        wire_can_refuse_episode(name)`.
--
--  THE INVARIANT THAT MATTERS
--
--  `podcasts_delete_approver_pending` is scoped `status = 'pending'`, and the
--  storage helper refuses any object still referenced by a non-pending row. So
--  the two halves cannot be separated: an approver can only purge audio that has
--  no live row behind it. Together they cannot reach a published episode --
--  unpublishing means flipping status, and that stays Owner-only.
--
--  An object with NO row at all (an orphan, or one of the 1-byte write probes)
--  counts as purgeable. That is deliberate: the probe at podcasts.js:246 leaves
--  a stray object on every Writer attempt precisely because cleanup is
--  Owner-only, and an approver being able to sweep those is the point.
--
--  SAFE TO RE-RUN. Idempotent.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. wire_can_refuse_episode()
--
-- STABLE, SECURITY DEFINER: it reads podcasts, which anon cannot select, and it
-- calls can_approve(), which is itself SECURITY DEFINER and would be re-checked
-- anyway. search_path is pinned so a hostile schema cannot shadow it.
-- -----------------------------------------------------------------------------
create or replace function public.wire_can_refuse_episode(p_name text)
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select public.can_approve()
     and not exists (
       select 1
         from public.podcasts p
        where p.storage_path = p_name
          and p.status is distinct from 'pending'
     );
$$;

comment on function public.wire_can_refuse_episode(text) is
  'May this session purge this episode''s audio because the episode is not live? '
  'An approver, and only where no published row points at the object. Deleting '
  'a published episode remains is_owner().';

revoke all on function public.wire_can_refuse_episode(text) from public;
grant execute on function public.wire_can_refuse_episode(text) to anon, authenticated;

-- -----------------------------------------------------------------------------
-- 2. THE ROW
--
-- Deliberately NOT `for all` and NOT status-agnostic. An approver gets the
-- refusal and nothing else; podcasts_owner_all is untouched, so rewriting an
-- episode's byline or repointing its audio stays the Owner's.
-- -----------------------------------------------------------------------------
drop policy if exists podcasts_delete_approver_pending on public.podcasts;
create policy podcasts_delete_approver_pending on public.podcasts
  for delete to anon, authenticated
  using (public.can_approve() and status = 'pending');

-- -----------------------------------------------------------------------------
-- 3. THE AUDIO
--
-- is_owner() first so the Owner's existing path is untouched and readable at a
-- glance in pg_policies; the helper is only consulted for everyone else.
-- -----------------------------------------------------------------------------
drop policy if exists podcasts_delete on storage.objects;
create policy podcasts_delete on storage.objects
  for delete
  using (
    bucket_id = 'podcasts'
    and (
      public.is_owner()
      or public.wire_can_refuse_episode(name)
    )
  );

-- -----------------------------------------------------------------------------
-- 4. Verification.
--
-- (a) The approver delete must be scoped to pending. An unscoped `for delete
--     using (can_approve())` would let a Manager unpublish the front page, so
--     this asserts the clause is still present rather than trusting the CREATE
--     above it.
-- (b) The storage policy must still be bucket-scoped, or it reaches wire-media.
-- (c) The helper must exist, or every purge silently no-ops -- which is the
--     exact bug this migration is fixing, so a missing function would make the
--     fix a no-op that reads as success.
-- (d) podcasts_owner_all must still be is_owner(). If it had been widened
--     earlier, this migration would be layering a limit on a hole.
-- -----------------------------------------------------------------------------
do $$
declare
  loosed text;
begin
  -- `coalesce(qual,'')` on a missing row yields '' and '' ~ pattern is false,
  -- so a policy that simply did not exist sails through. Every check below
  -- therefore tests for PRESENCE first and only then for shape.
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public'
       and tablename  = 'podcasts'
       and policyname = 'podcasts_delete_approver_pending'
       and cmd        = 'DELETE'
  ) then
    raise exception 'podcasts_delete_approver_pending was not created.';
  end if;

  select coalesce(qual, '') into loosed
    from pg_policies
   where schemaname = 'public'
     and tablename  = 'podcasts'
     and policyname = 'podcasts_delete_approver_pending';

  -- pg_get_expr DEQUALIFIES schema names visible in search_path, so this accepts
  -- either rendering of can_approve(). Comparing against 'public.can_approve()'
  -- would never match and the check would verify nothing.
  if loosed !~ 'can_approve\(\)'
     or loosed !~ 'status\s*=\s*''pending'''
  then
    raise exception
      'podcasts_delete_approver_pending is not scoped to pending rows: %', loosed;
  end if;

  if not exists (
    select 1 from pg_policies
     where schemaname = 'storage'
       and tablename  = 'objects'
       and policyname = 'podcasts_delete'
       and coalesce(qual, '') ~ 'bucket_id\s*=\s*''podcasts'''
       and coalesce(qual, '') ~ 'wire_can_refuse_episode'
  ) then
    raise exception
      'podcasts_delete (storage) is not bucket-scoped and approver-widened.';
  end if;

  if not exists (
    select 1
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = 'wire_can_refuse_episode'
       and p.prosecdef
  ) then
    raise exception
      'public.wire_can_refuse_episode(text) is missing or is not SECURITY DEFINER.';
  end if;

  select coalesce(qual, '') into loosed
    from pg_policies
   where schemaname = 'public'
     and tablename  = 'podcasts'
     and policyname = 'podcasts_owner_all';

  if coalesce(loosed, '') !~ '^(public\.)?is_owner\(\)$' then
    raise exception
      'podcasts_owner_all is not is_owner(): %', coalesce(loosed, 'MISSING');
  end if;

  raise notice
    '038 verified: an approver can refuse a pending episode; a published one is still the Owner''s.';
end;
$$;

commit;