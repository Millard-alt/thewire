/* =============================================================================
   scripts/policy-scope-check.mjs — RLS SCOPE vs THE PANEL'S ROLE GATES
   -----------------------------------------------------------------------------
   schema.sql created nine write policies gated on a bare `public.is_staff()`,
   which is true for any active account including a Writer. The Owner Panel gates
   nine tabs by role in the browser, so the database disagreed with the UI and
   every one of those gates was decorative: a Writer could insert a broadcast,
   rewrite the masthead, or edit the roster without the tab ever appearing.

   `audit_logs` was the worse case. `actor_name` was sent BY THE CLIENT
   (store.js sent `{ action, actor_name: actor }`), so any staff member could
   write a log line naming somebody else. Migration 035 replaces the insert
   policy with `wire_log_audit(text)`, which derives the actor from the session.

   This parses the SQL rather than running it, so it is a static guard: it
   catches a regression before it reaches the database. It cannot prove RLS
   semantics -- only the live database can.

   Run:  npm run test:policy-scope
   ========================================================================== */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const problems = [];
const ok = (m) => console.log('PASS  ' + m);
const bad = (m) => { problems.push(m); console.log('FAIL  ' + m); };

/**
 * Blank out SQL comments while PRESERVING line numbers, so a line index still
 * points at the right source line.
 *
 * This is not cosmetic. 034 opens with a comment block that quotes the old,
 * vulnerable `create policy wire_media_insert ...` lines verbatim as the "why",
 * and a naive `indexOf` finds THAT first and happily reports the world-writable
 * policy as still present.
 *
 * Tracks quote state so a `--` inside a string literal ('a--b') is not treated
 * as the start of a comment.
 */
function stripComments(src) {
  const out = src.split('');
  let inSingle = false;
  let inDouble = false;
  let inBlock = false;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    const next = src[i + 1];

    if (inBlock) {
      if (ch === '*' && next === '/') { out[i] = ' '; out[i + 1] = ' '; i++; inBlock = false; }
      else if (ch !== '\n') out[i] = ' ';
      continue;
    }
    if (inSingle || inDouble) {
      if (ch === inSingle ? "'" : inDouble ? '"' : '\\') inSingle = inSingle ? false : true;
      else if (ch === "'" && !inDouble) inSingle = false;
      else if (ch === '"' && !inSingle) inDouble = false;
      continue;
    }
    if (ch === "'") { inSingle = true; continue; }
    if (ch === '"') { inDouble = true; continue; }
    if (ch === '-' && next === '-') {
      while (i < src.length && src[i] !== '\n') { out[i] = ' '; i++; }
      i--;
      continue;
    }
    if (ch === '/' && next === '*') { out[i] = ' '; out[i + 1] = ' '; i++; inBlock = true; }
  }
  return out.join('');
}

/**
 * Application order, which is NOT alphabetical.
 *
 * Sorting the paths together puts `supabase/migrations/*` before
 * `supabase/schema.sql` (m < s), so a base definition would overwrite the
 * migration that replaced it and every fix would look like a no-op.
 *
 * The real order is the one DEPLOY.md documents: schema.sql, then
 * credentials.sql, then the older numbered base files, then migrations/.
 */
function numberedFirst(name) {
  const m = name.match(/^(\d+)/);
  return m ? [0, Number(m[1]), name] : [1, 0, name];
}

const files = [
  path.join('supabase', 'schema.sql'),
  path.join('supabase', 'credentials.sql'),
  ...readdirSync('supabase', { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.sql') && !/^(schema|credentials)\.sql$/.test(e.name))
    .map((e) => e.name)
    .sort((a, b) => {
      const [ka, na, sa] = numberedFirst(a);
      const [kb, nb, sb] = numberedFirst(b);
      return ka - kb || na - nb || sa.localeCompare(sb);
    })
    .map((n) => path.join('supabase', n)),
  ...readdirSync('supabase/migrations', { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.sql'))
    .map((e) => e.name)
    .sort((a, b) => {
      const [ka, na, sa] = numberedFirst(a);
      const [kb, nb, sb] = numberedFirst(b);
      return ka - kb || na - nb || sa.localeCompare(sb);
    })
    .map((n) => path.join('supabase/migrations', n))
];

/**
 * Extract the parenthesised expression that starts at `open`, honouring nesting.
 *
 * A non-greedy regex is not enough here: a real predicate looks like
 * `using (bucket_id = 'x' and public.is_staff() and coalesce((storage.foldername(name))[1], '') in (...))`
 * and `[\s\S]*?` stops at is_staff()'s own closing paren.
 */
function balanced(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return '';
}

/** policy name -> { qual, with_check, file, line } */
const policies = new Map();

for (const file of files) {
  const src = readFileSync(file, 'utf8');
  const lines = stripComments(src).split('\n');

  lines.forEach((line, idx) => {
    // A drop removes the earlier definition from consideration.
    const drop = line.match(/drop\s+policy\s+(?:if\s+exists\s+)?([a-z0-9_]+)/i);
    if (drop) {
      policies.delete(drop[1].toLowerCase());
      return;
    }

    const create = line.match(/create\s+policy\s+"?([a-z0-9_]+)"?\s+on\s+([a-z0-9_.]+)/i);
    if (!create) return;

    const name = create[1].toLowerCase();
    const table = create[2].toLowerCase();

    // Gather the body up to the terminating semicolon at depth 0.
    let body = '';
    let depth = 0;
    for (let i = idx; i < lines.length; i++) {
      for (const ch of lines[i]) {
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
      }
      body += ' ' + lines[i];
      if (depth === 0 && lines[i].includes(';')) break;
    }

    const uIdx = body.search(/using\s*\(/i);
    const wIdx = body.search(/with\s+check\s*\(/i);
    const qual = uIdx >= 0 ? balanced(body, body.indexOf('(', uIdx)).replace(/\s+/g, ' ').trim() : '';
    const withCheck = wIdx >= 0 ? balanced(body, body.indexOf('(', wIdx)).replace(/\s+/g, ' ').trim() : '';
    const cmd = (body.match(/\bfor\s+(select|insert|update|delete|all)\b/i) || [, 'all'])[1]
      .toLowerCase();

    policies.set(name, {
      name, table, cmd, qual, with_check: withCheck,
      file, line: idx + 1
    });
  });
}

// ---------------------------------------------------------------------------
//  1. No table may be writable on a bare is_staff() when the panel reserves it.
// ---------------------------------------------------------------------------

const RESERVED = [
  { table: 'public.site_settings', gate: 'OWNER',        expect: 'public.is_owner()' },
  { table: 'public.broadcasts',    gate: 'Board Manager', expect: 'public.can_manage()' },
  { table: 'public.assignments',   gate: 'Board Manager', expect: 'public.can_manage()' },
  { table: 'public.staff',         gate: 'Board Manager', expect: 'public.can_manage()' }
];

console.log('--- tables the panel reserves above Writer ---------------------');

for (const { table, gate, expect } of RESERVED) {
  const hits = [...policies.values()].filter(
    (p) => p.table === table && p.cmd !== 'select'
  );
  if (!hits.length) {
    bad(`${table}: no write policy found at all -- read the migration, this may be wrong`);
    continue;
  }
  const loose = hits.filter((p) => /is_staff\(\)/.test(p.qual) || /is_staff\(\)/.test(p.with_check));
  if (loose.length) {
    for (const p of loose) {
      bad(`${table} (${p.name}) is still gated on a bare is_staff(), panel requires ${gate}` +
          `  [${p.file}:${p.line}]`);
    }
  } else {
    const guards = hits.map((p) => `${p.name}=${p.with_check || p.qual}`).join(', ');
    ok(`${table} reserved for ${gate}, no bare is_staff()  (${guards})`);
  }
}

// ---------------------------------------------------------------------------
//  2. audit_logs: owner-only read, and no client write path at all.
// ---------------------------------------------------------------------------

console.log('\n--- audit_logs ------------------------------------------------');

{
  const hits = [...policies.values()].filter((p) => p.table === 'public.audit_logs');
  if (!hits.length) bad('no audit_logs policy found');

  const writePaths = hits.filter((p) => p.cmd === 'insert' || p.cmd === 'all');
  if (writePaths.length) {
    for (const p of writePaths) {
      bad(`audit_logs still has a client write path: ${p.name} (for ${p.cmd})` +
          `  [${p.file}:${p.line}]`);
    }
  } else {
    ok('audit_logs has no INSERT/ALL policy -- writes must go through wire_log_audit');
  }

  const reads = hits.filter((p) => p.cmd === 'select');
  const ownerOnly = reads.length === 1 && /is_owner\(\)/.test(reads[0].qual);
  if (ownerOnly) ok('audit_logs read is Owner-only');
  else if (!reads.length) bad('audit_logs has no SELECT policy (Owner could not read it)');
  else bad(`audit_logs read is not Owner-only: ${reads.map((r) => r.name + '=' + r.qual).join(', ')}`);
}

// ---------------------------------------------------------------------------
//  3. The RPC must exist, take exactly one argument, and not take an actor.
// ---------------------------------------------------------------------------

console.log('\n--- wire_log_audit ---------------------------------------------');

{
  // Comment-stripped: 035's header quotes the old is_staff() policies as the "why".
  const src = stripComments(readFileSync('supabase/migrations/035_staff_can_manage_and_server_side_audit.sql', 'utf8'));
  const fn = src.match(/create\s+or\s+replace\s+function\s+public\.wire_log_audit\s*\(([^)]*)\)/i);

  if (!fn) bad('public.wire_log_audit is not declared in 035');
  else {
    ok(`wire_log_audit is declared, signature: (${fn[1].trim()})`);
    if (/actor/i.test(fn[1])) {
      bad('wire_log_audit takes an actor parameter -- the actor must come from the session');
    } else {
      ok('wire_log_audit takes no actor parameter, so a caller cannot forge one');
    }
  }

  if (/security\s+definer/i.test(src)) ok('wire_log_audit is SECURITY DEFINER');
  else bad('wire_log_audit is not SECURITY DEFINER');

  if (/grant\s+execute\s+on\s+function\s+public\.wire_log_audit/i.test(src)) {
    ok('wire_log_audit is granted to anon, authenticated');
  } else bad('wire_log_audit is not granted to anon/authenticated -- every audit write would fail');

  // The actor must be resolved from the session inside the function body.
  const body = src.slice(src.indexOf('wire_log_audit', src.indexOf('create or replace')));
  if (/current_account_id\(\)/.test(body.slice(0, 3000))) {
    ok('the actor is derived from current_account_id()');
  } else bad('wire_log_audit does not resolve the actor from the session');
}

// ---------------------------------------------------------------------------
//  4. can_manage() must be Owner OR an ACTIVE Board Manager.
// ---------------------------------------------------------------------------

console.log('\n--- can_manage -------------------------------------------------');

{
  const src = stripComments(readFileSync('supabase/migrations/035_staff_can_manage_and_server_side_audit.sql', 'utf8'));
  const start = src.search(/create\s+or\s+replace\s+function\s+public\.can_manage/i);
  if (start < 0) bad('public.can_manage is not declared');
  else {
    const body = src.slice(start, start + 700);
    if (/is_owner\(\)/.test(body)) ok('can_manage includes the Owner seat');
    else bad('can_manage does not include the Owner');

    if (/role\s*=\s*'Board Manager'/.test(body)) ok("can_manage includes role = 'Board Manager'");
    else bad("can_manage does not name the 'Board Manager' role");

    if (/status\s*=\s*'active'/.test(body)) ok("can_manage requires status = 'active'");
    else bad('can_manage does not check for an ACTIVE account');

    // A pending Board Manager must not inherit the Owner's authority.
    if (/current_account_id\(\)/.test(body)) ok('can_manage resolves the session, not a passed-in id');
    else bad('can_manage does not resolve the session');
  }

  if (/grant\s+execute\s+on\s+function\s+public\.can_manage/i.test(src)) {
    ok('can_manage is granted to anon, authenticated');
  } else bad('can_manage is not granted to anon/authenticated -- its policies would deny everyone');
}

// ---------------------------------------------------------------------------
//  5. storage: every wire_media writer must require is_staff().
// ---------------------------------------------------------------------------

console.log('\n--- wire_media storage (migration 034) -------------------------');

{
  // Comment-stripped: 034's own header quotes the vulnerable policies verbatim.
  const src = stripComments(readFileSync('supabase/migrations/034_close_wire_media_storage_policies.sql', 'utf8'));
  const names = ['wire_media_insert', 'wire_media_update', 'wire_media_delete'];
  for (const n of names) {
    const idx = src.indexOf(`create policy ${n} on storage.objects`);
    if (idx < 0) { bad(`034 does not create ${n}`); continue; }
    const body = src.slice(idx, idx + 600);
    if (/public\.is_staff\(\)/.test(body)) ok(`${n} requires is_staff()`);
    else bad(`${n} does NOT require is_staff() -- the bucket is world-writable`);
  }

  // The root-level uploader must stay reachable, or gallery images break.
  if (/foldername\(name\)\)\[1\], ''\)\s*in\s*\(\s*'',\s*'portraits'\s*\)/.test(src)) {
    ok("the prefix test still admits the bucket ROOT (src/lib/upload.js writes there)");
  } else {
    bad("034 no longer admits the bucket root -- gallery/article uploads would break");
  }

  if (/lower\(name\)\s*~/.test(src) && /\(png\|jpe\?g\|webp\)/.test(src)) {
    ok('object names are restricted to png/jpg/jpeg/webp, so an .svg cannot land here');
  } else bad('034 does not restrict the object-name extension');

  if (/allowed_mime_types\s*=\s*array\[/.test(src)) ok('the bucket pins allowed_mime_types');
  else bad('034 does not set allowed_mime_types');

  if (/file_size_limit\s*=\s*5242880/.test(src)) ok('the bucket pins a 5 MB limit');
  else bad('034 does not set a 5 MB file_size_limit');
}

// ---------------------------------------------------------------------------

console.log('\n------------------------------------------------------------------');
// ---------------------------------------------------------------------------
//  6. The migration files themselves.
//
//  034 and 035 both failed against the live database before these checks
//  existed, so the failures are encoded here. Each one cost a round trip to a
//  production database, which is the most expensive place to find a typo.
// ---------------------------------------------------------------------------

console.log('\n--- migration PL/pgSQL syntax traps ----------------------------');

const migrationFiles = readdirSync('supabase/migrations', { withFileTypes: true })
  .filter((e) => e.isFile() && e.name.endsWith('.sql'))
  .map((e) => path.join('supabase/migrations', e.name));

const syntaxProblems = [];

for (const file of migrationFiles) {
  const lines = stripComments(readFileSync(file, 'utf8')).split('\n');

  lines.forEach((line, i) => {
    const next = (lines[i + 1] || '').trim();

    // (a) A PL/pgSQL block must close with END; -- the semicolon is required.
    // Bare END before the closing $$ is a syntax error. Caught 034 three times.
    if (/^\s*end\s*$/i.test(line) && /^\$\$\s*;?\s*$/i.test(next)) {
      syntaxProblems.push(`${file}:${i + 1} closes a DO block with a bare END (needs "end;")`);
    }

    // (b) IS NOT is not a text comparison operator. It is NULL / TRUE /
    // DISTINCT FROM. Comparing it to a literal is 42601. Caught in 035.
    if (/\bis\s+not\s+'/i.test(line)) {
      syntaxProblems.push(`${file}:${i + 1} uses "IS NOT '<literal>'" -- that is 42601, use <>`);
    }
  });
}

if (syntaxProblems.length) {
  for (const p of syntaxProblems) bad(p);
} else {
  ok('every DO block under supabase/migrations closes with "end;"');
  ok("no \"IS NOT '<literal>'\" comparison under supabase/migrations");
}

console.log('\n--- 034 verification block -------------------------------------');

{
  const src = stripComments(readFileSync('supabase/migrations/034_close_wire_media_storage_policies.sql', 'utf8'));

  // (c) Matching policy NAMES with LIKE and an underscore is a wildcard trap:
  // `wire_media%` also matches "wire media owner delete", which is exactly how
  // 034 failed on its first run.
  if (/policyname\s+like\s+'wire_media%'/i.test(src)) {
    bad("034 matches policyname LIKE 'wire_media%' -- `_` is a single-character wildcard and also matches spaces");
  } else {
    ok('034 does not pattern-match policy names with an underscore');
  }

  // (d) The sweep must skip SELECT. wire_media_read has no authorisation check
  // by design, because the bucket is public.
  if (/cmd\s+in\s*\(\s*'INSERT'\s*,\s*'UPDATE'\s*,\s*'DELETE'\s*,\s*'ALL'\s*\)/i.test(src)) {
    ok('034 restricts its sweep to write policies, so the public read policy cannot trip it');
  } else {
    bad('034 does not filter its sweep to write policies -- wire_media_read would be flagged as unguarded');
  }

  // (e) A stricter guard must satisfy the check. Demanding the literal string
  // `is_staff()` wrongly reports `is_owner()` as unguarded, which is backwards:
  // is_owner() satisfies everything is_staff() does.
  if (/not like '%is_owner%'/.test(src) && /not like '%can_manage%'/.test(src)) {
    ok('034 accepts is_staff(), is_owner() or can_manage() as an authorisation guard');
  } else {
    bad('034 only accepts is_staff(); a stricter guard such as is_owner() would be reported as unguarded');
  }

  // (f) The two legacy space-named policies from credentials.sql must be
  // retired, or they linger as dead `to authenticated` rules on a public bucket.
  for (const legacy of ['"wire media staff upload"', '"wire media owner delete"']) {
    if (src.includes(`drop policy if exists ${legacy}`)) ok(`034 drops the legacy policy ${legacy}`);
    else bad(`034 does not drop the legacy policy ${legacy} left behind by credentials.sql`);
  }
}

// ---------------------------------------------------------------------------
console.log('\n--- pg_policies column names ------------------------------------');

{
  // The real columns. `table_name` is the trap: it exists on
  // information_schema.columns / role_table_grants, which several migrations in
  // this repo query legitimately, so it is easy to carry over by accident.
  // pg_policies spells it `tablename`.
  const REAL = 'schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check';

  // Scoped to the migrations this audit added, NOT the whole repo. Earlier
  // migrations that read pg_policies sit next to information_schema queries
  // where table_name is correct, and a statement window cannot tell the two
  // apart -- a repo-wide version of this check flagged 022, 030 and 033, all of
  // which apply cleanly. Auditing those is a separate job.
  const MINE = migrationFiles.filter((f) => /0(34|35|36)_/.test(f));

  // Single-token near-misses only. `with check` is excluded because it is real
  // SQL inside a CREATE POLICY, not a column reference.
  const NOT_REAL = ['table_name', 'policy_name', 'schema_name', 'qualify', 'tableowner'];

  const offenders = [];
  let checked = 0;

  for (const file of MINE) {
    const lines = stripComments(readFileSync(file, 'utf8')).split('\n');
    const fromLines = lines
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => /\bfrom\s+pg_policies\b/i.test(l))
      .map(({ i }) => i);

    for (const from of fromLines) {
      let start = from;
      while (start >= 0 && !/^\s*select\b/i.test(lines[start])) start--;
      let end = from;
      while (end < lines.length && !/;\s*$/.test(lines[end])) end++;
      const window = lines.slice(Math.max(0, start), Math.min(lines.length, end + 1)).join('\n');
      checked++;

      for (const wrong of NOT_REAL) {
        if (new RegExp(`\\b${wrong}\\b`, 'i').test(window)) {
          offenders.push(`${file}: a pg_policies query uses "${wrong}" (real columns: ${REAL})`);
        }
      }
    }
  }

  if (offenders.length) {
    for (const o of offenders) bad(o);
  } else {
    ok(`all ${checked} pg_policies queries in 034/035/036 use real column names`);
  }
}

// ---------------------------------------------------------------------------
console.log('\n------------------------------------------------------------------');
if (problems.length) {
  console.log(`${problems.length} problem(s):`);
  for (const p of problems) console.log('  - ' + p);
  process.exit(1);
}
console.log('RESULT: PASS — policy scope matches the panel gates.');
console.log('Static only: this proves the SQL says the right thing. It cannot prove');
console.log('that RLS is enabled, or that the live database has these definitions.');