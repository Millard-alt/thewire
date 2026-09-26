-- =============================================================================
--  004 - DEVICE REGISTRATION (fixes 42501 on subscribe)
-- =============================================================================
--  Symptom
--    Registering a device failed with:
--      42501 new row violates row-level security policy for table
--      "push_subscriptions"
--
--  Why
--    The app used `.upsert({ onConflict: 'endpoint' })`. PostgREST turns that
--    into `INSERT ... ON CONFLICT DO UPDATE`, and the UPDATE branch needs an
--    UPDATE policy. The table only ever had INSERT / SELECT / DELETE policies,
--    so every subscribe was rejected. (A delete-then-insert fallback was also
--    unreliable: with RLS active a non-matching DELETE removes 0 rows *without
--    raising an error*, so the re-insert then hit 23505 duplicate key instead.)
--
--  Fix
--    Move the write behind a SECURITY DEFINER function. It runs as the table
--    owner, so RLS does not apply, and the ON CONFLICT upsert finally works.
--    Direct writes from the browser are then revoked, so this function is the
--    ONLY way to touch the table - the strictest arrangement available.
--
--  Validation is done here rather than by a policy because the function is
--  definer-rights: it must be safe even though it bypasses RLS.
-- =============================================================================

-- -----------------------------------------------------------------------------
--  1. REGISTER (or clear) A DEVICE
--     Passing an empty p_endpoint unsubscribes.
-- -----------------------------------------------------------------------------

create or replace function public.wire_register_device(
  p_endpoint text,
  p_device   text default null,
  p_audience text default 'Everyone'
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_endpoint text;
begin
  -- Unsubscribe: a reader switching alerts off. Delete only.
  if p_endpoint is null or btrim(p_endpoint) = '' then
    return 'ignored';
  end if;

  v_endpoint := btrim(p_endpoint);

  -- Bound the values. An endpoint is a URL from the browser's push service, so
  -- 500 chars matches the column; device/audience are short labels.
  if length(v_endpoint) > 500 then
    raise exception 'endpoint too long';
  end if;

  insert into public.push_subscriptions (endpoint, device, audience, last_seen)
  values (
    v_endpoint,
    left(coalesce(nullif(btrim(p_device), ''), 'Unknown device'), 120),
    left(coalesce(nullif(btrim(p_audience), ''), 'Everyone'), 60),
    now()
  )
  on conflict (endpoint) do update
    set device    = excluded.device,
        audience  = excluded.audience,
        last_seen = now();

  return 'subscribed';
end;
$$;

-- -----------------------------------------------------------------------------
--  2. UNSUBSCRIBE ONE DEVICE
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

grant execute on function public.wire_register_device(text, text, text)
  to anon, authenticated;
grant execute on function public.wire_unregister_device(text)
  to anon, authenticated;

-- -----------------------------------------------------------------------------
--  3. LOCK THE TABLE DOWN
--     With the functions in place the browser no longer needs direct write
--     access. Revoking it means a leaked anon key cannot insert junk rows or
--     delete somebody else's device record.
--     Re-runnable: the policies are dropped in case an older one is present.
-- -----------------------------------------------------------------------------

revoke insert, delete on public.push_subscriptions from anon, authenticated;

drop policy if exists push_subscriptions_subscribe on public.push_subscriptions;
drop policy if exists push_subscriptions_unsubscribe on public.push_subscriptions;

-- -----------------------------------------------------------------------------
--  4. CLEAN UP DIAGNOSTIC ROWS
--     Rows written while tracking down the 42501 error. They are not real
--     devices and would otherwise inflate the Owner's subscriber count. Remove
--     them here, because once the revoke above is in place the browser can no
--     longer delete anything itself.
-- -----------------------------------------------------------------------------

delete from public.push_subscriptions
 where endpoint like 'https://diag%.test/%';
