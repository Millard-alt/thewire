-- =============================================================================
--  supabase/025_backfill_article_ownership.sql
--  -----------------------------------------------------------------------------
--  Give every article that CAN be attributed to a newsroom account its
--  author_account_id, so byline portraits resolve by foreign key.
--
--  WHY THIS IS NEEDED
--  ------------------
--  007 added articles.author_account_id and backfilled it by matching
--  articles.author against staff_accounts.display_name -- an EXACT, case-folded
--  string match that also required the display name to be unique across the
--  roster. Everything it could not match was left NULL on purpose ("failing
--  closed is the safe direction", and rightly so: a wrong owner grants delete
--  rights to a stranger).
--
--  So in practice a large share of published articles still carry NULL, and the
--  byline falls back to matching the author's NAME. That is where one person
--  came to wear two different faces: an article with an id resolved its portrait
--  from `staff`, and an article without one resolved it from `credits_people`.
--  Two tables, one author, no rule about which wins.
--
--  This script re-does the backfill through the table that actually holds the
--  byline name. `staff` is the public-facing profile table and its column IS
--  `name` -- the same text a writer types into the byline field -- and
--  `staff.username` joins it to `staff_accounts.username`, which is the join
--  `current_staff_id()` already uses. So the match is a join rather than a string
--  coincidence, which fixes every row 007 skipped for having a display_name
--  that differed in case, spacing or middle name.
--
--  SAFETY
--  ------
--  • Only accounts that are NOT the pending queue are linked: an account nobody
--    has approved must not acquire an author.
--  • An ambiguous name -- two staff rows sharing one name -- matches nothing and
--    stays NULL. Same reasoning as 007: guessing an owner is worse than having
--    no owner.
--  • Only NULL rows are touched, so this never reassigns an article that is
--    already owned. (The reassignment guard in 007 is on UPDATE and would raise
--    on a real change; this cannot make one.)
--  • Articles that still cannot be attributed are reported, never silent.
--
--  Run in the Supabase SQL Editor.
-- =============================================================================

do $$
declare
  v_linked  integer;
  v_ambiguous integer;
  v_orphan  integer;
begin
  -- How many staff rows claim each name. Anything but 1 is not a match.
  with roster as (
    select lower(trim(coalesce(s.name, ''))) as match_name,
           count(*)                          as claimants
      from public.staff s
     where s.name is not null
       and trim(s.name) <> ''
     group by lower(trim(coalesce(s.name, '')))
  )
  update public.articles a
     set author_account_id = resolved.account_id
    from (
      select r.match_name,
             min(a2.id) as account_id
        from roster r
        join public.staff st
          on lower(trim(coalesce(st.name, ''))) = r.match_name
         and r.claimants = 1
        join public.staff_accounts a2
          on a2.username = st.username
       where lower(trim(coalesce(a2.status, ''))) <> 'pending'
       group by r.match_name
    ) as resolved
   where a.author_account_id is null
     and lower(trim(coalesce(a.author, ''))) <> ''
     and resolved.match_name = lower(trim(coalesce(a.author, '')));

  get diagnostics v_linked = row_count;

  -- Counted in a subquery: a bare `group by ... having` would return one row per
  -- ambiguous article and `into` would silently take the first.
  select count(*) into v_ambiguous
    from (
      select a.id
        from public.articles a
        join public.staff s
          on lower(trim(coalesce(s.name, ''))) = lower(trim(coalesce(a.author, '')))
       where a.author_account_id is null
       group by a.id
      having count(*) > 1
    ) as clashes;

  select count(*) into v_orphan
    from public.articles
   where author_account_id is null;

  raise notice 'articles: % row(s) linked to an account by this script.', v_linked;
  raise notice 'articles: % still unlinked (% ambiguous name(s) skipped).',
    v_orphan, coalesce(v_ambiguous, 0);
  raise notice
    'The unlinked ones are contributors with no account, or names two staff share. Their bylines still resolve by name -- which now returns the SAME approved photo as a linked row would.';
end;
$$;

-- -----------------------------------------------------------------------------
-- Verify only. Reports the live state and changes nothing.
--
-- Every row should now agree with itself: the article's byline name, and the
-- account it points at, should describe the same person.
-- -----------------------------------------------------------------------------
select a.author                                     as byline_name,
       a.author_account_id is not null               as linked,
       coalesce(acct.display_name, '(no account)')   as account_name,
       coalesce(s.name, '(no profile)')              as profile_name,
       coalesce(s.portrait_status, '(none)')         as portrait_review,
       case when s.portrait_status = 'approved' then s.portrait_url end as portrait
  from public.articles a
  left join public.staff_accounts acct on acct.id = a.author_account_id
  left join public.staff s             on s.username = acct.username
 order by a.published_at desc nulls last;
