/* =============================================================================
   scripts/migration-apply-check.mjs — APPLY THE MIGRATIONS TO REAL POSTGRES
   -----------------------------------------------------------------------------
   034, 035 and 036 each failed against production once, on a defect a parser
   would have caught immediately: a bare `end`, an `IS NOT` used as a comparison,
   a `table_name` column that does not exist, and an exact comparison against a
   predicate that pg_get_expr renders without its schema prefix. Static checks
   could only reason about those. This file executes them.

   PGlite is real PostgreSQL 18 compiled to WASM, so there is no service to
   install and nothing to clean up: it runs in about two seconds.

   It asserts the SECURITY OUTCOME, not merely that the SQL parses. A migration
   that applies but leaves a Writer able to insert a broadcast is still broken.

   Faked, and why the test still means something:
     * auth.users, storage.*  -- Supabase-owned schemas this project only reads
     * wire_bearer_token()    -- reads a GUC instead of an HTTP header so a test
                                can switch sessions. The token -> account -> role
                                chain beneath it is the project's real logic.
     * extensions.digest      -- md5 rather than sha256. The hash is not under
                                test; session resolution is.

   Run:  npm run test:migrations
   ========================================================================== */

import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(p, 'utf8');

const problems = [];
const ok = (m) => console.log('  PASS  ' + m);
const bad = (m) => { problems.push(m); console.log('  FAIL  ' + m); };

const db = await new PGlite();

/** PGlite dumps a WASM stack trace with every error. Keep it to the message. */
const concise = (e) => {
  const m = String(e.message || e);
  const code = m.match(/ERROR:\s*(.+)/)?.[1] || m.split('\n')[0];
  return code.length > 170 ? code.slice(0, 170) + '...' : code;
};

const stage = async (label, sql) => {
  try {
    await db.exec(sql);
    return true;
  } catch (e) {
    console.log(`\nSCAFFOLDING FAILED at: ${label}`);
    console.log('  ' + concise(e));
    await db.close();
    process.exit(2);
  }
};

// ---------------------------------------------------------------------------
//  1. Schemas, roles, tables
// ---------------------------------------------------------------------------
await stage('schemas, roles, tables', `
  create schema if not exists extensions;
  create schema if not exists auth;
  create schema if not exists storage;

  do $$ begin create role anon;          exception when duplicate_object then null; end $$;
  do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
  do $$ begin create role service_role;  exception when duplicate_object then null; end $$;

  create table auth.users (id uuid primary key default gen_random_uuid());

  create table storage.buckets (
    id                 text primary key,
    name               text,
    public             boolean default false,
    allowed_mime_types text[],
    file_size_limit    bigint,
    created_at         timestamptz default now()
  );

  create table storage.objects (
    id        uuid primary key default gen_random_uuid(),
    bucket_id text,
    name      text,
    owner     uuid
  );
  alter table storage.objects enable row level security;

  -- Supabase's helper: the folder segments of an object name, filename
  -- excluded. Written with unnest because Postgres cannot slice an arbitrary
  -- expression -- arr[:n] is an ARRAY-constructor subscript, not a slice.
  create function storage.foldername(name text) returns text[]
  language sql immutable as $fn$
    select coalesce(
      (
        select array_agg(u.part)
          from unnest(string_to_array(name, '/')) with ordinality as u(part, ord)
         where u.ord < array_length(string_to_array(name, '/'), 1)
      ),
      ARRAY[]::text[]
    )
  $fn$;

  create table public.wire_sessions (
    id         uuid primary key default gen_random_uuid(),
    account_id uuid,
    token_hash text,
    expires_at timestamptz,
    revoked_at timestamptz
  );

  create table public.staff_accounts (
    id       uuid primary key default gen_random_uuid(),
    username text,
    role     text check (role in ('Owner','Writer','Board Manager')),
    status   text,
    is_owner boolean default false
  );

  create table public.staff (
    id           uuid primary key default gen_random_uuid(),
    username     text,
    display_name text,
    email        text,
    portrait_url text
  );

  create table public.site_settings (
    id             integer primary key default 1 check (id = 1),
    title          text,
    subtitle       text,
    edition        text,
    breaking_news  jsonb,
    weekly_slots   jsonb,
    show_this_week boolean,
    todays_pick_id uuid
  );

  create table public.broadcasts (id uuid primary key default gen_random_uuid(), title text, body text);
  create table public.assignments (id uuid primary key default gen_random_uuid(), title text);
  create table public.articles (id uuid primary key default gen_random_uuid(), title text, status text);
  create table public.media_assets (id uuid primary key default gen_random_uuid(), url text);
  create table public.top_performers (id uuid primary key default gen_random_uuid(), name text);

  create table public.audit_logs (
    id         uuid primary key default gen_random_uuid(),
    actor_id   uuid references auth.users(id) on delete set null,
    actor_name text,
    action     text not null,
    created_at timestamptz not null default now()
  );
`);

// ---------------------------------------------------------------------------
//  2. The project's real session chain
// ---------------------------------------------------------------------------
await stage('auth functions', `
  create function public.wire_bearer_token() returns text
  language sql stable as $fn$ select nullif(current_setting('wire.token', true), '') $fn$;

  create function public.current_account_id() returns uuid
  language sql stable security definer set search_path = public, extensions as $fn$
    select s.account_id
      from public.wire_sessions s
     where s.token_hash = md5(coalesce(public.wire_bearer_token(), ''))
       and s.revoked_at is null
       and s.expires_at > now()
     limit 1;
  $fn$;

  create function public.is_staff() returns boolean
  language sql stable security definer set search_path = public, extensions as $fn$
    select exists (
      select 1 from public.staff_accounts a
       where a.id = public.current_account_id() and a.status = 'active'
    );
  $fn$;

  create function public.is_owner() returns boolean
  language sql stable security definer set search_path = public, extensions as $fn$
    select exists (
      select 1 from public.staff_accounts a
       where a.id = public.current_account_id()
         and a.status = 'active'
         and a.is_owner
    );
  $fn$;

  create function public.can_approve() returns boolean
  language sql stable security definer set search_path = public, extensions as $fn$
    select public.is_owner() or exists (
      select 1 from public.staff_accounts a
       where a.id = public.current_account_id()
         and a.status = 'active'
         and a.role = 'Board Manager'
    );
  $fn$;

  grant execute on function public.is_staff()    to anon, authenticated;
  grant execute on function public.is_owner()    to anon, authenticated;
  grant execute on function public.can_approve() to anon, authenticated;
  grant usage on schema public to anon, authenticated;
`);

// ---------------------------------------------------------------------------
//  3. Accounts and sessions
// ---------------------------------------------------------------------------
const OWNER = '11111111-1111-1111-1111-111111111111';
const MANAGER = '22222222-2222-2222-2222-222222222222';
const WRITER = '33333333-3333-3333-3333-333333333333';
const PENDING = '44444444-4444-4444-4444-444444444444';

await db.query(
  `insert into public.staff_accounts (id, username, role, status, is_owner) values
     ($1,'owner','Owner','active',true),
     ($2,'manager','Board Manager','active',false),
     ($3,'writer','Writer','active',false),
     ($4,'pending','Writer','pending',false)`,
  [OWNER, MANAGER, WRITER, PENDING]
);
await db.query(
  `insert into public.staff (username, display_name) values
     ('owner','Melvin Jones'),('manager','Grace M'),('writer','Rita W'),('pending','Pat P')`
);
for (const [tok, acct] of [['tok-owner', OWNER], ['tok-manager', MANAGER],
                           ['tok-writer', WRITER], ['tok-pending', PENDING]]) {
  await db.query(
    `insert into public.wire_sessions (account_id, token_hash, expires_at)
     values ($1, md5($2), now() + interval '7 days')`,
    [acct, tok]
  );
}
await db.query(
  `insert into public.site_settings (title, subtitle, edition)
   values ('THE PULSE','MJLA PRESS CLUB','VOL. CXIV... NO. 32,841   NAKURU, KENYA')`
);

// ---------------------------------------------------------------------------
//  4. The PRE-034 / PRE-035 state, verbatim from 013, credentials.sql, schema.sql
// ---------------------------------------------------------------------------
await stage('pre-034 and pre-035 policies', `
  insert into storage.buckets (id, name, public) values ('wire-media','wire-media',true);

  create policy wire_media_insert on storage.objects for insert with check (bucket_id = 'wire-media');
  create policy wire_media_update on storage.objects for update using (bucket_id = 'wire-media') with check (bucket_id = 'wire-media');
  create policy wire_media_delete on storage.objects for delete using (bucket_id = 'wire-media');
  create policy wire_media_read   on storage.objects for select using (bucket_id = 'wire-media');

  create policy "wire media staff upload" on storage.objects for insert
    to authenticated with check (bucket_id = 'wire-media' and public.is_staff());
  create policy "wire media owner delete" on storage.objects for delete
    to authenticated using (bucket_id = 'wire-media' and public.is_owner());

  create policy settings_public_read    on public.site_settings for select using (true);
  create policy settings_staff_write     on public.site_settings for all using (public.is_staff()) with check (public.is_staff());
  create policy broadcasts_staff_all    on public.broadcasts    for all using (public.is_staff()) with check (public.is_staff());
  create policy assignments_public_read on public.assignments   for select using (true);
  create policy assignments_staff_write on public.assignments   for all using (public.is_staff()) with check (public.is_staff());
  create policy staff_staff_read        on public.staff         for select using (public.is_staff());
  create policy staff_staff_write       on public.staff         for all using (public.is_staff()) with check (public.is_staff());
  create policy media_public_read       on public.media_assets  for select using (true);
  create policy media_staff_write       on public.media_assets  for all using (public.is_staff()) with check (public.is_staff());
  create policy performers_public_read  on public.top_performers for select using (true);
  create policy performers_staff_write  on public.top_performers for all using (public.is_staff()) with check (public.is_staff());
  create policy audit_staff_read        on public.audit_logs    for select using (public.is_staff());
  create policy audit_staff_insert      on public.audit_logs    for insert with check (public.is_staff());
`);

// ---------------------------------------------------------------------------
//  4b. Table privileges.
//
//  RLS decides WHICH rows a role may touch; GRANT decides whether the role may
//  touch the table at all. Supabase grants anon/authenticated broad table
//  privileges, so without these every assertion -- including the ones that
//  should SUCCEED -- fails with "permission denied", and a test in that state
//  proves nothing either way.
// ---------------------------------------------------------------------------
await stage('table grants + row level security', `
  grant usage on schema storage to anon, authenticated;
  grant usage on schema public  to anon, authenticated;
  grant select, insert, update, delete on storage.objects          to anon, authenticated;
  grant select, insert, update, delete on public.broadcasts        to anon, authenticated;
  grant select, insert, update, delete on public.site_settings     to anon, authenticated;
  grant select, insert, update, delete on public.assignments       to anon, authenticated;
  grant select, insert, update, delete on public.staff             to anon, authenticated;
  grant select, insert, update, delete on public.audit_logs        to anon, authenticated;
  grant select, insert, update, delete on public.media_assets      to anon, authenticated;
  grant select, insert, update, delete on public.top_performers    to anon, authenticated;
  grant select, insert, update, delete on public.articles          to anon, authenticated;

  -- RLS MUST be enabled or the policies below are inert text. Leaving this out
  -- is not a subtle mistake: every assertion passes for the wrong reason --
  -- the grant layer blocks everything, so "a Writer cannot insert" looks true
  -- even when no policy exists at all.
  alter table storage.objects       enable row level security;
  alter table public.broadcasts     enable row level security;
  alter table public.site_settings  enable row level security;
  alter table public.assignments    enable row level security;
  alter table public.staff          enable row level security;
  alter table public.audit_logs     enable row level security;
  alter table public.media_assets   enable row level security;
  alter table public.top_performers enable row level security;
  alter table public.articles       enable row level security;
`);

// ===========================================================================
console.log('\n=== APPLYING THE MIGRATIONS FOR REAL ===');

for (const f of [
  'supabase/migrations/034_close_wire_media_storage_policies.sql',
  'supabase/migrations/035_staff_can_manage_and_server_side_audit.sql',
  'supabase/migrations/036_edition_line_drop_invented_volume_number.sql'
]) {
  const name = f.split('/').pop();
  try {
    await db.exec(read(f));
    ok(name + ' applied cleanly');
  } catch (e) {
    bad(name + ' FAILED');
    console.log('        ' + concise(e));
  }
}

// ===========================================================================
console.log('\n=== DOES THE FIX ACTUALLY WORK? ===');

/**
 * PGlite connects as superuser, and superusers BYPASS row level security, so
 * every behavioural assertion below does `set role anon|authenticated` first.
 * Without that the whole file would pass while proving nothing.
 */
const asRole = async (role, token, fn) => {
  await db.exec('reset role');
  await db.exec(`set wire.token = '${token ?? ''}'`);
  await db.exec(`set role ${role}`);
  try { return { ok: true, value: await fn() }; }
  catch (e) { return { ok: false, error: concise(e) }; }
  finally { await db.exec('reset role'); }
};

/**
 * Assert an operation is DENIED, measured by EFFECT rather than by exception.
 *
 * This is the subtlety that made the first version of this file report six
 * holes that were not holes. Row level security FILTERS rows; it does not raise.
 * Only INSERT raises, because WITH CHECK is evaluated on the proposed row. So:
 *
 *   INSERT  -> denied means the statement raised
 *   UPDATE  -> denied means it succeeded but matched ZERO rows
 *   DELETE  -> denied means it succeeded but matched ZERO rows
 *   SELECT  -> denied means it succeeded but returned ZERO rows
 *
 * Checking only "did it throw" would call an UPDATE that silently changed
 * nothing a successful attack.
 */
const denied = async (label, role, token, sql, kind) => {
  const r = await asRole(role, token, () => db.query(sql));
  const touched = r.ok && ((r.value.rowCount ?? 0) > 0 || (r.value.rows?.length ?? 0) > 0);

  if (r.ok && touched) {
    bad(`${label}  <-- it affected ${r.value.rowCount ?? r.value.rows.length} row(s)`);
    return;
  }
  if (!r.ok && kind === 'insert') {
    ok(`${label}  (refused: ${r.error.slice(0, 60)})`);
    return;
  }
  if (!r.ok) {
    bad(`${label}  <-- raised instead of filtering: ${r.error}`);
    return;
  }
  const how = kind === 'select' ? 'returned 0 rows' : `matched 0 rows`;
  ok(`${label}  (${how})`);
};

/** Assert an operation IS permitted and actually did something. */
const allowed = async (label, role, token, sql, kind) => {
  const r = await asRole(role, token, () => db.query(sql));
  if (!r.ok) { bad(`${label}  <-- blocked: ${r.error}`); return; }
  const touched = (r.value.rowCount ?? 0) > 0 || (r.value.rows?.length ?? 0) > 0;
  if (!touched) { bad(`${label}  <-- permitted but changed nothing`); return; }
  ok(label);
};

// --- storage: the CRITICAL bug ---------------------------------------------
console.log('\n-- wire-media storage --');

// Objects for the DELETE assertions to have something to act on. Without a row
// to remove, a filtered DELETE is indistinguishable from an allowed one.
await db.exec(`
  insert into storage.objects (bucket_id, name) values ('wire-media','portraits/seed.jpg');
`);

await denied('anon cannot INSERT into wire-media (the CRITICAL hole)', 'anon', null,
  `insert into storage.objects (bucket_id,name) values ('wire-media','evil.svg')`, 'insert');
await denied('anon cannot DELETE from wire-media', 'anon', null,
  `delete from storage.objects where bucket_id='wire-media'`, 'delete');
await denied('a pending account cannot upload a portrait', 'anon', 'tok-pending',
  `insert into storage.objects (bucket_id,name) values ('wire-media','portraits/p.jpg')`, 'insert');
await denied('a Writer cannot upload an .svg (stored XSS blocked)', 'authenticated', 'tok-writer',
  `insert into storage.objects (bucket_id,name) values ('wire-media','x.svg')`, 'insert');
await denied('a Writer cannot write outside portraits/', 'authenticated', 'tok-writer',
  `insert into storage.objects (bucket_id,name) values ('wire-media','secrets/y.png')`, 'insert');

await allowed('a Writer can still upload a portrait', 'authenticated', 'tok-writer',
  `insert into storage.objects (bucket_id,name) values ('wire-media','portraits/w.jpg')`, 'insert');
await allowed('a Writer can still upload at the bucket ROOT (gallery images)', 'authenticated', 'tok-writer',
  `insert into storage.objects (bucket_id,name) values ('wire-media','rootpic.jpg')`, 'insert');
await allowed('a Writer can still replace their own portrait (upsert path)', 'authenticated', 'tok-writer',
  `update storage.objects set name='portraits/w2.jpg' where bucket_id='wire-media' and name='portraits/w.jpg'`, 'update');

{
  const b = (await db.query(`select allowed_mime_types, file_size_limit, public from storage.buckets where id='wire-media'`)).rows[0];
  const okMime = JSON.stringify(b.allowed_mime_types) === JSON.stringify(['image/png', 'image/jpeg', 'image/webp']);
  if (okMime) ok('allowed_mime_types = ' + JSON.stringify(b.allowed_mime_types));
  else bad('allowed_mime_types is ' + JSON.stringify(b.allowed_mime_types));
  if (Number(b.file_size_limit) === 5242880) ok('file_size_limit = 5 MB');
  else bad('file_size_limit is ' + b.file_size_limit);
  if (b.public === true) ok('bucket is still public-read (article images keep loading)');
  else bad('bucket lost public read -- every article image would 403');
}

// --- the HIGH bug -----------------------------------------------------------
console.log('\n-- role-gated tables --');

for (const [table, col] of [
  ['public.broadcasts', 'title'],
  ['public.site_settings', 'title'],
  ['public.assignments', 'title'],
  ['public.staff', 'username']
]) {
  await denied('a Writer cannot INSERT into ' + table.replace('public.', ''),
    'authenticated', 'tok-writer', `insert into ${table} (${col}) values ('probe')`, 'insert');
}

await denied('a Writer cannot UPDATE the masthead', 'authenticated', 'tok-writer',
  `update public.site_settings set title = 'HIJACKED' where id = 1`, 'update');
await denied('a Writer cannot DELETE a roster row', 'authenticated', 'tok-writer',
  `delete from public.staff where username = 'owner'`, 'delete');
await allowed('a Board Manager can insert a broadcast (can_manage works)', 'authenticated', 'tok-manager',
  `insert into public.broadcasts (title) values ('probe-by-manager')`, 'insert');
await allowed('the Owner can still update masthead branding', 'authenticated', 'tok-owner',
  `update public.site_settings set title = 'THE PULSE' where id = 1`, 'update');

// --- audit ------------------------------------------------------------------
console.log('\n-- audit trail --');

// Seed one row so "can the Owner read it" is distinguishable from "the table is
// simply empty". An empty table makes every read assertion vacuously true.
await db.exec(`
  insert into public.audit_logs (actor_name, action) values ('owner','seeded row');
`);

await denied('a Writer cannot forge an audit row by direct INSERT', 'authenticated', 'tok-writer',
  `insert into public.audit_logs (action, actor_name) values ('forged','The Owner')`, 'insert');
await denied('a Writer cannot read the audit log', 'authenticated', 'tok-writer',
  `select actor_name from public.audit_logs`, 'select');
await allowed('the Owner can still read the audit log', 'authenticated', 'tok-owner',
  `select actor_name from public.audit_logs`, 'select');

{
  const r = await asRole('authenticated', 'tok-writer',
    () => db.query(`select public.wire_log_audit('probe action')`));
  if (!r.ok) {
    bad('wire_log_audit failed: ' + r.error);
  } else {
    const row = (await db.query(`select actor_name from public.audit_logs where action='probe action'`)).rows[0];
    if (row && row.actor_name === 'writer') ok('wire_log_audit filled actor_name from the SESSION: "' + row.actor_name + '"');
    else bad('wire_log_audit recorded actor "' + row?.actor_name + '", expected "writer"');
  }
}

// wire_log_audit is an RPC, not a table write, so denial is a RAISE (42501
// audit_not_permitted) rather than RLS row filtering. Asserted separately.
{
  const r = await asRole('anon', null, () => db.query(`select public.wire_log_audit('anon attempt')`));
  if (!r.ok && /audit_not_permitted/.test(r.error)) {
    ok('an anonymous caller is refused by wire_log_audit (audit_not_permitted)');
  } else if (r.ok) {
    bad('an anonymous caller CAN write an audit row');
  } else {
    bad('wire_log_audit refused anon, but not with audit_not_permitted: ' + r.error);
  }
}

// --- can_manage -------------------------------------------------------------
console.log('\n-- can_manage() --');

for (const [tok, want] of [['tok-owner', true], ['tok-manager', true],
                           ['tok-writer', false], ['tok-pending', false]]) {
  const r = await asRole('authenticated', tok, () => db.query('select public.can_manage() as m'));
  const got = r.ok && r.value.rows[0].m === want;
  if (got) ok('can_manage() is ' + want + ' for ' + tok);
  else bad('can_manage() returned ' + (r.ok ? r.value.rows[0].m : r.error) + ' for ' + tok + ', expected ' + want);
}

// --- 036 --------------------------------------------------------------------
console.log('\n-- 036 edition line --');

{
  const row = (await db.query('select edition from public.site_settings where id=1')).rows[0];
  if (row.edition === 'Nakuru, Kenya') ok('site_settings.edition is now "' + row.edition + '"');
  else bad('site_settings.edition is "' + row.edition + '"');
}

// --- the dequalification hypothesis, confirmed in situ ----------------------
console.log('\n-- how the new policies render --');

{
  const rows = (await db.query(
    `select policyname, qual from pg_policies
     where schemaname='public' and tablename='audit_logs' and cmd='SELECT'`)).rows;
  console.log('    audit_logs SELECT predicate as pg_policies renders it: ' + JSON.stringify(rows[0]?.qual));
  if (rows[0]?.qual === 'is_owner()') {
    ok('rendered WITHOUT the "public." prefix -- which is why the old exact comparison could never match');
  } else {
    bad('rendered as ' + JSON.stringify(rows[0]?.qual) + '; expected "is_owner()"');
  }
}

{
  const rows = (await db.query(
    `select policyname, qual, with_check from pg_policies
     where schemaname='public' and tablename='broadcasts'`)).rows;
  const guarded = rows.filter((r) => /can_manage/.test((r.qual || '') + (r.with_check || '')));
  if (rows.length > 0 && guarded.length === rows.length) ok('every broadcasts policy is can_manage()-guarded');
  else bad('a broadcasts policy is not can_manage()-guarded: ' + JSON.stringify(rows));
}

{
  const rows = (await db.query(
    `select policyname from pg_policies
     where schemaname='storage' and tablename='objects'
       and policyname like 'wire media%'`)).rows;
  if (rows.length === 0) ok('the dead space-named policies are gone');
  else bad('still present: ' + rows.map((r) => r.policyname).join(', '));
}

// ===========================================================================
await db.close();

console.log('\n------------------------------------------------------------------');
if (problems.length) {
  console.log(problems.length + ' problem(s):');
  for (const p of problems) console.log('  - ' + p);
  process.exit(1);
}
console.log('RESULT: PASS — all three migrations apply, and the holes stay closed.');