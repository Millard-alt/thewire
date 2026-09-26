-- =============================================================================
--  001_case_insensitive_article_status.sql
--  -----------------------------------------------------------------------------
--  Why this exists
--  --------------
--  The seeded rows in `articles.status` are lower case ('published'), but both
--  the column's CHECK constraint and the front-end code use title case
--  ('Published'). Two things follow from that mismatch:
--
--    1. `articles_public_read` compared `status = 'Published'`, so anon readers
--       matched ZERO rows and the front page rendered empty while the admin
--       panel (which does not filter) still showed every article.
--    2. Any write of 'Published' against the existing CHECK constraint would be
--       rejected outright.
--
--  The fix is to stop caring about case at the storage layer. The CHECK
--  constraint is widened to accept both spellings, the RLS policy lower-cases
--  both sides, and existing rows are normalised so everything downstream can
--  keep using a single canonical spelling.
--
--  Safe to run more than once.
-- =============================================================================

-- 1. Normalise existing data to the canonical title case the UI expects.
update public.articles
   set status = initcap(status)
 where status is not null
   and status <> initcap(status);

-- 2. Widen the CHECK so either spelling is accepted on insert/update.
alter table public.articles drop constraint if exists articles_status_check;
alter table public.articles
  add constraint articles_status_check
  check (status in ('Published', 'Pending Review', 'Rejected', 'Archived',
                    'published', 'pending review', 'rejected', 'archived'));

-- 3. Re-point the read policy at a case-insensitive comparison.
drop policy if exists articles_public_read on public.articles;
create policy articles_public_read on public.articles
  for select using (lower(status) = 'published' or public.is_staff());

-- 4. Tell PostgREST to drop its cached view of the schema so the new policy
--    and the deployed functions are visible immediately.
notify pgrst, 'reload schema';

-- -----------------------------------------------------------------------------
--  Verify: this should return one row per article, with title-case statuses.
--    select status, count(*) from public.articles group by status;
-- -----------------------------------------------------------------------------
