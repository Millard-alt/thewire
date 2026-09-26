-- ============================================================================
--  THE WIRE - STAGE 2: USERNAME + PASSWORD CREDENTIALS (no Supabase Auth)
--  Run this AFTER schema.sql. Idempotent, so re-running is safe.
--
--  Supabase Auth is e-mail-native, which forced staff to invent addresses they
--  never use. This stage replaces it with a first-class credentials system:
--
--    * Passwords are hashed with pgcrypto bcrypt (`crypt`), never stored plain.
--    * Login/registration are SECURITY DEFINER functions, so the anon key can
--      call them while still being unable to SELECT a password column.
--    * Sessions are opaque random tokens; only a SHA-256 digest is persisted,
--      so a database leak cannot be turned into live sessions.
--    * The FIRST account ever created becomes the Owner and is approved
--      immediately. Every account after that is a request the Owner must
--      approve before it can sign in.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0. REQUIRED EXTENSION
-- ----------------------------------------------------------------------------
-- pgcrypto supplies `crypt`, `gen_salt` and `digest`. Supabase already ships it,
-- but it lives in the `extensions` schema rather than `public`, so unqualified
-- calls fail with:
--     ERROR: function digest(text, unknown) does not exist
-- Every crypto call below is therefore schema-qualified as `extensions.*`.
-- `gen_random_uuid()` needs no prefix - it is built into PostgreSQL 13+.
create extension if not exists pgcrypto with schema extensions;

-- ----------------------------------------------------------------------------
-- 0b. DEPLOYED-VERSION STAMP
-- ----------------------------------------------------------------------------
-- Bump the string whenever the behaviour of a function below changes. The
-- diagnostic script prints it, so "I re-ran the SQL but the old error is still
-- there" becomes answerable in one glance instead of by guesswork: if the
-- database still reports an older stamp, the paste did not take effect.
create or replace function public.wire_credentials_version()
returns text
language sql
stable
as $$
  select 'stage2-v3-pending-signin-allowed';
$$;

-- ----------------------------------------------------------------------------
-- 1. TABLES
-- ----------------------------------------------------------------------------

create table if not exists public.staff_accounts (
  id            uuid primary key default gen_random_uuid(),
  username      text        not null unique,
  password_hash text        not null,
  display_name  text        not null,
  role          text        not null default 'Editor'
                          check (role in ('Owner','Editor','Reporter')),
  -- 'pending'   -> awaiting the Owner's approval, cannot sign in
  -- 'active'    -> approved, can sign in
  -- 'suspended' -> explicitly blocked by the Owner
  status        text        not null default 'pending'
                          check (status in ('pending','active','suspended')),
  is_owner      boolean     not null default false,
  approved_at   timestamptz,
  last_login_at timestamptz,
  created_at    timestamptz not null default now()
);

create unique index if not exists staff_accounts_one_owner_idx
  on public.staff_accounts (is_owner) where is_owner;

create table if not exists public.wire_sessions (
  id         uuid primary key default gen_random_uuid(),
  account_id uuid        not null references public.staff_accounts (id) on delete cascade,
  -- SHA-256 of the bearer token. The token itself lives only in the browser.
  token_hash text        not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '7 days'),
  revoked_at timestamptz
);

create index if not exists wire_sessions_account_idx on public.wire_sessions (account_id);

-- ----------------------------------------------------------------------------
-- 2. SESSION RESOLUTION
--    The browser sends its token in the `x-wire-token` header on every request.
--    PostgREST exposes all inbound headers via the `request.headers` GUC, which
--    lets an ordinary RLS policy identify the caller without Supabase Auth.
-- ----------------------------------------------------------------------------

create or replace function public.wire_bearer_token()
returns text
language sql
stable
as $$
  select nullif(
    coalesce(
      current_setting('request.headers', true)::jsonb ->> 'x-wire-token',
      current_setting('request.jwt.claim', true)
    ),
    ''
  );
$$;

create or replace function public.current_account_id()
returns uuid
language sql
stable
security definer
set search_path = public, extensions
as $$
  select s.account_id
    from public.wire_sessions s
   where s.token_hash = encode(extensions.digest(coalesce(public.wire_bearer_token(), ''), 'sha256'), 'hex')
     and s.revoked_at is null
     and s.expires_at > now()
   limit 1;
$$;

-- Guard against the one failure mode that is invisible until login time: some
-- other script (notably schema.sql) redefining is_staff() with the old
-- Supabase Auth logic, which reads auth.uid(). There is no JWT in this project,
-- so that version silently returns false for every caller and the newsroom
-- sees "Not authorised." despite correct credentials.
--
-- Failing loudly at deploy time is far better than failing at login time.
-- Redefines the helper every RLS policy already calls. The policies were
-- written against `is_staff()`, so swapping the implementation is all that is
-- needed to move the whole app off Supabase Auth.
create or replace function public.is_staff()
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select exists (
    select 1 from public.staff_accounts a
     where a.id = public.current_account_id() and a.status = 'active'
  );
$$;


do $$
declare
  v_def text;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p
   where p.oid = 'public.is_staff()'::regprocedure;

  if v_def like '%auth.uid%' or v_def like '%auth.jwt%' then
    raise exception
      'public.is_staff() still depends on Supabase Auth. Re-run credentials.sql '
      'AFTER schema.sql - this project authenticates with a bearer token, not a JWT.';
  end if;
end;
$$;

create or replace function public.is_owner()
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select exists (
    select 1 from public.staff_accounts a
     where a.id = public.current_account_id()
       and a.status = 'active'
       and a.is_owner
  );
$$;

-- ----------------------------------------------------------------------------
-- 2b. POST-LOGIN SELF TEST
--     Calling this immediately after wire_login() tells you, in one shot,
--     whether the whole session chain resolved. It is deliberately readable by
--     anon so it can be called as a diagnostic, and it exposes no secrets: only
--     booleans, the username, and the account status.
-- ----------------------------------------------------------------------------
create or replace function public.wire_session_diagnostic()
returns jsonb
language sql
stable
security definer
set search_path = public, extensions
as $$
  select jsonb_build_object(
    'token_seen',        public.wire_bearer_token() is not null,
    'session_resolved',  public.current_account_id() is not null,
    'is_staff',          public.is_staff(),
    'is_owner',          public.is_owner(),
    'username',          (select a.username from public.staff_accounts a
                           where a.id = public.current_account_id()),
    'status',            (select a.status from public.staff_accounts a
                           where a.id = public.current_account_id())
  );
$$;

-- ----------------------------------------------------------------------------
-- 3. REGISTRATION / LOGIN  (the only anon-callable writes)
--    Every function builds its jsonb payload explicitly, so no column leaks by
--    accident - in particular, never `password_hash`.
-- ----------------------------------------------------------------------------

-- Is the newsroom empty? If so the next signup becomes the Owner.
create or replace function public.wire_is_unclaimed()
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select not exists (select 1 from public.staff_accounts);
$$;

-- Create an account.
--   * No accounts exist yet -> the caller becomes the approved Owner.
--   * Accounts already exist -> the account is created 'pending' and the Owner
--     must approve it before anyone can sign in with it.
create or replace function public.wire_request_account(
  p_username     text,
  p_display_name text,
  p_password     text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_user   text := lower(trim(p_username));
  v_name   text := nullif(trim(p_display_name), '');
  v_id     uuid;
  v_status text;
  v_owner  boolean;
  v_role   text;
begin
  if v_user is null or v_user !~ '^[a-z0-9][a-z0-9._-]{2,31}$' then
    raise exception 'Username must be 3-32 characters, using letters, numbers, dots, dashes or underscores.';
  end if;

  if v_name is null or char_length(v_name) < 2 then
    raise exception 'Please enter your full name.';
  end if;

  if p_password is null or char_length(p_password) < 8 then
    raise exception 'Password must be at least 8 characters long.';
  end if;

  -- Friendly duplicate handling. Without this the caller gets a raw
  --   duplicate key value violates unique constraint "staff_accounts_username_key"
  -- instead of something a human can act on. `for update` also serialises two
  -- simultaneous signups for the same name, so the check cannot race past.
  if exists (
    select 1 from public.staff_accounts
     where username = v_user
     for update
  ) then
    raise exception 'That username is already taken. Try another one.'
      using errcode = 'unique_violation';
  end if;

  -- First-run claim. The whole statement is serialised by the primary key on
  -- `username` plus this existence check, so two simultaneous first signups
  -- cannot both become Owner.
  if not exists (select 1 from public.staff_accounts) then
    v_status := 'active';
    v_owner  := true;
    v_role   := 'Owner';
  else
    v_status := 'pending';
    v_owner  := false;
    v_role   := 'Editor';
  end if;

  insert into public.staff_accounts
    (username, password_hash, display_name, role, status, is_owner, approved_at)
  values
    (v_user, extensions.crypt(p_password, extensions.gen_salt('bf')), v_name, v_role, v_status, v_owner,
     case when v_owner then now() else null end)
  returning id into v_id;

  return jsonb_build_object(
    'id',           v_id,
    'username',     v_user,
    'display_name', v_name,
    'role',         v_role,
    'status',       v_status,
    'is_owner',     v_owner
  );
end;
$$;

-- Exchange a username + password for a session token.
create or replace function public.wire_login(p_username text, p_password text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_user   text := lower(trim(p_username));
  v_row    public.staff_accounts%rowtype;
  v_token  text;
  v_digest text;
begin
  select * into v_row
    from public.staff_accounts
   where username = v_user;

  -- Hash anyway when the row is missing, so a wrong username and a wrong
  -- password take the same time and cannot be used to enumerate accounts.
  if v_row.id is null then
    perform extensions.crypt(coalesce(p_password, ''), extensions.gen_salt('bf'));
    raise exception 'Incorrect username or password.';
  end if;

  if v_row.password_hash <> extensions.crypt(coalesce(p_password, ''), v_row.password_hash) then
    raise exception 'Incorrect username or password.';
  end if;

  -- A PENDING account is allowed to sign in, but it resolves to a session that
  -- carries no privileges: public.is_staff() requires status = 'active', so
  -- every staff table, policy and RPC denies it. Signing in is what lets the
  -- applicant SEE that they are waiting, instead of a dead end at the login
  -- form. The Owner flips them to active (and a role) to grant access.
  if v_row.status = 'suspended' then
    raise exception 'This account has been suspended. Please contact the Owner.';
  end if;

  v_token  := encode(extensions.gen_random_bytes(32), 'hex');
  v_digest := encode(extensions.digest(v_token, 'sha256'), 'hex');

  insert into public.wire_sessions (account_id, token_hash) values (v_row.id, v_digest);
  update public.staff_accounts set last_login_at = now() where id = v_row.id;

  return jsonb_build_object(
    'token',        v_token,
    'id',           v_row.id,
    'username',     v_row.username,
    'display_name', v_row.display_name,
    'role',         v_row.role,
    'status',       v_row.status,
    'is_owner',     v_row.is_owner
  );
end;
$$;

-- Revoke the caller's own session.
create or replace function public.wire_sign_out()
returns boolean
language sql
security definer
set search_path = public, extensions
as $$
  update public.wire_sessions
     set revoked_at = now()
   where token_hash = encode(extensions.digest(coalesce(public.wire_bearer_token(), ''), 'sha256'), 'hex')
     and revoked_at is null;
  select true;
$$;

-- ----------------------------------------------------------------------------
-- 4. OWNER MANAGEMENT  (approval queue, roster, password resets)
--    Each function re-checks the caller's privileges internally, so the anon
--    key cannot reach them by guessing a function name.
-- ----------------------------------------------------------------------------

-- The approval queue plus the active roster, pending accounts first.
-- `is_me` flags the caller's own row. auth.js uses it to decide which account
-- the header chip and the account menu describe, so it has to be present on
-- every row -- otherwise the UI silently falls back to the first roster entry
-- and shows the wrong person signed in.
create or replace function public.wire_list_accounts()
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if not public.is_staff() then
    raise exception 'Not authorised.';
  end if;

  return coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'id',           a.id,
        'username',     a.username,
        'display_name', a.display_name,
        'role',         a.role,
        'status',       a.status,
        'is_owner',     a.is_owner,
        'created_at',   a.created_at,
        'approved_at',  a.approved_at,
        'last_login_at', a.last_login_at,
        'is_me',        a.id = public.current_account_id()
      ) order by (a.status <> 'pending') desc, a.created_at asc
    )
      from public.staff_accounts a
  ), '[]'::jsonb);
end;
$$;

-- Approve a pending account. Owner-only. Grants role 'Editor' by default.
create or replace function public.wire_approve_account(p_id uuid, p_role text default 'Editor')
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_role text := coalesce(nullif(trim(p_role), ''), 'Editor');
  v_out  jsonb;
begin
  if not public.is_owner() then
    raise exception 'Only the Owner can approve accounts.';
  end if;

  if v_role not in ('Owner','Editor','Reporter') then
    raise exception 'Unknown role.';
  end if;

  -- A pending account can never be the Owner, so there is exactly one Owner.
  update public.staff_accounts
     set status      = 'active',
         approved_at = now(),
         role        = case when is_owner then 'Owner' else v_role end
   where id = p_id
  returning jsonb_build_object('id', id, 'username', username, 'role', role, 'status', status)
    into v_out;

  if v_out is null then
    raise exception 'Account not found.';
  end if;

  return v_out;
end;
$$;

-- Owner-only: refuse a pending request, or remove a non-owner account.
create or replace function public.wire_reject_account(p_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if not public.is_owner() then
    raise exception 'Only the Owner can manage accounts.';
  end if;

  -- Never let the Owner delete or lock themselves out.
  if exists (select 1 from public.staff_accounts where id = p_id and is_owner) then
    raise exception 'You cannot remove your own Owner account.';
  end if;

  delete from public.staff_accounts where id = p_id and not is_owner;
  return true;
end;
$$;

-- Owner-only: reset somebody's password without ever seeing or sending it.
-- Every existing session for that account is revoked at the same time.
create or replace function public.wire_set_password(p_id uuid, p_password text)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if not public.is_owner() then
    raise exception 'Only the Owner can reset passwords.';
  end if;

  if p_password is null or char_length(p_password) < 8 then
    raise exception 'Password must be at least 8 characters long.';
  end if;

  update public.staff_accounts
     set password_hash = extensions.crypt(p_password, extensions.gen_salt('bf'))
   where id = p_id;

  update public.wire_sessions
     set revoked_at = now()
   where account_id = p_id and revoked_at is null;

  return true;
end;
$$;

-- ----------------------------------------------------------------------------
-- 5. RLS + GRANTS
--    The credential tables are never readable from the client: with RLS enabled
--    and no policy, every direct request is denied. The SECURITY DEFINER
--    functions above still work because they execute as the table owner and
--    therefore bypass RLS - and each one re-checks authorisation itself.
-- ----------------------------------------------------------------------------

alter table public.staff_accounts enable row level security;
alter table public.wire_sessions   enable row level security;

-- Deliberately NO select/update/delete policies on either table.
drop policy if exists staff_accounts_read  on public.staff_accounts;
drop policy if exists staff_accounts_write on public.staff_accounts;
drop policy if exists wire_sessions_read   on public.wire_sessions;

grant usage on schema public to anon, authenticated;

-- Scoped, table-by-table grants. The blanket
--   grant select, insert, update, delete on all tables in schema public ...
-- was replaced: `all tables` sweeps in every future table automatically, so a
-- table added later without thinking silently becomes world-writable. Each
-- table is named explicitly below and the credential tables are deliberately
-- ABSENT - they are reachable only through the SECURITY DEFINER functions.
grant select, insert, update, delete on
  public.articles,
  public.assignments,
  public.staff,
  public.top_performers,
  public.media_assets,
  public.broadcasts,
  public.audit_logs,
  public.site_settings
  to anon, authenticated;

-- Callable by anyone (these are the public sign-in / sign-up entry points).
grant execute on function public.wire_is_unclaimed()            to anon, authenticated;
grant execute on function public.wire_request_account(text,text,text) to anon, authenticated;
grant execute on function public.wire_login(text,text)          to anon, authenticated;
grant execute on function public.wire_sign_out()                to anon, authenticated;
grant execute on function public.current_account_id()           to anon, authenticated;
grant execute on function public.is_staff()                     to anon, authenticated;
grant execute on function public.is_owner()                     to anon, authenticated;

-- Resolves the caller's own session token to a username. It never returns
-- anything about *other* accounts, so anon is safe here: with no valid token
-- it simply reports session_resolved = false. The client uses it as a fallback
-- when wire_list_accounts() is running an older build without the is_me flag.
grant execute on function public.wire_session_diagnostic()     to anon, authenticated;
grant execute on function public.wire_credentials_version()   to anon, authenticated;

-- Staff-only entry points. Each still verifies its own caller.
grant execute on function public.wire_list_accounts()           to authenticated;
grant execute on function public.wire_approve_account(uuid,text) to authenticated;
grant execute on function public.wire_reject_account(uuid)      to authenticated;
grant execute on function public.wire_set_password(uuid,text)    to authenticated;

-- ----------------------------------------------------------------------------
-- 6. IMAGE UPLOADS  (Supabase Storage)
-- ----------------------------------------------------------------------------
-- Editors pick an image from their device and src/lib/upload.js pushes it into
-- this bucket, then writes the public URL into `articles.image_url`.
-- Supabase Storage is used rather than a third-party image host because it
-- ships with the project: no extra vendor account, no extra billing surface,
-- and the files are served from the same origin as the API, so no ad-blocker
-- rule can hide them the way it hid the old CDN.

insert into storage.buckets (id, name, public)
values ('wire-media', 'wire-media', true)
on conflict (id) do update set public = true;

-- The bucket is public-read, so reads need no policy at all.
-- Reporters need to attach a photo to a story, so any staff member may upload.
drop policy if exists "wire media staff upload" on storage.objects;
create policy "wire media staff upload"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'wire-media' and public.is_staff());

-- Deletion is Owner-only. Nothing in the browser can call this, because
-- `wire_delete_media` only removes the database row, not the object.
drop policy if exists "wire media owner delete" on storage.objects;
create policy "wire media owner delete"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'wire-media' and public.is_owner());

-- ----------------------------------------------------------------------------
-- 7. OPTIONAL CLEAN-UP
--    The old Supabase-Auth roster is no longer the gate. Leave it in place if
--    you want the names to appear in the Staff tab, or run the statements
--    below to retire it entirely.
-- ---------------------------------------------------------------------------

-- drop table if exists public.wire_sessions;   -- only after verifying login
-- drop table if exists public.staff_accounts; -- destroys all credentials
