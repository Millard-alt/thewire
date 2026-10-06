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
--  007's OWN backfill never ran, which is the reason this file is not optional.
--  Its query selects `min(id)` over `staff_accounts.id`, which is a uuid, and
--  Postgres ships no min(uuid) aggregate:
--
--      ERROR:  42883:  function min(uuid) does not exist
--
--  That aborts the DO block, so no row was ever linked by 007 -- for any
--  reason, ambiguity included. If you pasted 007 as one script the failure
--  rolled the whole file back; if you pasted it in pieces, the column, policies
--  and trigger are in place and only the backfill silently never happened.
--  Either way the practical effect was the same: articles.author_account_id was
--  NULL across the board, every byline took the name path, and one author could
--  be seen wearing two different faces. 007 is left untouched on purpose -- the
--  convention in this repository is to repair with a new numbered file rather
--  than edit a migration somebody has already run -- and this file supersedes
--  its backfill.
--
--  ⚠ SUPERSEDED IN PART — READ supabase/026_repair_article_attribution.sql
--  025 guarded the FIRST hop of the join (two staff rows sharing a name) but not
--  the SECOND (two staff rows sharing a username), so it attributed an article
--  bylined "Mercy Kamande" to the Owner account. staff.username carries no
--  UNIQUE constraint in a live database, because schema.sql declares it inside a
--  `create table if not exists` that is a no-op against an existing table.
--  ⚠ SUPERSEDED BY supabase/027_restore_article_ownership.sql — READ THAT FIRST
--
--  This file BACKFILLED author_account_id by inferring it from the byline, and
--  that inference is unsound: the column is a permissions pointer, not an
--  authorship credit (migration 007: "the account the author SIGNS IN WITH").
--  The Owner posting a story bylined to a reporter is normal, so a byline is no
--  evidence at all about who owns the row. 026 then "repaired" this file's output
--  by clearing links whose byline disagreed with the account, and destroyed a
--  correct one. 027 restores it.
--
--  For a FRESH database, do not run this file at all: 027's doctrine is that the
--  column is only ever written by whoever actually posts, from the session, and
--  never inferred.
--
--  SAFETY
--  ------
--  • Only accounts that are NOT the pending queue are linked: an account nobody
--    has approved must not acquire an author.
--  • An ambiguous name -- two staff rows sharing one name -- matches nothing and
--    stays NULL. Same reasoning as 007: guessing an owner is worse than having
--    no owner.
--  • Only NULL rows are touched, so this never reassigns an article that is
--    already owned.
--  • articles_reassign_guard_trg is disabled for the UPDATE and re-enabled
--    immediately after, inside a subtransaction that restores it if the UPDATE
--    fails. It has to be: linking NULL to an account IS a reassignment, and
--    is_owner() is false in the SQL Editor, so the guard would raise 42501 on the
--    first row otherwise. The run reports the trigger's final state so a disable
--    that somehow stuck is visible in the output rather than silent.
--  • Articles that still cannot be attributed are reported, never silent.
--
--  REQUIRES migration 007: it reads and writes articles.author_account_id. If
--  that column is missing, run 007 first.
--
--  Run in the Supabase SQL Editor.
-- =============================================================================

do $$
declare
  v_linked    integer;
  v_ambiguous integer;
  v_orphan    integer;
begin
  -- THE REASSIGNMENT GUARD HAS TO STAND DOWN FOR THIS, AND THAT IS NOT OPTIONAL.
  --
  -- articles_reassign_guard_trg is a BEFORE UPDATE trigger that raises
  -- 'only the Owner can reassign an article' whenever author_account_id actually
  -- changes. `public.is_owner()` resolves the caller's session through
  -- wire_bearer_token(), and the SQL Editor sends no bearer token at all -- so
  -- is_owner() is FALSE here, for every row, no matter who owns the database.
  --
  -- Which means the backfill cannot merely avoid reassigning anything: it cannot
  -- run at all without the trigger out of the way, because every row it touches
  -- IS a reassignment (NULL -> an account). 007's own backfill was written
  -- without this and would have aborted on its first row for the same reason it
  -- aborted on min(uuid).
  --
  -- Scoped to this DO block. The `disable` happens inside the subtransaction
  -- below and the `enable` outside it, so a failure anywhere in the UPDATE
  -- restores the trigger by rolling the subtransaction back -- without depending
  -- on the outer transaction also aborting, which is the only thing that would
  -- save us if this were ever run outside a transaction (psql with autocommit,
  -- a migration runner that wraps nothing).
  --
  -- The existence check keeps the script runnable on a database where 007 was
  -- never pasted: `disable trigger` on a missing trigger is itself an error.
  --
  -- The subtransaction is a block with an EXCEPTION clause, which is what makes
  -- the rollback local.
  begin
    if exists (
      select 1 from pg_trigger
       where tgrelid = 'public.articles'::regclass
         and tgname  = 'articles_reassign_guard_trg'
         and not tgisinternal
    ) then
      execute 'alter table public.articles disable trigger articles_reassign_guard_trg';
    end if;

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
               -- Postgres has NO min()/max() aggregate for uuid: it ships
               -- min(uuid) nowhere in the catalog, so `min(a2.id)` fails with
               --   ERROR: 42883 function min(uuid) does not exist
               -- and the whole DO block aborts. Sorting the text form is the
               -- portable equivalent, and it is only a tie-break in practice:
               -- `staff_accounts.username` is NOT NULL UNIQUE, and the join above
               -- is restricted to names exactly one staff row claims, so there is
               -- only ever one account to choose. The GROUP BY is kept for that
               -- same reason -- it guarantees one row per match_name, so this
               -- UPDATE ... FROM can never be handed a duplicate.
               min(a2.id::text)::uuid as account_id
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
  exception when others then
    raise;
  end;

  execute 'alter table public.articles enable trigger articles_reassign_guard_trg';

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

  -- Proof the guard is back. 'O' is the pg_trigger.tgenabled code for ENABLED
  -- ORIGINALLY; 'D' would mean DISABLED, i.e. a run that left it off.
  raise notice 'articles_reassign_guard_trg tgenabled = % (expect O)',
    coalesce((
      select tgenabled::text from pg_trigger
       where tgrelid = 'public.articles'::regclass
         and tgname  = 'articles_reassign_guard_trg'
    ), '(no such trigger)');
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
