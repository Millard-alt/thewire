-- =============================================================================
--  020 - PUSH SUBSCRIPTION KEYS: APPLY-TO-LIVE
-- =============================================================================
--  Symptom (live, reported by the Owner)
--    1. Database Error: 502 column push_subscriptions.p256dh does not exist
--    2. Asset Error: Failed to load resource: /icons/badge-72.png (404)
--
--  Why the error is happening
--    `supabase/019_push_subscription_keys.sql` already contains this exact fix.
--    It is committed, and it is correct - but it was never RUN against the live
--    database. Nothing in this repo applies migrations automatically, so the
--    repository and the live schema had drifted apart: the code and the SQL both
--    assume `p256dh` exists, and the live table does not have it. Every send
--    therefore failed at the SELECT, before web-push was ever reached.
--
--    This file is a deliberately self-contained, re-runnable copy of 019's
--    schema change, for pasting into Supabase -> SQL Editor. It is safe to run
--    whether or not 019 was ever applied, and safe to run twice. It is NOT a
--    replacement for 019 in a fresh database - use 019 there. This exists purely
--    to converge the LIVE database onto what the code already expects.
--
--  Fix
--    1. Add `p256dh` and `auth` text columns if they do not exist.
--    2. Replace `wire_register_device` with the 5-argument version that accepts
--       and persists both keys. The old 3-argument signature is dropped first,
--       because `create or replace` cannot change an existing signature and
--       Postgres would otherwise keep two overloads.
--    3. Re-assert `wire_unregister_device`. It takes only an endpoint and needs
--       no keys - a row is removed whole, keys included - but it is redefined
--       here so that running this file alone guarantees both RPCs exist.
--    4. Re-assert `wire_forget_devices` (called by api/send-push.js when the
--       push service returns 404/410) and `wire_pushable_device_count`.
--    5. Grant `select` to service_role so the sender can read the key columns.
--       The browser deliberately keeps NO read access to them: they are
--       credentials, not reader data, and anon RLS is not enough here.
--
--  Notes
--    * Re-runnable. Every statement is `if not exists`, `create or replace` or
--      `grant`, and the only `drop` targets the stale 3-arg overload.
--    * Pure ASCII, no BOM.
--    * Existing rows keep NULL keys. They are legitimate reader sign-ups made
--      before real push existed. The sender reports them as "skipped: no keys"
--      rather than deleting them, so the Owner's subscriber count does not drop
--      on the first send. Affected readers fix themselves: the next time they
--      grant notification permission, syncSubscription() re-registers WITH keys.
--
--  Verify after running (expect one row, has_both_key_columns = true):
--    select count(*) = 2 as has_both_key_columns
--      from information_schema.columns
--     where table_schema = 'public' and table_name = 'push_subscriptions'
--       and column_name in ('p256dh', 'auth');
--
--  ROLLBACK (destructive - drops the keys and every stored subscription key):
--    alter table public.push_subscriptions drop column if exists p256dh;
--    alter table public.push_subscriptions drop column if exists auth;
--    drop function if exists public.wire_register_device(text,text,text,text,text);
--    drop function if exists public.wire_register_device(text,text,text);
-- =============================================================================

-- -----------------------------------------------------------------------------
--  0. The table itself
--     003 created it. This guard only fires if the live database is further
--     behind than the error suggests, and says so plainly instead of failing
--     later on a confusing "relation does not exist".
-- -----------------------------------------------------------------------------

do $$
begin
  if to_regclass('public.push_subscriptions') is null then
    raise exception
      'public.push_subscriptions does not exist. Run 003_subscriptions_and_gallery.sql first.';
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
--  1. THE TWO KEY COLUMNS
--     web-push needs three values per subscription: the endpoint plus the two
--     keys the browser generates. `p256dh` is the ECDH public key, `auth` the
--     auth secret. With only an endpoint the ECDH handshake cannot be done, so
--     a subscription is structurally incapable of receiving a push.
-- -----------------------------------------------------------------------------

alter table public.push_subscriptions
  add column if not exists p256dh text;
alter table public.push_subscriptions
  add column if not exists auth text;

comment on column public.push_subscriptions.p256dh is
  'Browser-generated ECDH public key (url-safe base64). Required to send Web Push.';
comment on column public.push_subscriptions.auth is
  'Browser-generated auth secret (url-safe base64). Required to send Web Push.';

-- -----------------------------------------------------------------------------
--  1b. SENDER-ONLY COLUMNS ON broadcasts
--     `pushed_at` lets the cron path avoid resending the same row every tick,
--     and `delivered_count` is what api/send-push.js writes back so the Owner
--     Panel can report a real number instead of guessing.
-- -----------------------------------------------------------------------------

alter table public.broadcasts
  add column if not exists pushed_at timestamptz;
alter table public.broadcasts
  add column if not exists delivered_count integer;

create index if not exists broadcasts_unpushed_idx
  on public.broadcasts (created_at desc)
  where pushed_at is null;

-- -----------------------------------------------------------------------------
--  2. REGISTER A DEVICE, WITH ITS KEYS
--     SECURITY DEFINER because direct writes are revoked from anon: an upsert
--     needs an UPDATE policy the table does not have, and a delete-then-insert
--     trips the unique key, because a non-matching DELETE under RLS removes 0
--     rows *without raising*. Running as the table owner sidesteps RLS.
--
--     An empty p_endpoint still means "unsubscribe" and is handled as before.
-- -----------------------------------------------------------------------------

drop function if exists public.wire_register_device(text, text, text);

create or replace function public.wire_register_device(
  p_endpoint text,
  p_device   text default null,
  p_audience text default 'Everyone',
  p_p256dh   text default null,
  p_auth     text default null
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_endpoint text;
  v_p256dh   text;
  v_auth     text;
begin
  if p_endpoint is null or btrim(p_endpoint) = '' then
    return 'ignored';
  end if;

  v_endpoint := btrim(p_endpoint);
  if length(v_endpoint) > 500 then
    raise exception 'endpoint too long';
  end if;

  -- Trim, and treat an empty string as absent. The browser sends '' rather than
  -- null when a client cannot produce keys, and an empty key is worse than none:
  -- web-push would attempt the handshake and fail per-subscription.
  v_p256dh := nullif(btrim(coalesce(p_p256dh, '')), '');
  v_auth   := nullif(btrim(coalesce(p_auth,   '')), '');

  -- Length bounds. p256dh is 65 bytes -> 87 url-safe base64 chars; auth is
  -- 16 bytes -> 22. Anything wildly outside that is junk and must not be stored,
  -- because the sender feeds it straight into an ECDH handshake.
  if v_p256dh is not null and length(v_p256dh) > 200 then
    raise exception 'p256dh too long';
  end if;
  if v_auth is not null and length(v_auth) > 100 then
    raise exception 'auth too long';
  end if;

  insert into public.push_subscriptions
    (endpoint, device, audience, p256dh, auth, last_seen)
  values (
    v_endpoint,
    left(coalesce(nullif(btrim(p_device), ''), 'Unknown device'), 120),
    left(coalesce(nullif(btrim(p_audience), ''), 'Everyone'), 60),
    v_p256dh,
    v_auth,
    now()
  )
  on conflict (endpoint) do update
    set device    = excluded.device,
        audience  = excluded.audience,
        -- Only overwrite keys with a real value. A re-registration from a client
        -- that cannot produce keys (the in-app-only path) must not blank out
        -- keys a previous visit did store.
        p256dh    = coalesce(excluded.p256dh, public.push_subscriptions.p256dh),
        auth      = coalesce(excluded.auth,   public.push_subscriptions.auth),
        last_seen = now();

  return 'subscribed';
end;
$$;

grant execute on function public.wire_register_device(text, text, text, text, text)
  to anon, authenticated;

-- -----------------------------------------------------------------------------
--  3. UNSUBSCRIBE ONE DEVICE
--     Takes an endpoint only. The row is deleted whole, so the keys go with it
--     and there is nothing extra to accept or persist here - redefining it is
--     simply so that running this file alone guarantees the RPC exists.
-- -----------------------------------------------------------------------------

create or replace function public.wire_unregister_device(p_endpoint text)
returns text
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_endpoint is null or btrim(p_endpoint) = '' then
    return 'ignored';
  end if;

  delete from public.push_subscriptions
   where endpoint = btrim(p_endpoint);

  return 'unsubscribed';
end;
$$;

grant execute on function public.wire_unregister_device(text)
  to anon, authenticated;

-- -----------------------------------------------------------------------------
--  4. FORGET ENDPOINTS THE PUSH SERVICE REJECTED
--     Called by api/send-push.js when a send returns 404 or 410. Those
--     endpoints are dead for good - the browser will not hand them out again -
--     so keeping the row only inflates the subscriber count forever. SECURITY
--     DEFINER because direct deletes are revoked from anon.
-- -----------------------------------------------------------------------------

create or replace function public.wire_forget_devices(p_endpoints text[])
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_removed integer;
begin
  if p_endpoints is null or array_length(p_endpoints, 1) is null then
    return 0;
  end if;

  delete from public.push_subscriptions
   where endpoint = any(p_endpoints);

  get diagnostics v_removed = row_count;
  return v_removed;
end;
$$;

grant execute on function public.wire_forget_devices(text[])
  to anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
--  5. HOW MANY SUBSCRIPTIONS CAN ACTUALLY BE SENT TO
--     Counted by key presence, not row count. Without this the Owner sees a
--     subscriber total that the sender will silently skip most of.
-- -----------------------------------------------------------------------------

create or replace function public.wire_pushable_device_count()
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::integer
    from public.push_subscriptions
   where p256dh is not null
     and auth   is not null;
$$;

grant execute on function public.wire_pushable_device_count()
  to anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
--  6. LET THE SERVERLESS SENDER READ THE KEYS
--     service_role bypasses RLS, but the grant is made explicit so this does not
--     depend on Supabase's default role setup. The browser keeps NO read access
--     to the key columns: they are credentials, not reader data.
-- -----------------------------------------------------------------------------

grant select on public.push_subscriptions to service_role;

-- -----------------------------------------------------------------------------
--  7. REPORT
--     Written to the SQL Editor's output so the operator sees, immediately,
--     whether the columns landed and how many devices are actually pushable.
-- -----------------------------------------------------------------------------

do $$
declare
  v_total integer;
  v_ready integer;
begin
  select count(*) into v_total from public.push_subscriptions;
  select count(*) into v_ready
    from public.push_subscriptions
   where p256dh is not null and auth is not null;

  raise notice 'push_subscriptions: % total device(s), % with usable push keys.', v_total, v_ready;

  if v_ready = 0 and v_total > 0 then
    raise notice 'No device has keys yet - expected, and self-healing: readers acquire them on their next permission grant.';
  end if;
end;
$$;