-- =============================================================================
--  039_claim_next_broadcast
-- =============================================================================
--
--  Symptom
--    A broadcast can reach every subscriber twice.
--
--  `api/send-push.js` finds work by SELECTing `pushed_at is null`, sends to the
--  subscriber list, and only THEN stamps `pushed_at`. Those are two statements
--  and two round trips, so between them another invocation can read the same
--  unpushed row and send it as well.
--
--  That was survivable while the only caller was a Vercel cron on a slow
--  cadence. It is not survivable on an external scheduler firing every minute:
--  a send to several hundred devices takes seconds, so the overlap is routine
--  rather than exceptional, and a retry after a timeout doubles it deliberately.
--
--  Why this needs SQL
--  There is no atomic "select the next thing and mark it done" in the client.
--  Read-then-write from JavaScript has a window that no amount of retry logic
--  closes -- the second process has to skip the row the first is holding, which
--  is a database decision.
--
--  Fix
--    `wire_claim_next_broadcast()` marks the row in the same statement that
--    returns it, using `for update skip locked` -- the identical shape as
--    `wire_claim_due_reminders()` in 021, which is why that one is safe and this
--    one was not.
--
--    SKIP LOCKED is the load-bearing keyword. Plain `for update` would make a
--    second invocation WAIT for the first to commit and then send the same
--    broadcast again, serialising the duplicates instead of removing them.
--
--  DELIVERY IS AT-MOST-ONCE, and that is a deliberate trade
--    Claiming before sending means a crash between the two loses one broadcast
--    permanently. The alternative -- send first, stamp after -- is what this
--    migration replaces, and it duplicates on every overlapping tick. For a
--    school newspaper, missing one push is recoverable and a doubled push to
--    every reader is not. 021 already accepts the same trade for reminders.
--
--    The stamp is deliberately NOT conditional on a successful send. Making it
--    conditional reintroduces the original bug: a slow send leaves the row
--    unpushed, and the next tick claims it again.
--
--  Ordering
--    Oldest first (`created_at asc`). The previous handler selected newest-first
--    with `limit(5)` and used only the first row, which meant a backlog
--    delivered newest-to-oldest: the newest broadcast jumped the queue while
--    older ones waited for the row to be stamped. Broadcasting is a sequence
--    people read in order.
--
--  THE NAMED CASE, AND WHAT CHANGES FOR IT
--    `p_broadcast_id` covers the Supabase webhook, which posts the inserted
--    row's id. It was never safe either -- a webhook retried after a timeout
--    would resend, because the handler selected by id with NO `pushed_at`
--    filter at all. It is now claimed like anything else, so a duplicate
--    delivery of the same webhook event finds nothing to send.
--
--    The visible consequence: asking to send a broadcast that has already been
--    sent now returns `nothing_pending` instead of sending it again. That is the
--    point. There is no "resend" feature in the panel to regress, and if one is
--    added later it needs an explicit reset of pushed_at -- deliberately, so it
--    cannot be triggered by an unauthenticated retried request.
--
--  SAFE TO RE-RUN. Idempotent.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- wire_claim_next_broadcast(p_broadcast_id)
--
-- SECURITY DEFINER because it writes pushed_at, and the caller is the
-- service_role client in send-push.js. Granted to service_role ONLY: this
-- function marks a broadcast as delivered without sending anything, so `anon`
-- getting execute on it would let any reader silence the push queue outright.
--
-- search_path is pinned. This function writes to a table by name, and a caller
-- who could create a schema ahead of `public` in the path could otherwise
-- redirect that write.
-- -----------------------------------------------------------------------------
create or replace function public.wire_claim_next_broadcast(p_broadcast_id uuid default null)
returns table (
  id              uuid,
  title           text,
  message         text,
  audience        text,
  delivered_count integer,
  created_at      timestamptz,
  pushed_at       timestamptz
)
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  return query
  with due as (
    select b.id
      from public.broadcasts b
     where b.pushed_at is null
       -- IS NOT DISTINCT FROM, not `=`. With NULL it means "no id given", which
       -- is the whole cron path; `coalesce` would be equivalent but `= null`
       -- would silently match nothing and stall the queue forever.
       and (p_broadcast_id is null or b.id = p_broadcast_id)
     order by b.created_at asc
     -- One claim per call. A scheduler that wants the whole backlog drained
     -- calls again on the next tick; fanning out here would turn a single tick
     -- into an unbounded blast, which is what 021's `limit 500` guards against.
     limit 1
     for update skip locked
  ),
  claimed as (
    -- The stamp is in the SAME statement as the selection. This is the whole
    -- point of the migration: there is no longer an interval in which another
    -- process can see this row as unpushed.
    update public.broadcasts b
       set pushed_at = now()
      from due d
     where b.id = d.id
    returning b.id, b.title, b.message, b.audience, b.delivered_count,
              b.created_at, b.pushed_at
  )
  select c.id, c.title, c.message, c.audience, c.delivered_count,
         c.created_at, c.pushed_at
    from claimed c;
end;
$$;

comment on function public.wire_claim_next_broadcast(uuid) is
  'Atomically claim the oldest undelivered broadcast, or a specific one by id: '
  'marks pushed_at and returns the row in one statement, so two concurrent '
  'callers can never both send the same broadcast. Returns no rows when the '
  'queue is empty or the named broadcast is already delivered. Delivery is '
  'at-most-once by design.';

-- service_role only, and explicitly not from public. `create function` grants
-- EXECUTE to PUBLIC by default, which would hand this to anon.
revoke all on function public.wire_claim_next_broadcast(uuid) from public;
revoke all on function public.wire_claim_next_broadcast(uuid) from anon, authenticated;
grant execute on function public.wire_claim_next_broadcast(uuid) to service_role;

-- -----------------------------------------------------------------------------
-- Verification.
--
-- (a) anon must NOT be able to call it. A skipped revoke here would let any
--     reader mark every broadcast as delivered and silence push permanently --
--     a denial of service that leaves no trace in the data.
-- (b) The claim must be stamped, so the next caller sees an empty queue.
-- (c) SKIP LOCKED must be present. Without it a concurrent caller BLOCKS and
--     then sends the same broadcast after the first commits: serialised
--     duplicates, which is the bug in a different shape and harder to spot.
-- (d) pushed_at must still exist, or the whole premise is gone.
-- -----------------------------------------------------------------------------
do $$
declare
  loosed text;
begin
  if exists (
    select 1
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = 'wire_claim_next_broadcast'
       and has_function_privilege('anon', p.oid, 'execute')
  ) then
    raise exception
      'anon may execute wire_claim_next_broadcast(): any reader could mark a '
      'broadcast delivered without sending it, silencing push permanently.';
  end if;

  if not exists (
    select 1
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = 'wire_claim_next_broadcast'
       and p.prosecdef
  ) then
    raise exception 'wire_claim_next_broadcast() is not SECURITY DEFINER.';
  end if;

  select p.prosrc into loosed
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'wire_claim_next_broadcast';

  if loosed !~ 'for\s+update\s+skip\s+locked' then
    raise exception
      'wire_claim_next_broadcast() has no FOR UPDATE SKIP LOCKED: a concurrent '
      'caller would block and then send the same broadcast anyway.';
  end if;

  -- The stamp must be part of the claim, not a separate statement the caller
  -- could forget.
  if loosed !~ 'set\s+(\w+\.)?pushed_at\s*=\s*now\(\)' then
    raise exception 'wire_claim_next_broadcast() does not stamp pushed_at.';
  end if;

  if not exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name   = 'broadcasts'
       and column_name  = 'pushed_at'
  ) then
    raise exception
      'public.broadcasts has no pushed_at column, so there is nothing to stamp. '
      '019/020 must be applied first.';
  end if;

  raise notice
    '039 verified: broadcast claiming is atomic, and only service_role may claim.';
end;
$$;

commit;