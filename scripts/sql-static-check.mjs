/**
 * Static validator for the SQL in this repo.
 *
 *   node scripts/sql-static-check.mjs
 *
 * WHY THIS EXISTS
 * ---------------
 * Migration 033 failed to apply three times, in three different ways, and each
 * one cost a round trip to a live database to discover:
 *
 *     42883  can_approve() does not exist            -- a reference to a function
 *                                                       no file declares, from a
 *                                                       migration that had not
 *                                                       been applied
 *     42P13  trigger functions cannot have args      -- a declaration that is
 *                                                       illegal for `returns trigger`
 *     42883  wire_approver_scope_guard(text)         -- a reference to a
 *                                                       signature that no longer
 *                                                       matches its own declaration
 *
 * All three are decidable by reading the file. None is visible to a regex over the
 * source, and none is visible to the client test suite, because the client never
 * executes SQL. So the invariants are checked here.
 *
 * THIS IS NOT A SQL PARSER. It checks the specific failure modes that produce
 * run-time errors, and it says plainly at the end what it cannot check, so the
 * gap is visible rather than assumed away.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

const files = [];
for (const dir of ['supabase', 'supabase/migrations']) {
  for (const name of readdirSync(path.join(ROOT, dir))) {
    if (name.endsWith('.sql')) files.push(path.join(dir, name));
  }
}

let problems = 0;
let warnings = 0;
let checked = 0;

const fail = (file, msg) => {
  problems += 1;
  console.log(`  FAIL ${file}\n         ${msg}`);
};
const warn = (file, msg) => {
  warnings += 1;
  console.log(`  WARN ${file}\n         ${msg}`);
};

/* ------------------------------------------------------------------------ */
/* Reduction: comments, literals and dollar bodies, removed correctly       */
/* ------------------------------------------------------------------------ */

/**
 * Reduce SQL to what a structural check should look at, in ONE pass.
 *
 * WHY A SCANNER AND NOT THREE REGEX REPLACES
 * -----------------------------------------
 * Each obvious ordering is wrong in a way these files actually contain:
 *
 *   comments first -> 031 carries
 *                      'a foreign key into media_assets -- it is a URL like
 *                       audio_url, and requiring a '
 *                      The `--` is INSIDE a literal. Treating it as a comment
 *                      deletes that literal's closing quote, mispairs every quote
 *                      after it, and reports the file unbalanced when it has
 *                      applied perfectly well.
 *
 *   strings first  -> 030's header comment contains `status = 'active'`, and
 *                      those quotes sit inside a `--` comment. Treating them as a
 *                      literal pairs them with a quote far below and blanks out
 *                      `begin;` and the function declaration entirely.
 *
 * So neither order works. This walks the text once and tracks which of the three
 * constructs it is inside. It is longer than either regex, and it is the only
 * version that is correct on this repo -- both wrong orderings produced false
 * alarms on migrations that work.
 *
 * @param {string} raw
 * @returns {string}
 */
function reduce(raw) {
  let out = '';
  let i = 0;
  const n = raw.length;

  while (i < n) {
    const ch = raw[i];

    // -- line comment
    if (ch === '-' && raw[i + 1] === '-') {
      while (i < n && raw[i] !== '\n') i += 1;
      continue;
    }

    // /* block comment */
    if (ch === '/' && raw[i + 1] === '*') {
      const close = raw.indexOf('*/', i + 2);
      i = close === -1 ? n : close + 2;
      continue;
    }

    // $tag$ ... $tag$ dollar-quoted body
    if (ch === '$') {
      const tag = /^\$[a-z_]*\$/i.exec(raw.slice(i));
      if (tag) {
        const close = raw.indexOf(tag[0], i + tag[0].length);
        i = close === -1 ? n : close + tag[0].length;
        out += ' BODY ';
        continue;
      }
    }

    // 'string', where SQL escapes an apostrophe by doubling it
    if (ch === "'") {
      out += "''";
      i += 1;
      while (i < n) {
        if (raw[i] === "'") {
          if (raw[i + 1] === "'") {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }

    out += ch;
    i += 1;
  }

  return out;
}

/**
 * A function's identity is its argument TYPES.
 *
 * `default` belongs to the PARAMETER, not the function: `foo(text, uuid)` and
 * `foo(text default 'writer', uuid)` are the same function, and a
 * `drop function if exists foo(text, uuid)` legitimately names the second.
 *
 * Comparing the raw text instead flagged all five of the project's existing
 * `drop function` lines as 42883s, which they are not.
 *
 * @param {string} list
 * @returns {string}
 */
const types = (list) =>
  (list || '')
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean)
    .map((a) => a.split(/\bdefault\b/i)[0].trim().replace(/^\w+\s+/, ''))
    .map((a) => a.replace(/\s+/g, ' ').toLowerCase())
    .sort()
    .join(',');

/**
 * Names that are SQL builtins or Postgres internals rather than project
 * functions, so a call to one is not a missing migration.
 */
const BASE = new Set([
  'current_account_id',
  'is_owner',
  'is_staff',
  'wire_bearer_token',
  'wire_owns_article',
  'wire_owns_interview',
  'gen_random_uuid',
  'now',
  'coalesce',
  'nullif',
  'lower',
  'upper',
  'trim',
  'btrim',
  'ltrim',
  'left',
  'right',
  'length',
  'char_length',
  'regexp_replace',
  'to_jsonb',
  'set_config',
  'format_type',
  'format',
  'md5',
  'version',
  'pg_typeof'
]);

/* ------------------------------------------------------------------------ */
/* Which migrations are still PENDING                                        */
/* ------------------------------------------------------------------------ */

/**
 * The migrations a database still needs, read from the CHANGELOG's own Pending
 * list rather than a list kept here.
 *
 * This decides the SEVERITY of every finding, which is what stops the checker
 * being noise. A missing `drop policy` in a migration that has already been
 * applied to every database can never bite again; the same mistake in one that
 * is about to be pasted into the SQL Editor is the whole reason this file exists.
 * Reporting both as FAIL trains people to ignore the output, so historical files
 * WARN and pending files FAIL.
 *
 * @returns {Set<string>} basename of each pending migration, e.g. '033_writer_lockdown.sql'
 */
function pendingMigrations() {
  const out = new Set();
  let changelog;
  try {
    changelog = readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
  } catch {
    console.log('  (no CHANGELOG.md: treating every migration as pending)');
    return new Set(files.map((f) => path.basename(f)));
  }
  const from = changelog.indexOf('### Pending');
  const to = changelog.indexOf('### Added', from + 1);
  const section = from === -1 ? '' : changelog.slice(from, to === -1 ? undefined : to);
  for (const m of section.matchAll(/migrations\/(\w+\.sql)/g)) out.add(m[1]);
  return out;
}

const PENDING = pendingMigrations();
const isPending = (file) => PENDING.has(path.basename(file));

/** Fail for a migration about to be applied; warn for one already applied. */
const report = (file, msg) => (isPending(file) ? fail(file, msg) : warn(file, msg));

/* ------------------------------------------------------------------------ */
/* Reduction of every file, once                                            */
/* ------------------------------------------------------------------------ */

const RAW = new Map();
const CODE = new Map();

for (const file of files) {
  const raw = readFileSync(file, 'utf8');
  RAW.set(file, raw);
  CODE.set(file, reduce(raw));
}

/** Every function name declared anywhere in the repo. */
const DECLARED_GLOBALLY = new Set();
for (const code of CODE.values()) {
  for (const m of code.matchAll(/create (?:or replace )?function (?:public\.)?(\w+)/g)) {
    DECLARED_GLOBALLY.add(m[1]);
  }
}

/* ------------------------------------------------------------------------ */
/* The checks                                                               */
/* ------------------------------------------------------------------------ */

for (const file of files) {
  const raw = RAW.get(file);
  const code = CODE.get(file);

  // 1. Dollar-quote balance -------------------------------------------------
  const dollars = raw.split('$$').length - 1;
  if (dollars % 2 !== 0) {
    report(file, `unbalanced $$ delimiters (${dollars})`);
  }
  checked += 1;

  // 2. Parenthesis balance -------------------------------------------------
  let depth = 0;
  let worst = 0;
  for (const ch of code) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (depth < 0) worst = depth;
  }
  if (depth !== 0 || worst < 0) {
    report(file, `parentheses unbalanced (net ${depth}, went to ${worst})`);
  }
  checked += 1;

  // 3. A trigger function may not declare arguments -- 42P13 ----------------
  for (const m of code.matchAll(
    /create (?:or replace )?function (?:public\.)?(\w+)\s*\(([^)]*)\)\s*\nreturns trigger/g
  )) {
    checked += 1;
    if (m[2].trim() !== '') {
      report(file, `${m[1]} is a trigger function but declares (${m[2].trim()}) -- 42P13`);
    }
  }

  // 4. A trigger is never attached with an argument list -------------------
  for (const m of code.matchAll(/execute function (?:public\.)?(\w+)\s*\(([^)]*)\)/g)) {
    checked += 1;
    if (m[2].trim() !== '') {
      report(file, `trigger attached as ${m[1]}(${m[2].trim()}) -- 42P13`);
    }
  }

  // 5. A reference must match a signature declared in the SAME file --------
  //    Dropping "in the same file" would hide the 42883 that started this: the
  //    target existed in the repo the whole time, in a migration that had not
  //    been applied.
  const declaredHere = new Map();
  for (const m of code.matchAll(
    /create (?:or replace )?function (?:public\.)?(\w+)\s*\(([^)]*)\)/g
  )) {
    declaredHere.set(m[1], types(m[2]));
  }

  const REF =
    /(?:comment on function|revoke [a-z ]*|grant [a-z ]*|execute function)\s+(?:on function\s+)?(?:public\.)?(\w+)\s*\(([^)]*)\)/g;
  for (const m of code.matchAll(REF)) {
    const [, name, args] = m;
    if (BASE.has(name)) continue;
    if (!declaredHere.has(name)) continue;
    checked += 1;
    if (types(args) !== declaredHere.get(name)) {
      report(
        file,
        `reference to ${name}(${types(args)}) but this file declares ` +
          `${name}(${declaredHere.get(name)}) -- 42883`
      );
    }
  }

// 6. A PENDING migration must be SELF-CONTAINED ----------------------------
  //    This is the original failure: 033 called can_approve(), which only 030
  //    declares, and 030 had not been applied to the target database.
  //
  //    Asking about the WHOLE REPO, as an earlier version did, cannot catch it:
  //    `can_approve` was in the repository the entire time. The question has to be
  //    "does THIS file declare it", and that question is only fair for a file
  //    that is about to be applied -- a historical migration may legitimately
  //    reference an older one, 007 would fail it on a dozen functions, and a
  //    checker shouting forty false alarms about files nobody will re-run is a
  //    checker nobody reads.
  if (isPending(file)) {
    for (const m of code.matchAll(/(?:public\.)?(\w+)\s*\(\s*\)/g)) {
      const name = m[1];
      if (BASE.has(name)) continue;
      if (declaredHere.has(name)) continue;
      checked += 1;
      report(
        file,
        `${name}() is called, and this migration is PENDING, but it declares ` +
          `${name}() nowhere -- so it depends on an earlier migration having been applied first`
      );
    }
  }

  // 7. No duplicate declaration of one signature in one file ---------------
  const seen = new Set();
  for (const m of code.matchAll(
    /create (?:or replace )?function (?:public\.)?(\w+)\s*\(([^)]*)\)/g
  )) {
    const key = `${m[1]}(${types(m[2])})`;
    checked += 1;
    if (seen.has(key)) report(file, `${key} is declared twice -- an ambiguous overload`);
    seen.add(key);
  }

  // 7. Every create trigger / policy is preceded by its drop --------------
  for (const m of code.matchAll(/create trigger (\w+) on ([\w.]+)/g)) {
    checked += 1;
    const table = m[2].split('.').pop();
    if (!new RegExp(`drop trigger if exists ${m[1]} on ${table}`).test(code)) {
      report(file, `trigger ${m[1]} has no preceding drop, so it cannot be re-run`);
    }
  }
  for (const m of code.matchAll(/create policy (\w+) on ([\w.]+)/g)) {
    checked += 1;
    if (!new RegExp(`drop policy if exists ${m[1]} on ${m[2]}`).test(code)) {
      report(file, `policy ${m[1]} has no preceding drop, so it cannot be re-run`);
    }
  }

  // 8. Transaction pairing --------------------------------------------------
  const begins = (code.match(/^\s*begin;/gm) || []).length;
  const commits = (code.match(/^\s*commit;/gm) || []).length;
  checked += 1;
  // A begin without a commit is unusual but not necessarily wrong -- a
  // grant-only script may open one and leave the commit to the client. It is a
  // warning because this checker cannot tell intent from omission, and a false
  // failure on a working migration is the fastest way to get a validator ignored.
  if (begins !== commits) warn(file, `${begins} begin; against ${commits} commit;`);
  if (begins > 1) fail(file, `${begins} transactions in one file, so a re-run needs care`);
}

console.log(`\n${checked} checks across ${files.length} SQL files`);
console.log(
  problems ? `${problems} PROBLEM(S), ${warnings} warning(s)` : `OK - no decidable failure mode found (${warnings} warning(s))`
);
console.log(
  'NOT checked here: whether a referenced TABLE or COLUMN exists, and policy or predicate\n' +
    'SEMANTICS. Both need the live schema. A clean run means the file is well-formed, not\n' +
    'that it is correct.'
);
process.exit(problems ? 1 : 0);