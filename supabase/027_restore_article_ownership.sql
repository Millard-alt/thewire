-- =============================================================================
--  supabase/027_restore_article_ownership.sql
--  -----------------------------------------------------------------------------
--  Put back the article ownership that 026 cleared in error, and stop the
--  byline-to-account inference for good.
--
--  WHAT HAPPENED
--  -------------
--  026 cleared one correct link. The Owner had posted an article bylined
--  "Mercy Kamande" while signed in as the Owner account, and 026 read the
--  disagreement between the byline and the account as evidence that the link was
--  wrong. It was not.
--
--  articles.author is a byline -- a credit to the person the story belongs to.
--  articles.author_account_id is a PERMISSIONS pointer -- the account that may
--  edit and delete the row. Migration 007 is explicit:
--
--      articles.author_account_id points at staff_accounts.id - the account the
--      author SIGNS IN WITH
--
--      comment on column public.articles.author_account_id is
--        '... NULL means ownership unknown; only the Owner may delete that row.'
--
--  An Owner posting a piece credited to a reporter is ordinary practice. On a
--  paper where one person holds the login, it is the normal case. 026 assumed
--  the two columns describe the same person and cleared correct data on that
--  assumption.
--
--  THE RULE FROM HERE ON
--  ---------------------
--  author_account_id is NEVER inferred from articles.author. Not by a migration,
--  not by a repair script, not by the client. Two reasons:
--
--   1. It is a guess, and it was wrong here. A byline can name anybody.
--   2. Getting it wrong is not cosmetic. It decides who may delete the row.
--      Guessing low leaves the Owner able to tidy up; guessing high hands a
--      stranger the delete button on somebody else's story.
--
--  Where a link is already correct it is left alone. This script touches ONLY
--  rows that are currently NULL, so it cannot overwrite an attribution that is
--  already right.
--
--  STEP 1 IS READ-ONLY. Run it, read the list, then run STEP 2.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- STEP 1 — find the article(s) to restore. Changes nothing.
--
-- `was_created` cross-references audit_logs on the action text
-- `Created article "<title>"`, which is what src/lib/store.js writes. NOTE that
-- audit_logs.actor_name is hard-coded to 'Owner' by addAuditLog()'s default and
-- is NOT the account that created the row, so it cannot identify who posted
-- what -- it only confirms the story exists in the trail and roughly when. There
-- is no column anywhere that records the creating account for an article, so the
-- restore below is necessarily the Owner's call.
-- -----------------------------------------------------------------------------
select a.id,
       a.title,
       a.author                                       as byline,
       a.published_at,
       a.created_at,
       exists (
         select 1 from audit_logs l
          where l.action = 'Created article "' || a.title || '"'
       )                                              as in_audit_trail
  from public.articles a
 where a.author_account_id is null
 order by a.created_at desc nulls last;

-- -----------------------------------------------------------------------------
-- STEP 2 — restore. FILL IN THE ARTICLE UUID AND THE OWNER ACCOUNT UUID.
--
-- Both are read-only queries above this line:
--   • the article id comes from STEP 1
--   • the account id comes from:
--
--       select id, username, display_name, is_owner
--         from public.staff_accounts
--        where is_owner;                    -- exactly one row; the CHECK on
--                                             staff_accounts_one_owner_idx
--                                             allows only one
--
-- The WHERE clause pins `author_account_id is null` on purpose: this restores a
-- link that 026 cleared and cannot overwrite one that is already correct. Run it
-- once per article.
--
-- articles_reassign_guard_trg raises 'only the Owner can reassign an article' on
-- any change to this column, and public.is_owner() resolves a bearer token the
-- SQL Editor never sends -- so it is false here, for every row. The trigger has
-- to stand down for the write and is re-enabled immediately after, inside a
-- subtransaction that restores it if anything fails.
-- -----------------------------------------------------------------------------
do $$
declare
  v_article uuid := 'PASTE-THE-ARTICLE-UUID-HERE';
  v_owner   uuid := 'PASTE-THE-OWNER-ACCOUNT-UUID-HERE';
  v_linked  integer;
begin
  if v_article = 'PASTE-THE-ARTICLE-UUID-HERE'::uuid
     or v_owner = 'PASTE-THE-OWNER-ACCOUNT-UUID-HERE'::uuid then
    raise exception 'Fill in both UUIDs at the top of the DO block first.';
  end if;

  begin
    if exists (
      select 1 from pg_trigger
       where tgrelid = 'public.articles'::regclass
         and tgname  = 'articles_reassign_guard_trg'
         and not tgisinternal
    ) then
      execute 'alter table public.articles disable trigger articles_reassign_guard_trg';
    end if;

    update public.articles
       set author_account_id = v_owner
     where id = v_article
       and author_account_id is null;

    get diagnostics v_linked = row_count;

    if v_linked = 0 then
      raise warning
        'Nothing restored. Either the article id is wrong, or that row is not NULL any more -- in which case it already has an owner and this script correctly left it alone.';
    end if;
  exception when others then
    raise;
  end;

  execute 'alter table public.articles enable trigger articles_reassign_guard_trg';

  raise notice 'articles: % link(s) restored.', v_linked;
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
-- `byline_matches_account` is EXPECTED TO BE FALSE for a story the Owner posted
-- in somebody else's name. That is the correct state, not a fault. It is printed
-- so nobody re-runs 026 and "fixes" it again.
-- -----------------------------------------------------------------------------
select a.title,
       a.author                                       as byline,
       coalesce(acct.username, '(none)')              as owner_username,
       coalesce(acct.display_name, '(none)')          as owner_display_name,
       lower(trim(coalesce(acct.display_name, '')))
         = lower(trim(coalesce(a.author, '')))         as byline_matches_account
  from public.articles a
  left join public.staff_accounts acct on acct.id = a.author_account_id
 order by a.published_at desc nulls last;
