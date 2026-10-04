-- =============================================================================
--  019 - PUSH SUBSCRIPTION KEYS (p256dh + auth)
-- =============================================================================
--  Symptom
--    The Owner can create a broadcast and the subscriber list is populated, but
--    no device ever receives anything, because nothing has ever encrypted a
--    payload to a specific endpoint.
--
--  Why
--    `push_subscriptions` stores only `endpoint`. Real Web Push needs three
--    values per subscription: the endpoint, plus the two keys the browser
--    generates (`p256dh` for the ECDH public key, `auth` for the auth secret).
--    The `web-push` library cannot build a request without the key pair - it
--    needs them to do the ECDH handshake. So the current table is structurally
--    incapable of receiving a push, no matter how correct the sender is.
--
--  Fix
--    1. Add the two key columns.
--    2. Extend `wire_register_device` to accept and persist them.
--    3. Add `wire_forget_devices` so the server can prune endpoints that a push
--       service reports as 404 / 410 Gone. That has to be a SECURITY DEFINER
--       function like the others: direct deletes are revoked from anon.
--
--  Notes
--    * Re-runnable. The old 3-argument `wire_register_device` is dropped first,
--      because `create or replace` cannot change an existing signature.
--    * Pure ASCII, no BOM. Paste into Supabase -> SQL Editor.
--    * Existing rows keep NULL keys. They are legitimate reader sign-ups from
--      before real push existed; the sender reports them as "skipped: no keys"
--      and leaves them alone rather than deleting them, so the Owner's
--      subscriber count does not drop on the first send.
-- =============================================================================

alter table public.push_subscriptions
  add column if not exists p256dh text;
alter table public.push_subscriptions
  add column if not exists auth text;

-- Marks a broadcast as already handled by the sender, so the cron path does not
-- resend the same row on every tick. Polling clients ignore this column.
alter table public.broadcasts
  add column if not exists pushed_at timestamptz;

create index if not exists broadcasts_unpushed_idx
  on public.broadcasts (created_at desc)
  where pushed_at is null;

comment on column public.push_subscriptions.p256dh is
  'Browser-generated ECDH public key (url-safe base64). Required to send Web Push.';
comment on column public.push_subscriptions.auth is
  'Browser-generated auth secret (url-safe base64). Required to send Web Push.';

-- -----------------------------------------------------------------------------
--  1. REGISTER A DEVICE, WITH ITS KEYS
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
  -- Unsubscribe: a reader switching alerts off. Delete only.
  if p_endpoint is null or btrim(p_endpoint) = '' then
    return 'ignored';
  end if;

  v_endpoint := btrim(p_endpoint);

  if length(v_endpoint) > 500 then
    raise exception 'endpoint too long';
  end if;

  -- Keys are url-safe base64 from the browser: ~87 chars for p256dh (65 bytes),
  -- ~22-24 for auth (16 bytes). Bound generously but reject junk, because these
  -- are fed straight into an ECDH handshake on the server.
  v_p256dh := nullif(btrim(coalesce(p_p256dh, '')), '');
  v_auth   := nullif(btrim(coalesce(p_auth, '')), '');

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
        -- Only overwrite keys with a real value. A re-registration from a
        -- client that cannot produce keys (the in-app-only path) must not
        -- blank out keys a previous visit did store.
        p256dh    = coalesce(excluded.p256dh, public.push_subscriptions.p256dh),
        auth      = coalesce(excluded.auth, public.push_subscriptions.auth),
        last_seen = now();

  return 'subscribed';
end;
$$;

grant execute on function public.wire_register_device(text, text, text, text, text)
  to anon, authenticated;

-- -----------------------------------------------------------------------------
--  2. FORGET ENDPOINTS THE PUSH SERVICE REJECTED
--     Called by the serverless sender when a send returns 404 or 410. Those
--     endpoints are dead for good: the browser will not hand them out again, so
--     keeping the row only inflates the subscriber count forever.
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
--  3. LET THE SERVERLESS SENDER READ THE KEYS
--     service_role bypasses RLS, but the grants are made explicit so this does
--     not depend on Supabase's default role setup. The browser keeps NO read
--     access to the key columns - they are credentials, not reader data.
-- -----------------------------------------------------------------------------

grant select on public.push_subscriptions to service_role;

-- -----------------------------------------------------------------------------
--  4. HOW MANY SUBSCRIPTIONS CAN ACTUALLY BE SENT TO
--     Reported in the server response so a broadcast that delivered to nobody
--     is visibly different from one that delivered to everyone.
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