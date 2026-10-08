/* =============================================================================
   scripts/podcasts-storage-check.mjs — WHY THE EPISODE UPLOAD IS REFUSED
   -----------------------------------------------------------------------------
   Symptom, from a live session:

     Supabase Storage refused the upload: the signed-in account is not allowed
     to write to the "podcasts" bucket. (Storage said: new row violates
     row-level security policy)

   Storage policies are PERMISSIVE and are OR-ed across the whole
   storage.objects table, so an INSERT is allowed if ANY insert policy's WITH
   CHECK passes. That has a consequence worth stating plainly: nothing this
   project did to the wire-media bucket can block a podcasts upload, and
   nothing in 034/035/036 touches a podcasts policy. This file proves that by
   running both the broken and the fixed policy definition against real
   Postgres, and shows the upload going from refused to accepted.

   The two candidate causes produce this identical message:

     1. podcasts_upload still carries 024's `to authenticated`. This project has
        no Supabase Auth JWT, so requests arrive as `anon`, the role clause
        matches no policy, and the insert is refused.
     2. is_staff() is false for that account -- no Active row in staff_accounts.

   Both are checked below. Run the diagnostic at the bottom of this comment to
   tell which one is live.

   Run:  npm run test:podcasts
   ========================================================================== */

import { PGlite } from '@electric-sql/pglite';

const problems = [];
const ok = (m) => console.log('  PASS  ' + m);
const bad = (m) => { problems.push(m); console.log('  FAIL  ' + m); };

const db = await new PGlite();

const concise = (e) => {
  const m = String(e.message || e);
  const c = m.match(/ERROR:\s*(.+)/)?.[1] || m.split('\n')[0];
  return c.length > 150 ? c.slice(0, 150) + '...' : c;
};

const stage = async (label, sql) => {
  try { await db.exec(sql); }
  catch (e) { console.log(`\nSCAFFOLDING FAILED at: ${label}\n  ` + concise(e)); await db.close(); process.exit(2); }
};

await stage('schemas, roles, storage', `
  create schema if not exists extensions;
  create schema if not exists auth;
  create schema if not exists storage;

  do $$ begin create role anon;          exception when duplicate_object then null; end $$;
  do $$ begin create role authenticated; exception when duplicate_object then null; end $$;

  create table auth.users (id uuid primary key default gen_random_uuid());

  create table storage.buckets (
    id                 text primary key,
    name               text,
    public             boolean default false,
    allowed_mime_types text[],
    file_size_limit    bigint
  );
  create table storage.objects (
    id        uuid primary key default gen_random_uuid(),
    bucket_id text,
    name      text
  );
  alter table storage.objects enable row level security;

  create function storage.foldername(name text) returns text[]
  language sql immutable as $fn$
    select coalesce(
      (select array_agg(u.part)
         from unnest(string_to_array(name, '/')) with ordinality as u(part, ord)
        where u.ord < array_length(string_to_array(name, '/'), 1)),
      ARRAY[]::text[]
    )
  $fn$;

  create table public.wire_sessions (
    id uuid primary key default gen_random_uuid(), account_id uuid,
    token_hash text, expires_at timestamptz, revoked_at timestamptz
  );
  create table public.staff_accounts (
    id uuid primary key default gen_random_uuid(), username text,
    role text, status text, is_owner boolean default false
  );
`);

await stage('auth functions', `
  create function public.wire_bearer_token() returns text
  language sql stable as $fn$ select nullif(current_setting('wire.token', true), '') $fn$;

  create function public.current_account_id() returns uuid
  language sql stable security definer set search_path = public, extensions as $fn$
    select s.account_id from public.wire_sessions s
     where s.token_hash = md5(coalesce(public.wire_bearer_token(), ''))
       and s.revoked_at is null and s.expires_at > now()
     limit 1;
  $fn$;

  create function public.is_staff() returns boolean
  language sql stable security definer set search_path = public, extensions as $fn$
    select exists (select 1 from public.staff_accounts a
                    where a.id = public.current_account_id() and a.status = 'active');
  $fn$;

  create function public.is_owner() returns boolean
  language sql stable security definer set search_path = public, extensions as $fn$
    select exists (select 1 from public.staff_accounts a
                    where a.id = public.current_account_id()
                      and a.status = 'active' and a.is_owner);
  $fn$;

  grant usage on schema public, storage to anon, authenticated;
  grant execute on function public.is_staff() to anon, authenticated;
  grant execute on function public.is_owner() to anon, authenticated;
  grant select, insert, update, delete on storage.objects to anon, authenticated;
`);

const OWNER = '11111111-1111-1111-1111-111111111111';
const WRITER = '33333333-3333-3333-3333-333333333333';
const PENDING = '44444444-4444-4444-4444-444444444444';

await db.query(
  `insert into public.staff_accounts (id, username, role, status, is_owner) values
     ($1,'owner','Owner','active',true), ($2,'writer','Writer','active',false),
     ($3,'pending','Writer','pending',false)`,
  [OWNER, WRITER, PENDING]
);
for (const [tok, acct] of [['tok-owner', OWNER], ['tok-writer', WRITER], ['tok-pending', PENDING]]) {
  await db.query(
    `insert into public.wire_sessions (account_id, token_hash, expires_at)
     values ($1, md5($2), now() + interval '7 days')`, [acct, tok]);
}
await db.exec(`insert into storage.buckets (id, name, public, file_size_limit)
               values ('podcasts','podcasts',true, 26214400)`);

/**
 * Every request is made as non, NOT uthenticated.
 *
 * This project has no Supabase Auth JWT, so supabase-js sends the anon key with
 * no Authorization header and PostgREST resolves the Postgres role to non.
 * The custom x-wire-token header authenticates the *policy predicates*, not the
 * role. Running these assertions as uthenticated would let a policy scoped
 * 	o authenticated match -- which is precisely the bug 025 fixes, and the
 * first version of this file therefore "reproduced" it while actually passing.
 */
const asRole = async (role, token, fn) => {
  await db.exec('reset role');
  await db.exec(`set wire.token = '${token ?? ''}'`);
  await db.exec(`set role ${role}`);
  try { return { ok: true, value: await fn() }; }
  catch (e) { return { ok: false, error: concise(e) }; }
  finally { await db.exec('reset role'); }
};

const upload = (role, token, name) =>
  asRole(role, token, () =>
    db.query(`insert into storage.objects (bucket_id,name) values ('podcasts',$1)`, [name]));

// ===========================================================================
console.log('\n=== 1. WITH 024\'s POLICY (the bug) ==============================');

await stage('024 policy', `
  create policy podcasts_upload on storage.objects
    for insert to authenticated
    with check (bucket_id = 'podcasts' and public.is_staff()
                and coalesce((storage.foldername(name))[1], '') = 'episodes');
`);

{
  const r = await upload('anon', 'tok-writer', 'episodes/a.mp3');
  if (!r.ok) ok('a Writer is REFUSED -- reproduces the reported error');
  else bad('a Writer was allowed: 024 `to authenticated` is NOT the cause');

  const roles = (await db.query(
    `select policyname, roles::text from pg_policies
     where schemaname='storage' and policyname='podcasts_upload'`)).rows[0];
  console.log('    podcasts_upload applies to roles: ' + roles.roles);
  if (/authenticated/.test(roles.roles) && !/public/.test(roles.roles)) {
    ok('it names the `authenticated` role, which this project never has');
  } else {
    bad('unexpected roles: ' + roles.roles);
  }
}

// ===========================================================================
console.log('\n=== 2. WITH 025\'s POLICY (the fix) ==============================');

await stage('025 policies', `
  drop policy if exists podcasts_upload on storage.objects;
  create policy podcasts_read on storage.objects
    for select using (bucket_id = 'podcasts');

  create policy podcasts_upload on storage.objects
    for insert
    with check (bucket_id = 'podcasts' and public.is_staff()
                and coalesce((storage.foldername(name))[1], '') = 'episodes');

  create policy podcasts_delete on storage.objects
    for delete using (bucket_id = 'podcasts' and public.is_owner());
`);

{
  const r = await upload('anon', 'tok-writer', 'episodes/a.mp3');
  if (r.ok) ok('a Writer CAN upload an episode after 025');
  else bad('a Writer is STILL refused after 025: ' + r.error);

  const roles = (await db.query(
    `select roles::text from pg_policies
     where schemaname='storage' and policyname='podcasts_upload'`)).rows[0];
  console.log('    podcasts_upload applies to roles: ' + roles.roles);
  if (/\bpublic\b/.test(roles.roles)) ok('no role clause -- it is evaluated for every request');
  else bad('still role-scoped: ' + roles.roles);
}

// The preflight probe src/lib/podcasts.js:246 uses. It has NO .mp3 extension, so
// if the policy ever grows an extension check the Owner would be told the bucket
// is unwritable when the uploads themselves are fine.
{
  const r = await upload('anon', 'tok-writer', 'episodes/.write-probe');
  if (r.ok) ok('the preflight probe path episodes/.write-probe is accepted');
  else bad('the preflight probe is REFUSED, so the dialog would never open: ' + r.error);
}

// Cause 2: is_staff() false.
{
  const r = await upload('anon', 'tok-pending', 'episodes/p.mp3');
  if (!r.ok) ok('a PENDING account is refused (is_staff() false) -- the other cause of this error');
  else bad('a pending account can upload');

  const r2 = await upload('anon', null, 'episodes/x.mp3');
  if (!r2.ok) ok('an anonymous caller is refused');
  else bad('an anonymous caller can upload');
}

// Outside the episodes/ prefix.
{
  const r = await upload('anon', 'tok-writer', 'misc/a.mp3');
  if (!r.ok) ok('writes outside episodes/ are refused');
  else bad('a Writer can write outside episodes/');
}

// Delete stays Owner-only.
{
  await db.exec(`insert into storage.objects (bucket_id,name) values ('podcasts','episodes/seed.mp3')`);
  const w = await asRole('anon', 'tok-writer',
    () => db.query(`delete from storage.objects where name='episodes/seed.mp3'`));
  if (w.ok && (w.value.rowCount ?? 0) === 0) ok('a Writer cannot delete an episode (0 rows matched)');
  else bad('a Writer CAN delete an episode');

  await db.exec(`insert into storage.objects (bucket_id,name) values ('podcasts','episodes/seed2.mp3')`);
  const o = await asRole('anon', 'tok-owner',
    () => db.query(`delete from storage.objects where name='episodes/seed2.mp3'`));
  if (o.ok && (o.value.rowCount ?? 0) > 0) ok('the Owner can still purge an episode');
  else bad('the Owner cannot purge an episode: ' + (o.error || 'matched 0 rows'));
  if (o.ok && (o.value.rowCount ?? 0) > 0) ok('the Owner can still purge an episode');
  else bad('the Owner cannot purge an episode: ' + (o.error || 'matched 0 rows'));
}

// Nothing from the wire-media work leaks across.
{
  await stage('wire-media policies as 034 leaves them', `
    drop policy if exists wire_media_insert on storage.objects;
    create policy wire_media_insert on storage.objects for insert
      with check (bucket_id = 'wire-media' and public.is_staff());
  `);
  const r = await upload('anon', 'tok-writer', 'episodes/after034.mp3');
  if (r.ok) ok('podcasts uploads still work AFTER the wire-media policies are replaced');
  else bad('the wire-media policies broke podcasts uploads: ' + r.error);
}

await db.close();

console.log('\n------------------------------------------------------------------');
console.log('DIAGNOSTIC — run this in the Supabase SQL editor to find which cause is live:\n');
console.log(`  select policyname, cmd, roles::text, qual, with_check
   from pg_policies
   where schemaname = 'storage'
     and policyname in ('podcasts_upload','podcasts_delete','podcasts_read');\n`);
console.log('  Cause 1, if roles shows {authenticated} and NOT public: 025 was never applied.');
console.log('  Cause 2, if it shows public but uploads still fail: is_staff() is false for that');
console.log('  account, so check staff_accounts.status = active for the username you log in with.\n');
console.log(problems.length ? problems.length + ' problem(s):' : 'RESULT: PASS');
for (const p of problems) console.log('  - ' + p);
process.exit(problems.length ? 1 : 0);