-- =============================================================================
--  supabase/026_repair_article_attribution.sql
--  -----------------------------------------------------------------------------
--  ⚠ SUPERSEDED BY supabase/027_restore_article_ownership.sql — READ THAT FIRST
--
--  This file ran, and it cleared one link that was CORRECT. The Owner had posted
--  an article bylined "Mercy Kamande" while signed in as the Owner account, and
--  step 1 below read the disagreement between the byline and the account as proof
--  of mis-attribution. It was not proof of anything. It is the normal case.
--
--  THE ERROR, STATED PLAINLY
--  -------------------------
--  This file assumed `articles.author` (a byline credit) and
--  `articles.author_account_id` (an account pointer) describe the same person.
--  They do not, and migration 007 says so in as many words:
--
--      articles.author_account_id points at staff_accounts.id - the account the
--      author SIGNS IN WITH.
--
--      comment on column public.articles.author_account_id is
--        'staff_accounts.id of the author. NULL means ownership unknown; only
--         the Owner may delete that row.'
--
--  The column is a PERMISSIONS pointer: who may edit and delete the row. The
--  Owner publishing a piece credited to a reporter is ordinary practice, and on a
--  single-desk paper it is the normal case -- the Owner holds the login, the
--  story belongs to somebody else.
--
--  So "the byline does not match the account" is not evidence of a bad link. It
--  is evidence of a normal editorial relationship, and clearing on it destroys
--  correct data.
--
--  Nothing in this file is reused by 027: the corroboration rule, the display_name
--  requirement and the uniqueness guards all exist only to support an inference
--  from the byline to an account, and that inference is unsound. It is left here
--  as a record of what was tried and why it was wrong.
--
--  WHAT WAS ACTUALLY WRONG, for the record
--  ---------------------------------------
--  The one real defect this file chased was `min(a2.id)` over a uuid, which
--  Postgres does not provide (ERROR 42883), and the unguarded username hop
--  behind it. Both were genuine. Neither was what made the bylines inconsistent.
--
--  The bylines were inconsistent because the CLIENT resolved portraits through
--  `author_account_id` at all: three articles bylined "Mercy Kamande" pointed at
--  her account and showed her profile, the fourth pointed at the Owner's and
--  showed the Owner's. One byline, two faces. That was fixed in
--  src/lib/credits.js by deleting the foreign-key lookup, not here.
--
--  Run 027, not this.
-- =============================================================================
--
--  WHAT WENT WRONG
--  ----------------
--  025 joined articles.author -> staff.name -> staff.username ->
--  staff_accounts.username, and guarded against exactly one thing: two STAFF
--  ROWS SHARING A NAME. It did not guard the second hop. The verify query after
--  025 came back with this row:
--
--      byline_name  "Mercy Kamande"
--      linked       true
--      account_name "Owner"
--      profile_name "Chief Owner"
--
--  An article bylined Mercy Kamande was attributed to the OWNER account. That
--  needs `staff` to hold a row named 'Mercy Kamande' whose USERNAME belongs to
--  the Owner -- i.e. two staff rows sharing one username.
--
--  That is entirely possible, and schema.sql is why: it declares
--
--      create table if not exists public.staff (... username text not null unique ...)
--
--  `if not exists` makes the whole statement a no-op against a table that
--  already exists, so a database created before that line was pasted never got
--  the UNIQUE constraint at all. Nothing in this project has ever verified that
--  staff.username is unique; 025 assumed it.
--
--  So a single ambiguous hop was enough to attribute somebody's byline to the
--  wrong person -- and the owner of the paper, no less.
--
--  THE RULE, RESTATED
--  ------------------
--  An article's ownership is trustworthy only when the PROFILE reached through
--  the account's username carries the same name as the byline, and that pairing
--  is unambiguous in BOTH directions:
--
--      byline name  ==  staff.name reached via account.username
--      exactly one staff row has that name
--      exactly one staff row has that username
--
--  Requiring the profile name rather than staff_accounts.display_name is
--  deliberate. The verify output shows those two disagree on a real account:
--  display_name "Owner" against profile "Chief Owner". display_name is whatever
--  somebody typed at signup; staff.name is the byline the Owner published under.
--  Only the second one is evidence about the byline.
--
--  The Owner is not excluded from this -- the Owner filing their own story is
--  legitimate, and the row above is caught because 'Mercy Kamande' does not
--  match 'Chief Owner', not because of who the account is.
--
--  TWO STEPS, IN ONE TRANSACTION
--  ------------------------------
--  1. CLEAR every link the chain cannot corroborate. Failing closed: an
--     unattributed article is Owner-only, which is the safe direction. A wrong
--     owner is not safe -- it hands one person another person's byline.
--  2. RE-LINK the articles that do satisfy the rule, preferring an approved
--     account.
--
--  Anything step 1 clears is listed by the query at the bottom, so review it
--  before you assume it was all noise.
--
--  STEP 1 AND STEP 2 USE DIFFERENT BARRIERS ON PURPOSE
--  ---------------------------------------------------
--  Step 2 demands `staff_accounts.display_name` agree with `staff.name`. That is
--  the check that would have stopped the mis-link above -- the account said
--  "Owner" and the byline said "Mercy Kamande" -- and it costs coverage: an
--  account whose signup display_name differs from the byline they publish under
--  will not be auto-linked. Those people stay Owner-only, which is safe.
--
--  Step 1 does NOT demand it. There the question is not "is this link good?" but
--  "is this link PROVABLY wrong?", and a link whose byline matches its profile
--  name is not provably wrong -- clearing it would be destroying an attribution
--  on the strength of a field we have already seen disagree legitimately (this
--  very database: display_name "Owner", profile "Chief Owner").
--
--  Strict about creating a link, lenient about destroying one.
--
--  REQUIRES migrations 007 and 025.
--  Run in the Supabase SQL Editor.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- STEP 0 — read-only. Run this on its own FIRST if you want to see the shape of
-- the data before anything is written.
--
-- 0a. THE ONE THAT MATTERS. Any row returned here is the root cause of the 025
--     mis-attribution, and a login bug besides: wire_login() resolves an account
--     BY USERNAME, so two accounts sharing one makes "who signs in" ambiguous.
--     Expect zero rows. The Owner's call on how to resolve a clash -- renaming,
--     merging, deleting -- is not something a migration should do for them.
-- -----------------------------------------------------------------------------
select username,
       count(*)                     as accounts,
       string_agg(
         coalesce(display_name, '(no name)') || ' [' || status || ']'
               || case when is_owner then ' OWNER' else '' end,
         ', ' order by created_at)  as who
  from public.staff_accounts
 group by username
having count(*) > 1
 order by username;

-- -----------------------------------------------------------------------------
-- 0b. Is the UNIQUE constraint actually there?
--
--     Both tables declare `username text not null unique`, but inside
--     `create table if not exists` -- a no-op against a live table. `has_unique`
--     below is FALSE for any database created before that line was pasted, which
--     is the state this repair was written for. On those, step 2's fourth guard
--     is what stops a byline being attributed to whichever account it lands on.
--
--     Once the duplicates above are resolved by hand, the two ALTER TABLE lines
--     at the very bottom of this file make the guarantee real. Run them then, not
--     before.
-- -----------------------------------------------------------------------------
select c.relname                                as table_name,
       exists (
         select 1 from pg_index i
          where i.indrelid = c.oid and i.indisunique
            and i.indnatts = 1
            and (select a.attname from pg_attribute a
                  where a.attrelid = c.oid and a.attnum = i.indkey[0]) = 'username'
       )                                        as username_is_unique
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public'
   and c.relname in ('staff', 'staff_accounts')
 order by c.relname;

-- 0c. Staff rows whose NAME or USERNAME is shared by another staff row. Also
--     expect zero rows; step 2 refuses to guess past either, so an unresolved
--     clash leaves that person's articles Owner-only.
--
--     Deliberately not joined to staff_accounts: 0a already covers that side, and
--     a join here would fan out on a duplicate username and report an arbitrary
--     account against each staff row -- the very confusion this file exists to
--     remove.
select s.name,
       s.username,
       s.role,
       s.status,
       (select count(*) from public.staff x
         where lower(trim(coalesce(x.name, '')))
             = lower(trim(coalesce(s.name, ''))))  as name_clash,
       (select count(*) from public.staff y
         where y.username = s.username)             as username_clash
  from public.staff s
 order by username_clash desc, name_clash desc, s.username;

-- -----------------------------------------------------------------------------
-- STEP 1 + 2 — repair, then re-link. Both need the reassignment guard out of
-- the way; see the note inside the block.
-- -----------------------------------------------------------------------------
do $$
declare
  v_cleared integer;
  v_linked  integer;
  v_orphan  integer;
  v_user    text;
begin
  begin
    -- articles_reassign_guard_trg raises 'only the Owner can reassign an article'
    -- on any change to author_account_id, and public.is_owner() resolves a bearer
    -- token the SQL Editor never sends -- so it is false here, for every row.
    -- Linking NULL to an account IS a reassignment, so the guard has to stand
    -- down for both statements below.
    --
    -- `disable` runs inside this subtransaction and the `enable` outside it, so a
    -- failure here restores the trigger by rolling the subtransaction back --
    -- without depending on the outer transaction also aborting.
    if exists (
      select 1 from pg_trigger
       where tgrelid = 'public.articles'::regclass
         and tgname  = 'articles_reassign_guard_trg'
         and not tgisinternal
    ) then
      execute 'alter table public.articles disable trigger articles_reassign_guard_trg';
    end if;

    -- STEP 1: drop every link the whole chain fails to corroborate.
    --
    -- Cleared, deliberately, when ANY of these hold:
    --   • the account has no staff profile at all (so nothing can vouch for the
    --     byline name),
    --   • the profile's name differs from the byline,
    --   • two staff rows share that name,
    --   • two staff rows share that username.
    --
    -- `not acct.is_owner` is deliberately absent: a suspended Owner still owns
    -- their own articles, and the mis-link above is caught on the name.
    update public.articles a
       set author_account_id = null
     where a.author_account_id is not null
       and not exists (
         select 1
           from public.staff_accounts acct
           join public.staff st
             on st.username = acct.username
          where acct.id = a.author_account_id
            and lower(trim(coalesce(st.name, '')))
                = lower(trim(coalesce(a.author, '')))
            and (select count(*) from public.staff x
                  where lower(trim(coalesce(x.name, '')))
                      = lower(trim(coalesce(st.name, '')))) = 1
            and (select count(*) from public.staff y
                  where y.username = st.username) = 1
       );

    get diagnostics v_cleared = row_count;

    -- STEP 2: re-link what does satisfy the rule.
    --
    -- `linkable` yields AT MOST one row per name, and every hop proves it rather
    -- than assuming it:
    --
    --   1. exactly one staff row carries the name,
    --   2. exactly one staff row carries the username,
    --   3. exactly ONE staff_accounts row carries that username,
    --   4. that account's display_name agrees with the staff row's name.
    --
    -- (3) is the guard 025 lacked and is why this CTE must not be trusted to
    -- "obviously" be one row per name: staff_accounts.username is declared
    -- UNIQUE in credentials.sql, but that declaration sits inside a
    -- `create table if not exists`, which is a no-op against a live table. A
    -- database built before that line was pasted has NO constraint there, so two
    -- accounts can share a username. This CTE has no GROUP BY -- if that
    -- happened, UPDATE ... FROM would silently pick one of the two rows and
    -- attribute the byline to whichever account it liked. That is the exact
    -- failure 025 produced: one staff row, two accounts, `min(uuid)` choosing the
    -- Owner.
    --
    -- A scalar-subquery rewrite would raise instead of guessing, but the four
    -- count() guards make multiple rows unreachable, which is cheaper to reason
    -- about than an exception as a control-flow mechanism.
    --
    -- An unapproved account never receives an article: nobody the Owner has not
    -- signed off on acquires a byline.
    with linkable as (
      select lower(trim(coalesce(st.name, ''))) as match_name,
             acct.id                           as account_id
        from public.staff st
        join public.staff_accounts acct
          on acct.username = st.username
       where not acct.is_owner
         and lower(trim(coalesce(acct.status, ''))) <> 'pending'
         and lower(trim(coalesce(acct.display_name, '')))
             = lower(trim(coalesce(st.name, '')))
         and (select count(*) from public.staff x
               where lower(trim(coalesce(x.name, '')))
                   = lower(trim(coalesce(st.name, '')))) = 1
         and (select count(*) from public.staff y
               where y.username = st.username) = 1
         and (select count(*) from public.staff_accounts c
               where c.username = st.username) = 1
    )
    update public.articles a
       set author_account_id = l.account_id
      from linkable l
     where a.author_account_id is null
       and lower(trim(coalesce(a.author, ''))) <> ''
       and l.match_name = lower(trim(coalesce(a.author, '')));

    get diagnostics v_linked = row_count;
  exception when others then
    raise;
  end;

  execute 'alter table public.articles enable trigger articles_reassign_guard_trg';

  select count(*) into v_orphan
    from public.articles
   where author_account_id is null;

  -- Duplicate usernames in staff_accounts are the root cause of the 025 mis-link,
  -- and they are also a LOGIN problem in their own right: wire_login() resolves
  -- an account by username, so two accounts sharing one is ambiguous about who
  -- signs in. Reported, never fixed here -- merging or renaming accounts is the
  -- Owner's decision, and this script has no business doing it silently.
  --
  -- Deleting any of these rows is what step 2's fourth guard refuses to guess
  -- past, so an unresolved clash leaves that person's articles Owner-only rather
  -- than attributed to a coin flip.
  raise notice '--- staff_accounts usernames claimed more than once ---';
  for v_user in
    select c.username
      from public.staff_accounts c
     group by c.username
    having count(*) > 1
     order by c.username
  loop
    raise notice '  % -> % account(s): %',
      v_user,
      (select count(*) from public.staff_accounts c where c.username = v_user),
      (select string_agg(
                coalesce(c.display_name, '(no name)') || ' [' || c.status || ']'
                      || case when c.is_owner then ' OWNER' else '' end,
                ', ' order by c.created_at)
           from public.staff_accounts c
          where c.username = v_user);
  end loop;

  raise notice 'articles: % link(s) CLEARED as mis-attributed.', v_cleared;
  raise notice 'articles: % row(s) (re)linked under the strict rule.', v_linked;
  raise notice 'articles: % now unattributed (Owner-only).', v_orphan;
  raise notice
    'The verify query below lists every cleared row. Re-link one by hand if the Owner confirms it.';
  raise notice 'articles_reassign_guard_trg tgenabled = % (expect O)',
    coalesce((
      select tgenabled::text from pg_trigger
       where tgrelid = 'public.articles'::regclass
         and tgname  = 'articles_reassign_guard_trg'
    ), '(no such trigger)');
end;
$$;

-- -----------------------------------------------------------------------------
-- STEP 3 — verify only. Changes nothing.
--
-- `ok` is the whole point of this repair: every linked row must agree with
-- itself across all three names. Read the false rows -- those are either a
-- duplicate in `staff` that step 2 refused to guess at, or a byline nobody has a
-- profile for yet.
-- -----------------------------------------------------------------------------
select a.author                                       as byline_name,
       a.author_account_id is not null                 as linked,
       coalesce(acct.display_name, '(no account)')     as account_name,
       coalesce(s.name, '(no profile)')                as profile_name,
       coalesce(s.portrait_status, '(none)')           as portrait_review,
       case when s.portrait_status = 'approved' then s.portrait_url end as portrait,
       case
         when a.author_account_id is null then null  -- unattributed on purpose
         when s.name is null                  then false
         when lower(trim(coalesce(s.name, '')))
              <> lower(trim(coalesce(a.author, ''))) then false
         else true
       end                                             as ok
  from public.articles a
  left join public.staff_accounts acct on acct.id = a.author_account_id
  left join public.staff s             on s.username = acct.username
 order by ok desc nulls last, a.published_at desc nulls last;

-- =============================================================================
--  STEP 4 — make the uniqueness real. NOT RUN BY THIS SCRIPT.
--
--  Left commented out on purpose. These two statements FAIL if a duplicate still
--  exists, which is exactly why they must not run before the Owner has decided
--  what to do with the clashes 0a found: renaming, merging and deleting accounts
--  are all editorial calls, and a migration that silently picked one would be
--  repeating the bug it exists to fix.
--
--  Run them by hand once 0a returns no rows, and keep the comments -- the
--  `if not exists` form is what let the original declarations evaporate.
-- =============================================================================
--
--  alter table public.staff_accounts
--    add constraint staff_accounts_username_key unique (username);
--
--  alter table public.staff
--    add constraint staff_username_key unique (username);
