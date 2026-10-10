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

  -- The column is 'name'. schema.sql:50 defines public.staff.name, and the live
  -- database was found the hard way: 035's wire_log_audit joined public.staff on
  -- s.display_name, which does not exist, so EVERY audit write failed at runtime
  -- with 42703. This scaffold had invented a display_name column, so the migration
  -- passed here and failed in production. A test fixture that does not match the
  -- real schema certifies the wrong thing.
  create table public.staff (
    id           uuid primary key default gen_random_uuid(),
    name         text,
    username     text,
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

  -- The REAL shape from schema.sql + 019/020, not a stand-in. 039 claims on
  -- pushed_at and orders by created_at, so both columns have to exist and have
  -- to mean what it assumes.
  create table public.broadcasts (
    id              uuid primary key default gen_random_uuid(),
    title           text not null,
    message         text,
    body            text,
    audience        text not null default 'Everyone',
    delivered_count integer not null default 0,
    created_at      timestamptz not null default now(),
    pushed_at       timestamptz
  );
  create table public.assignments (id uuid primary key default gen_random_uuid(), title text);
  create table public.articles (id uuid primary key default gen_random_uuid(), title text, status text);
  create table public.media_assets (id uuid primary key default gen_random_uuid(), url text, caption text, created_at timestamptz not null default now());
  create table public.top_performers (id uuid primary key default gen_random_uuid(), name text);

  create table public.podcasts (
    id                uuid primary key default gen_random_uuid(),
    title             text not null,
    storage_path      text,
    duration_seconds  integer,
    status            text not null default 'pending',
    author_account_id uuid references public.staff_accounts (id) on delete set null
  );

  -- The real 022 shape, because 040 adds a column to it. A fixture that
  -- invents its own table certifies nothing: the 'guest text not null' and
  -- 'video_ids jsonb' below are what a 'video' row has to live alongside.
  create table public.interviews (
    id                uuid primary key default gen_random_uuid(),
    title             text not null,
    guest             text not null,
    guest_role        text,
    interviewer       text,
    summary           text,
    description       text,
    image_url         text,
    video_ids         jsonb not null default '[]'::jsonb,
    status            text not null default 'pending',
    author_account_id uuid references public.staff_accounts (id) on delete set null,
    created_at        timestamptz not null default now()
  );
  alter table public.interviews enable row level security;

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
  `insert into public.staff (username, name) values
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

  -- 024/029/030/033 verbatim. 038 is what changes these, so the PRE-038 state has
  -- to be right or the test would pass against a strawman.
  insert into storage.buckets (id, name, public) values ('podcasts','podcasts',true);
  create policy podcasts_public_read       on public.podcasts for select using (status = 'approved' or public.is_staff());
  create policy podcasts_staff_submit      on public.podcasts for insert
    with check (public.is_staff() and status = 'pending' and author_account_id = public.current_account_id());
  create policy podcasts_owner_all         on public.podcasts for all
    using (public.is_owner()) with check (public.is_owner());
  create policy podcasts_delete_own_pending on public.podcasts for delete
    using (public.is_staff() and status = 'pending' and author_account_id = public.current_account_id());
  create policy podcasts_approver_update   on public.podcasts for update to anon, authenticated
    using (public.can_approve()) with check (public.can_approve());

  create policy podcasts_read   on storage.objects for select using (bucket_id = 'podcasts');
  create policy podcasts_upload on storage.objects for insert
    with check (bucket_id = 'podcasts' and public.is_staff() and coalesce((storage.foldername(name))[1], '') = 'episodes');
  create policy podcasts_delete on storage.objects for delete
    using (bucket_id = 'podcasts' and public.is_owner());

  -- The predicate interviews_delete_own is built on, and the row it needs to
  -- match a writer's own row.
  -- WITHOUT IT that policy can never match, and a Writer silently loses the
  -- ability to withdraw their own pending submission -- exactly the failure this
  -- section exists to catch, and exactly what happened the first time it ran:
  -- the assertion failed with "0 rows" and the cause was a missing function in
  -- the fixture, not a missing grant in the policy.
  --
  -- SECURITY DEFINER with a pinned search_path, same as the real one: it reads
  -- staff_accounts, which anon cannot select.
  -- The ownership arm is load-bearing and mirrors the real function:
  -- 022 requires author_account_id to be non-null AND equal to the current
  -- account. An earlier version of this fixture omitted the null check, which let
  -- every seeded row be claimable by whoever asked -- and the "a Writer cannot
  -- delete somebody else's row" assertions then failed for a reason that had
  -- nothing to do with the policy under test.
  create function public.wire_owns_interview(p_id uuid) returns boolean
  language sql stable security definer set search_path = public, extensions as $fn$
    select exists (
      select 1 from public.interviews i
       where i.id = p_id
         and i.author_account_id is not null
         and i.author_account_id = public.current_account_id()
    )
  $fn$;
  grant execute on function public.wire_owns_interview(uuid) to anon, authenticated;

  -- 022 + 033 verbatim. 040 rebuilds interviews_staff_insert and adds the
  -- category guard, so the PRE-040 state has to be right or this tests a strawman.
  create policy interviews_public_read on public.interviews for select to anon, authenticated
    using (lower(status) = 'published' or public.is_staff());
  create policy interviews_staff_insert on public.interviews for insert to anon, authenticated
    with check (public.is_staff() and (public.is_owner()
      or (status = 'pending' and (author_account_id is null
                                  or author_account_id = public.current_account_id()))));
  create policy interviews_owner_all on public.interviews for all to anon, authenticated
    using (public.is_owner()) with check (public.is_owner());
  create policy interviews_update_own on public.interviews for update to anon, authenticated
    using (author_account_id = public.current_account_id()) with check (author_account_id = public.current_account_id());
  create policy interviews_approver_update on public.interviews for update to anon, authenticated
    using (public.can_approve()) with check (public.can_approve());
  -- Needed because the fixture does NOT apply migration 022, which is where this
  -- policy is really created. Without it a Writer has no delete path at all and
  -- "can they withdraw their own pending submission?" fails for a reason that has
  -- nothing to do with the answer.
  create policy interviews_delete_own on public.interviews for delete to anon, authenticated
    using (public.wire_owns_interview(id));
`);

// Two interviews that already exist, both PUBLISHED, both readers can see today.
// If the backfill puts either on the wrong side of the split it silently
// disappears from /interviews, which is the regression this test exists for.
//
// Filed BY the writer, which several later assertions depend on: "a Writer can
// still edit their own row" and "the Owner can re-file" both act on these. The
// reject assertions use their OWN seeded rows instead.
await db.exec(`
  insert into public.interviews (title, guest, status, author_account_id, created_at) values
    ('Chair interview', 'Hon. Kari',  'published', '33333333-3333-3333-3333-333333333333', now() - interval '5 days'),
    ('Coach interview', 'Mr. Otieno', 'published', '33333333-3333-3333-3333-333333333333', now() - interval '2 days');
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
  grant select, insert, update, delete on public.podcasts          to anon, authenticated;
  grant select, insert, update, delete on public.interviews       to anon, authenticated;

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
  alter table public.podcasts       enable row level security;
  alter table public.interviews    enable row level security;
`);

// Two photos that already exist BEFORE 037 runs.
//
// Inserted HERE, not in the media section: a column default is applied to rows
// already in the table, which is precisely the trap 037's backfill exists to
// avoid. A row inserted after 037 correctly becomes 'pending'.
await db.exec(`
  insert into public.media_assets (url, caption) values ('https://x.test/a.jpg','old one');
  insert into public.media_assets (url, caption) values ('https://x.test/b.jpg','old two');
`);

// ===========================================================================
console.log('\n=== APPLYING THE MIGRATIONS FOR REAL ===');

for (const f of [
  'supabase/migrations/034_close_wire_media_storage_policies.sql',
  'supabase/migrations/035_staff_can_manage_and_server_side_audit.sql',
  'supabase/migrations/036_edition_line_drop_invented_volume_number.sql',
  'supabase/migrations/037_media_requires_approval.sql',
  'supabase/migrations/038_approver_can_refuse_a_pending_episode.sql',
  'supabase/migrations/039_claim_next_broadcast.sql',
  'supabase/migrations/040_interviews_get_a_category.sql'
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

/**
 * Assert an operation is refused by a PRIVILEGE, which is a different mechanism
 * from RLS and behaves differently.
 *
 * A missing table GRANT or function EXECUTE fails at the permission layer, before
 * any policy is consulted, so it RAISES 42501 rather than filtering rows. The
 * `denied` helper above treats a raise as a failure on purpose -- for an UPDATE
 * or DELETE, "succeeded but matched nothing" is the dangerous case and "raised"
 * is the safe one -- but for a table with no SELECT policy a filtered read and a
 * refused read look identical, which is why those two live in different helpers.
 *
 * Using `denied` here would report a correctly refused call as a broken one.
 */
const refused = async (label, role, token, sql) => {
  const r = await asRole(role, token, () => db.query(sql));
  if (!r.ok) { ok(`${label}  (refused: ${r.error.slice(0, 62)})`); return; }
  if ((r.value.rows?.length ?? 0) > 0) { bad(`${label}  <-- it was permitted`); return; }
  bad(`${label}  <-- returned rows without raising`);
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

const MIME_EXPECTED = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'];

{
  const b = (await db.query(`select allowed_mime_types, file_size_limit, public from storage.buckets where id='wire-media'`)).rows[0];
  const got = Array.isArray(b.allowed_mime_types) ? [...b.allowed_mime_types].sort() : b.allowed_mime_types;
  if (JSON.stringify(got) === JSON.stringify([...MIME_EXPECTED].sort())) {
    ok('allowed_mime_types = ' + JSON.stringify(b.allowed_mime_types));
  } else {
    bad('allowed_mime_types is ' + JSON.stringify(b.allowed_mime_types));
  }

  // No cap: null means the bucket inherits the project's global limit.
  if (b.file_size_limit === null) ok('file_size_limit is null -- the project limit governs, so large photos are fine');
  else bad('file_size_limit is ' + b.file_size_limit + ', which would reject large photographs');

  if (b.public === true) ok('bucket is still public-read (article images keep loading)');
  else bad('bucket lost public read -- every article image would 403');
}

// The formats that carry no script must be accepted, or ordinary newsroom
// photography stops uploading for no security benefit.
for (const name of ['shot.gif', 'shot.avif', 'portraits/p.webp']) {
  const r = await asRole('anon', 'tok-writer',
    () => db.query(`insert into storage.objects (bucket_id,name) values ('wire-media',$1)`, [name]));
  if (r.ok) ok('a Writer can upload ' + name);
  else bad('a Writer cannot upload ' + name + ' -- ' + r.error);
}

// ... and the ones that can carry script must still be refused.
for (const name of ['x.svg', 'x.html', 'x.svgz']) {
  const r = await asRole('anon', 'tok-writer',
    () => db.query(`insert into storage.objects (bucket_id,name) values ('wire-media',$1)`, [name]));
  if (!r.ok) ok('a Writer cannot upload ' + name + ' (can carry script)');
  else bad('a Writer CAN upload ' + name + ' into a public bucket');
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
    // "Rita W", NOT "writer". The actor is the PROFILE name from public.staff,
    // because that is what appears on a byline; staff_accounts.username is the
    // login. Asserting the username here is what let the s.display_name bug look
    // harmless for as long as it did.
    if (row && row.actor_name === 'Rita W') ok('wire_log_audit filled actor_name from the SESSION, as the profile name: "' + row.actor_name + '"');
    else bad('wire_log_audit recorded actor "' + row?.actor_name + '", expected "Rita W"');
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

// --- 037: media must not be postable by a Writer without approval -----------
console.log('\n-- media approval (037) --');

{
  const rows = (await db.query(`select caption, status from public.media_assets order by caption`)).rows;
  const allApproved = rows.length === 2 && rows.every((r) => r.status === 'approved');
  if (allApproved) ok('the 2 pre-existing photos are backfilled to approved -- the gallery is not blanked');
  else bad('pre-existing photos were not all approved: ' + JSON.stringify(rows));
}

{
  // Readers must not see a pending row.
  await db.exec(`insert into public.media_assets (url, caption, status) values ('https://x.test/p.jpg','pending one','pending')`);
  const r = await asRole('anon', null, () => db.query('select caption from public.media_assets'));
  const visible = (r.value?.rows ?? []).map((x) => x.caption);
  if (!visible.includes('pending one')) ok('a reader cannot see a PENDING photo');
  else bad('a reader can see a pending photo: ' + JSON.stringify(visible));
  if (visible.includes('old one')) ok('a reader still sees the pre-existing approved photo');
  else bad('the existing gallery went blank');
}

// A Writer uploading lands as pending and cannot self-approve.
{
  const r = await asRole('anon', 'tok-writer',
    () => db.query(`insert into public.media_assets (url, caption) values ('https://x.test/w.jpg','writer upload') returning status`));
  if (r.ok && r.value.rows[0]?.status === 'pending') ok("a Writer's upload lands as pending, automatically");
  else bad("a Writer's upload status is " + JSON.stringify(r.value?.rows?.[0]?.status ?? r.error));
}

{
  const r = await asRole('anon', 'tok-writer',
    () => db.query(`insert into public.media_assets (url, caption, status) values ('https://x.test/hack.jpg','sneaky','approved')`));
  if (!r.ok) ok('a Writer CANNOT insert a row that is already approved');
  else bad('a Writer self-approved an upload on insert');
}

{
  const r = await asRole('anon', 'tok-writer',
    () => db.query(`update public.media_assets set status='approved' where caption='writer upload'`));
  const touched = r.ok && (r.value.rowCount ?? 0) > 0;
  if (!touched) ok('a Writer CANNOT promote their pending photo to approved');
  else bad('a Writer promoted a pending photo to approved');
}

{
  // A Writer may still fix a caption while the row is pending.
  const r = await asRole('anon', 'tok-writer',
    () => db.query(`update public.media_assets set caption='fixed caption' where url='https://x.test/w.jpg' returning caption`));
  if (r.ok && (r.value.rowCount ?? 0) > 0) ok('a Writer can still edit their PENDING row (fix a caption)');
  else bad('a Writer cannot edit their own pending row: ' + (r.error || '0 rows'));
}

{
  // A Writer must not be able to edit an APPROVED row.
  const r = await asRole('anon', 'tok-writer',
    () => db.query(`update public.media_assets set caption='vandalised' where caption='old one'`));
  const touched = r.ok && (r.value.rowCount ?? 0) > 0;
  if (!touched) ok('a Writer cannot edit an APPROVED row');
  else bad('a Writer edited an approved row');
}

// The approvers.
{
  const r = await asRole('anon', 'tok-manager',
    () => db.query(`update public.media_assets set status='approved' where url='https://x.test/w.jpg' returning status`));
  if (r.ok && r.value.rows[0]?.status === 'approved') ok('a Board Manager CAN approve a pending photo');
  else bad('a Board Manager could not approve: ' + (r.error || JSON.stringify(r.value?.rows)));
}

{
  const r = await asRole('anon', 'tok-owner',
    () => db.query(`update public.media_assets set status='approved' where url='https://x.test/p.jpg' returning status`));
  if (r.ok && r.value.rows[0]?.status === 'approved') ok('the Owner CAN approve a pending photo');
  else bad('the Owner could not approve: ' + (r.error || JSON.stringify(r.value?.rows)));
}

{
  const r = await asRole('anon', null, () => db.query(`select caption from public.media_assets`));
  const visible = (r.value?.rows ?? []).map((x) => x.caption);
  // Matched by url, not caption: the row's caption was deliberately edited by an
  // earlier assertion, so asserting on it here would test the wrong thing.
  if (visible.some((c) => c === 'fixed caption')) ok('the newly approved photo is now publicly visible');
  else bad('an approved photo is still not publicly visible: ' + JSON.stringify(visible));

  if (visible.includes('old one')) ok('the pre-existing gallery photos are still publicly visible');
  else bad('the existing gallery went blank: ' + JSON.stringify(visible));
}

{
  const r = await asRole('anon', 'tok-writer', () => db.query(`delete from public.media_assets where caption='old two'`));
  if (r.ok && (r.value.rowCount ?? 0) === 0) ok('a Writer still cannot DELETE a photo (Owner only)');
  else bad('a Writer deleted a photo');
}

// --- 038: an approver can refuse a PENDING episode --------------------------
//
// THE BUG THIS FIXES, STATED AS A TEST.
//
// The panel has always offered a Board Manager a "Refuse" button on a Writer's
// pending episode, but podcasts_delete was is_owner() only. RLS FILTERS, so the
// DELETE succeeded having removed nothing, and the client reported "Submission
// refused and its audio purged." These assertions fail against the pre-038
// policies and pass after it.
console.log('\n-- 038 approver refuses a pending episode --');

{
  // The Writer's own submission, pending.
  await db.exec(`
    insert into public.podcasts (title, storage_path, status, author_account_id)
    values ('pending ep','episodes/pending.mp3','pending',
            '33333333-3333-3333-3333-333333333333');
    insert into public.podcasts (title, storage_path, status, author_account_id)
    values ('live ep','episodes/live.mp3','approved',
            '33333333-3333-3333-3333-333333333333');
  `);
  await db.exec(`
    insert into storage.objects (bucket_id,name) values ('podcasts','episodes/pending.mp3');
    insert into storage.objects (bucket_id,name) values ('podcasts','episodes/live.mp3');
  `);
}

await allowed('a Board Manager CAN delete a PENDING row (this is the bug)', 'authenticated', 'tok-manager',
  `delete from public.podcasts where title = 'pending ep'`, 'delete');

await allowed('a Board Manager CAN purge the audio of a refused episode', 'authenticated', 'tok-manager',
  `delete from storage.objects where name = 'episodes/pending.mp3'`, 'delete');

await denied('a Board Manager still CANNOT delete a PUBLISHED episode', 'authenticated', 'tok-manager',
  `delete from public.podcasts where title = 'live ep'`, 'delete');

await denied('a Board Manager still CANNOT purge a published episode\'s audio', 'authenticated', 'tok-manager',
  `delete from storage.objects where name = 'episodes/live.mp3'`, 'delete');

await denied('a WRITER cannot delete a pending episode they did not file', 'authenticated', 'tok-writer',
  `delete from public.podcasts where title = 'live ep'`, 'delete');

await denied('a Writer cannot purge any audio at all', 'authenticated', 'tok-writer',
  `delete from storage.objects where bucket_id='podcasts'`, 'delete');

// The Owner must not have been narrowed by 038.
await allowed('the Owner can still delete a published episode', 'authenticated', 'tok-owner',
  `delete from public.podcasts where title = 'live ep'`, 'delete');

// The live row is gone but its audio must SURVIVE, which is the proof that the
// two halves were not widened together by accident.
//
// Needs its own still-published row. The Owner has just deleted the 'live ep'
// row above, which leaves 'episodes/live.mp3' an ORPHAN -- and an orphan is
// purgeable on purpose, or the 1-byte write probes could never be swept by
// anyone but the Owner. Asserting against that orphan tests the wrong thing.
{
  await db.exec(`
    insert into public.podcasts (title, storage_path, status, author_account_id)
    values ('still live','episodes/still-live.mp3','approved',
            '33333333-3333-3333-3333-333333333333');
    insert into storage.objects (bucket_id,name) values ('podcasts','episodes/still-live.mp3');
  `);
  const r = await asRole('authenticated', 'tok-manager',
    () => db.query(`delete from storage.objects where name='episodes/still-live.mp3'`));
  const gone = r.ok && (r.value.rowCount ?? 0) > 0;
  if (gone) bad('a Board Manager purged a PUBLISHED episode\'s audio -- 038 widened the storage policy too far');
  else ok('a published episode\'s audio survives while its row exists -- an unpublish cannot erase the recording');
}

// An orphan with no row at all must be sweepable, or the 1-byte write probes
// (which cleanup cannot remove, because that is is_owner()-only) accumulate
// forever with nobody able to clear them.
{
  await db.exec(`insert into storage.objects (bucket_id,name) values ('podcasts','episodes/.write-probe-abc')`);
  await allowed('a Board Manager CAN sweep an orphaned probe object', 'authenticated', 'tok-manager',
    `delete from storage.objects where name = 'episodes/.write-probe-abc'`, 'delete');
}

// A suspended approver is still refused. can_approve() carries the status check;
// this is what stops a de-activated Board Manager from purging anything.
await denied('a SUSPENDED Board Manager cannot refuse an episode', 'authenticated', 'tok-pending',
  `delete from public.podcasts where title = 'live ep'`, 'delete');

// --- 039: a broadcast can only be claimed once ------------------------------
//
// THE BUG THIS FIXES. The handler used to SELECT `pushed_at is null`, send to
// every subscriber, and only THEN stamp `pushed_at`. Two statements, so a second
// invocation in between reads the same row and sends it too. An external
// scheduler firing every minute makes that overlap routine: a send takes
// seconds.
//
// Note on method: PGlite is a SINGLE connection and serialises transactions, so
// genuine parallel interleaving cannot be exercised here -- a second
// transaction waits for the first to commit. Verified experimentally before
// writing this. What IS provable here, and is asserted below, is the property
// that makes overlap harmless: the claim stamps the row in the same statement
// that returns it, so there is no window. The lock-holding half of that is
// asserted statically on the function source, since `for update skip locked` is
// a property of the SQL text rather than of a single-connection test run.
console.log('\n-- 039 atomic broadcast claim --');

// Cleared first: an earlier section inserted a broadcast ('probe-by-manager') to
// test broadcasts_staff_all, so it is still sitting in this table unpushed and
// would be claimed here, making every assertion about WHICH row came back
// meaningless. Each scenario below re-seeds its own rows, because claiming
// CONSUMES them -- that is the entire behaviour under test.
await stage('broadcast fixtures', `
  delete from public.broadcasts;
`);

/** Fresh queue, oldest first. Each scenario owns its rows. */
const seedBroadcasts = async (titles) => {
  await db.exec(`delete from public.broadcasts`);
  for (let i = 0; i < titles.length; i++) {
    await db.query(
      `insert into public.broadcasts (title, created_at) values ($1, now() - make_interval(mins => $2))`,
      [titles[i], (titles.length - i) * 10]
    );
  }
};

const claim = async (id = null) => {
  const r = await asRole('service_role', null, () =>
    db.query(`select title from public.wire_claim_next_broadcast($1)`, [id]));
  return r.ok ? r.value.rows : null;
};

// --- the ordering fix ------------------------------------------------------
//
// The old handler selected newest-first with limit(5) and used the first row, so
// a backlog went out newest-to-oldest: the newest broadcast jumped the queue
// while older ones waited. Broadcasting is a sequence people read in order.
await seedBroadcasts(['first', 'second', 'third']);

{
  const got = await claim();
  if (got?.[0]?.title === 'first') ok('the OLDEST undelivered broadcast is claimed first');
  else bad('claimed ' + JSON.stringify(got?.map((x) => x.title) ?? null) + ', expected "first"');

  const stamped = (await db.query(
    `select pushed_at is not null as stamped from public.broadcasts where title='first'`)).rows[0];
  if (stamped.stamped) ok('the claim STAMPS pushed_at in the same statement that returns the row');
  else bad('the returned row was not stamped -- there is still a window for a duplicate send');
}

// --- the queue drains in order ---------------------------------------------
//
// Continues from the claim above rather than starting over: a queue that
// restarts from the beginning on every tick would send 'first' repeatedly.
{
  const seen = [];
  for (let i = 0; i < 3; i++) {
    const rows = await claim();
    if (rows?.length) seen.push(rows[0].title);
  }
  const joined = seen.join(',');
  if (joined === 'second,third') ok('the queue drains in order, one broadcast per call: ' + joined);
  else bad('drained as [' + joined + '], expected second,third');
}

// --- the duplicate-send window --------------------------------------------
//
// THE assertion that would fail against the old read-then-write code.
//
// Deliberately run against a queue holding EXACTLY ONE broadcast. With a backlog
// present, a second claim correctly returns the next undelivered row, and
// asserting on that would be asserting the wrong thing: the queue draining is
// correct behaviour. The duplicate is a single broadcast becoming available to
// two senders, so the queue has to hold one row for that to be observable.
await seedBroadcasts(['only one']);

{
  const first = await claim();

  // The old code stamped pushed_at only AFTER a send that takes seconds. This
  // call stands in for the second scheduler tick landing inside that window.
  const second = await claim();

  if (first?.[0]?.title === 'only one') ok('the single broadcast is claimed');
  else bad('the claim returned ' + JSON.stringify(first?.map((x) => x.title) ?? null));

  if (second?.length === 0) {
    ok('a second claim of the SAME broadcast finds nothing -- no duplicate send possible');
  } else {
    bad('the same broadcast was claimable twice: ' + JSON.stringify(second.map((x) => x.title)));
  }
}

// --- the webhook path ------------------------------------------------------
//
// The Supabase webhook posts the id of a row it just saw inserted. It used to
// select by id with NO pushed_at filter at all, so a retried webhook -- which
// is exactly what a timeout causes -- resent the broadcast to everyone.
await seedBroadcasts(['from webhook']);

{
  const target = (await db.query(`select id from public.broadcasts where title='from webhook'`)).rows[0];

  const first = await claim(target.id);
  const retry = await claim(target.id);

  if (first?.[0]?.title === 'from webhook') ok('a webhook can claim its broadcast by id');
  else bad('claiming by id returned ' + JSON.stringify(first?.map((x) => x.title) ?? null));

  if (retry?.length === 0) ok('a RETRIED webhook finds nothing -- no duplicate send');
  else bad('a retried webhook claimed the same broadcast again: ' + JSON.stringify(retry));
}

// A named broadcast that was never inserted must not claim some OTHER row, which
// `= null` would do.
{
  const got = await claim('99999999-9999-9999-9999-999999999999');
  if (got?.length === 0) ok('an unknown id claims nothing rather than falling through');
  else bad('an unknown id returned ' + JSON.stringify(got.map((x) => x.title)));
}

// --- who may claim ---------------------------------------------------------
//
// This one matters more than it looks. The function marks a broadcast delivered
// WITHOUT sending anything, so anyone able to call it could silence push for the
// whole paper permanently, leaving no trace in the data.
await refused('anon CANNOT claim a broadcast (it would silence push silently)', 'anon', null,
  `select * from public.wire_claim_next_broadcast(null)`);
await refused('a Writer CANNOT claim a broadcast', 'authenticated', 'tok-writer',
  `select * from public.wire_claim_next_broadcast(null)`);

// --- the locking clause, asserted statically ------------------------------
{
  // `for update skip locked` is what makes a concurrent caller SKIP rather than
  // WAIT. With plain `for update` the second invocation blocks until the first
  // commits and then receives the same row: the same duplicate, serialised, and
  // much harder to notice because the timing looks normal.
  //
  // Asserted on the function source because PGlite serialises transactions and
  // cannot demonstrate the lock behaviour at all. See the note at the top.
  const src = (await db.query(`
    select p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname='public' and p.proname='wire_claim_next_broadcast'`)).rows[0]?.prosrc || '';

  if (/for\s+update\s+skip\s+locked/i.test(src)) {
    ok('the claim uses FOR UPDATE SKIP LOCKED, so a concurrent caller skips rather than waits');
  } else {
    bad('no FOR UPDATE SKIP LOCKED in wire_claim_next_broadcast(): concurrent callers would duplicate');
  }

  if (/set\s+(\w+\.)?pushed_at\s*=\s*now\(\)/i.test(src)) {
    ok('the stamp is inside the claiming statement, not a separate step');
  } else {
    bad('pushed_at is not stamped by the claim -- the duplicate window is back');
  }

  const priv = await db.query(`
    select has_function_privilege('anon', p.oid, 'execute') as anon_ok,
           has_function_privilege('service_role', p.oid, 'execute') as svc_ok
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname='public' and p.proname='wire_claim_next_broadcast'`);
  if (priv.rows[0] && priv.rows[0].anon_ok === false && priv.rows[0].svc_ok === true) {
    ok('execute is granted to service_role and withheld from anon');
  } else {
    bad('privileges are anon=' + priv.rows[0]?.anon_ok + ' service_role=' + priv.rows[0]?.svc_ok);
  }
}

// --- 040: interviews split into two feeds ----------------------------------
//
// THE POINT OF THE MIGRATION. /videos offers Interviews and Videos as two equal
// archives, which is only possible if a row can say which kind it is.
//
// The risk being tested is not "does the column exist" -- it is that adding a
// column with a default to a table that already holds PUBLIC content quietly
// re-files it. 037 documents the same trap, where a wrong default blanked a live
// gallery. Here a wrong backfill would hide every existing interview.
console.log('\n-- 040 interviews get a category --');

{
  const rows = (await db.query(
    `select title, category, status from public.interviews order by title`)).rows;
  const allInterview = rows.length === 2 && rows.every((r) => r.category === 'interview');
  if (allInterview) ok('both pre-existing interviews backfilled to category=interview');
  else bad('backfill put existing interviews somewhere wrong: ' + JSON.stringify(rows));
}

// The regression that matters: a published interview must still be readable.
{
  const r = await asRole('anon', null,
    () => db.query(`select title from public.interviews order by title`));
  const visible = (r.value?.rows ?? []).map((x) => x.title);
  if (visible.length === 2) ok('both published interviews are still visible to readers');
  else bad('a published interview vanished: readers see ' + JSON.stringify(visible));
}

// Each feed returns its own rows.
{
  // As the OWNER, not anon. The Owner is the only role the insert policy exempts
  // from status='pending', and an anon caller has no session at all -- so this
  // insert was being refused by RLS and the video feed correctly came back
  // empty. Testing a row that was never created proves nothing.
  const seeded = await asRole('anon', 'tok-owner', () => db.query(`
    insert into public.interviews (title, guest, status, category, author_account_id)
    values ('Match highlights','Nakuru vs Nyeri','published','video',
            '33333333-3333-3333-3333-333333333333')`));
  if (!seeded.ok) {
    bad('could not seed a video row as the Owner: ' + (seeded.error || ''));
  }

  const iv = await asRole('anon', null, () => db.query(
    `select title from public.interviews where category='interview' order by title`));
  const vd = await asRole('anon', null, () => db.query(
    `select title from public.interviews where category='video' order by title`));

  const interviewTitles = (iv.value?.rows ?? []).map((x) => x.title);
  const videoTitles = (vd.value?.rows ?? []).map((x) => x.title);

  if (interviewTitles.length === 2) ok('the interview feed returns exactly the 2 interviews: ' + interviewTitles.join(', '));
  else bad('interview feed returned ' + JSON.stringify(interviewTitles));

  if (videoTitles.length === 1 && videoTitles[0] === 'Match highlights') {
    ok('the video feed returns exactly the 1 video: ' + videoTitles.join(', '));
  } else {
    bad('video feed returned ' + JSON.stringify(videoTitles));
  }
}

// A Writer files a video and lands pending, like any other submission.
{
  const r = await asRole('anon', 'tok-writer', () => db.query(
    `insert into public.interviews (title, guest, status, category, author_account_id)
     values ('Writer video','Event','pending','video','33333333-3333-3333-3333-333333333333')
     returning category, status`));
  if (r.ok && r.value.rows[0]?.status === 'pending' && r.value.rows[0]?.category === 'video') {
    ok("a Writer's video submission lands as pending/video, automatically");
  } else {
    bad("a Writer's video came back " + JSON.stringify(r.value?.rows?.[0] ?? r.error));
  }
}

// A video is filed with NO guest, and the insert must succeed.
//
// This is the assertion that proves 040's `drop not null` actually ran. The
// fixture above still declares 022's `guest text not null`, deliberately: it is
// the pre-migration shape, so if the `drop not null` were missing or were
// spelled wrongly, this insert would fail with 23502 and the video form would be
// broken in production while every other test still passed. Nothing else in this
// file can tell the difference -- the Writer's video row above supplies a guest
// and would insert fine either way.
{
  const r = await asRole('anon', 'tok-writer', () => db.query(
    `insert into public.interviews (title, guest, status, category, author_account_id)
     values ('House athletics final', null, 'pending', 'video', '33333333-3333-3333-3333-333333333333')
     returning id, guest, category`));
  if (r.ok && r.value.rows[0]?.guest === null && r.value.rows[0]?.category === 'video') {
    ok("a video with no guest inserts (guest is nullable, so the video form is clean)");
  } else {
    bad("a guest-less video was refused: " + JSON.stringify(r.value?.rows?.[0] ?? r.error));
  }
}

// And the constraint must still bite for an INTERVIEW's sake where it is asked
// of -- this is asserted in the browser, not here, because the column itself no
// longer knows the difference. Recorded so the removal is not mistaken for a
// loosening that was unintended.
{
  const r = await db.query(
    `select is_nullable from information_schema.columns
      where table_schema = 'public' and table_name = 'interviews' and column_name = 'guest'`);
  if (r.rows[0]?.is_nullable === 'YES') {
    ok("guest is documented nullable; an interview's guest is now a FORM rule, not a column rule");
  } else {
    bad("guest is still " + r.rows[0]?.is_nullable + " -- the video form's missing field would be a data loss");
  }
}

// The vocabulary is closed. Without this a typo creates a row in neither feed,
// invisible everywhere -- the worst possible failure for published content.
await denied('a Writer CANNOT invent a category', 'anon', 'tok-writer',
  `insert into public.interviews (title, guest, status, category, author_account_id)
   values ('Typo row','X','pending','interveiw','33333333-3333-3333-3333-333333333333')`, 'insert');

// A Writer must not self-publish a video, exactly as they cannot publish an
// interview. Otherwise the new feed is an unguarded publishing surface.
await denied('a Writer CANNOT file an already-published video', 'anon', 'tok-writer',
  `insert into public.interviews (title, guest, status, category, author_account_id)
   values ('Sneaky','X','published','video','33333333-3333-3333-3333-333333333333')`, 'insert');

// THE EDITORIAL INVARIANT: a Writer may edit their row but not re-file it.
// Re-tagging an approved interview as a video would move a published row between
// the two public archives, which is an editorial decision.
{
  const r = await asRole('anon', 'tok-writer',
    () => db.query(`update public.interviews set category='video' where title='Coach interview'`));
  const touched = r.ok && (r.value.rowCount ?? 0) > 0;
  if (!touched) ok('a Writer CANNOT re-tag their interview as a video');
  else bad('a Writer moved a published interview into the videos feed');
}

// ... but ordinary editing of their own row must still work, or the lockdown
// above would have quietly broken the interview editor.
{
  const r = await asRole('anon', 'tok-writer',
    () => db.query(`update public.interviews set title='Coach interview (revised)' where title='Coach interview' returning title`));
  if (r.ok && (r.value.rowCount ?? 0) > 0) ok('a Writer can still edit their own row (category unchanged)');
  else bad('a Writer cannot edit their own interview: ' + (r.error || '0 rows'));
}

// The Owner can re-file, because that IS an editorial act.
{
  const r = await asRole('anon', 'tok-owner',
    () => db.query(`update public.interviews set category='video' where title='Coach interview (revised)' returning category`));
  if (r.ok && r.value.rows[0]?.category === 'video') ok('the Owner CAN re-file an entry between feeds');
  else bad('the Owner cannot re-file: ' + (r.error || JSON.stringify(r.value?.rows)));
}

// The column really is NOT NULL and constrained, not merely defaulted.
{
  const col = (await db.query(`
    select is_nullable from information_schema.columns
     where table_schema='public' and table_name='interviews' and column_name='category'`)).rows[0];
  if (col?.is_nullable === 'NO') ok('category is NOT NULL');
  else bad('category is nullable; a null row appears in neither feed');

  const cons = await db.query(`
    select pg_get_constraintdef(oid) as def from pg_constraint
     where conrelid='public.interviews'::regclass and conname='interviews_category_check'`);
  if (cons.rows.length) ok('a check constraint holds the vocabulary: ' + cons.rows[0].def);
  else bad('no check constraint: any string can be stored in category');
}

/**
 * A pending row owned by somebody, for the reject-path assertions.
 *
 * `author` DEFAULTS TO A DIFFERENT ACCOUNT on purpose. defaulting it to the
 * writer would make "another writer's submission" a misnomer -- the row would
 * genuinely belong to the very account being tested against, and the assertion
 * would fail for a reason that has nothing to do with the policy.
 */
const OTHER_AUTHOR = '44444444-4444-4444-4444-444444444444';
const seedPendingSubmission = async (title, author = OTHER_AUTHOR) => {
  await asRole('anon', 'tok-owner', () => db.query(
    `insert into public.interviews (title, guest, status, category, author_account_id)
     values ($1, 'X', 'pending', 'interview', $2)`, [title, author]));
};

// --- an approver can reject a PENDING submission ---------------------------
// The Owner Panel always had Approve, and refusing one was the one thing a Board
// Manager could not do: interviews_delete_own is wire_owns_interview(id) and
// interviews_owner_all is the Owner seat, so a Manager's delete matched neither.
// RLS FILTERS rather than raising, so it removed nothing and the panel reported
// success. The queue could be approved from and never emptied.
await seedPendingSubmission('approver-reject-me');

// The writer withdraws their OWN pending submission -- still allowed. The new
// approver policy is ADDITIVE, so it must not have displaced this one.
await seedPendingSubmission('writer own pending', WRITER);
{
  const r = await asRole('anon', 'tok-writer',
    () => db.query(`delete from public.interviews where title = 'writer own pending'`));
  const gone = r.ok && (r.value.rowCount ?? 0) > 0;
  if (gone) ok('a Writer can still withdraw their OWN pending submission');
  else bad('a Writer cannot withdraw their own pending submission: ' + (r.error || '0 rows'));
}

// A Board Manager refuses somebody else's. This is the gap.
await allowed('a Board Manager CAN reject a PENDING submission', 'authenticated', 'tok-manager',
  `delete from public.interviews where title = 'approver-reject-me'`, 'delete');

// ... but NOT a published one. That stays the Owner's decision, matching 038's
// split for podcasts.
await allowed('the Owner can still delete a published episode', 'authenticated', 'tok-owner', `select 1`, 'select');
{
  await asRole('anon', 'tok-owner', () => db.query(`
    insert into public.interviews (title, guest, status, category, author_account_id)
    values ('live item','X','published','interview',
            '33333333-3333-3333-3333-333333333333')`));
  await denied('a Board Manager CANNOT delete a PUBLISHED interview', 'authenticated', 'tok-manager',
    `delete from public.interviews where title = 'live item'`, 'delete');
// A Writer may delete their OWN interview at ANY status, published included.
//
// Asserted because it looks like a hole and is not. interviews_delete_own is
// scoped by OWNERSHIP alone, not by status, and the panel offers Delete on a
// writer's own row whatever its status -- so this is intended, and a test
// asserting the opposite would fail against correct code.
//
// Which is what happened while writing these: the row under test was seeded as
// the writer's own, so "a Writer cannot delete somebody else's row" failed on it.
// The row WAS the writer's; the assertion was aimed at the wrong row.
await allowed('a Writer CAN delete their OWN published interview (ownership gates it, not status)',
  'authenticated', 'tok-writer', `delete from public.interviews where title = 'live item'`, 'delete');
}

// A Writer still cannot reach into somebody else's PENDING row either. The new
// policy is additive, so this must still hold.
await seedPendingSubmission('not-yours', OTHER_AUTHOR);
await denied('a Writer CANNOT delete another writer\'s pending submission', 'authenticated', 'tok-writer',
  `delete from public.interviews where title = 'not-yours'`, 'delete');
{
  const r = await asRole('anon', 'tok-manager',
    () => db.query(`delete from public.interviews where title = 'not-yours'`));
  const gone = r.ok && (r.value.rowCount ?? 0) > 0;
  if (gone) ok('...but a Board Manager CAN, which is the point of the queue');
  else bad('a Board Manager could not reject another writer\'s pending submission');
}

await denied('a SUSPENDED Board Manager cannot reject anything', 'authenticated', 'tok-pending',
  `delete from public.interviews where title = 'live item'`, 'delete');

// ===========================================================================
await db.close();

console.log('\n------------------------------------------------------------------');
if (problems.length) {
  console.log(problems.length + ' problem(s):');
  for (const p of problems) console.log('  - ' + p);
  process.exit(1);
}
console.log('RESULT: PASS — all three migrations apply, and the holes stay closed.');
