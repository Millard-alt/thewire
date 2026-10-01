import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Static consistency check between the client's role vocabulary and the SQL
 * migrations that persist it.
 *
 * WHY THIS EXISTS
 *   Two bugs in a row were invisible to every other test because both lived in
 *   this boundary, and both were plain string mismatches:
 *
 *     1. wire_request_account inserted 'Editor' while the CHECK allowed 'Writer'.
 *        Signup died with 23514 on every attempt.
 *     2. wire_approve_account did `v_role := lower(...)` then compared against
 *        the capitalised names, so 'Writer' arrived as 'writer' and approval
 *        died with 'Unknown role.'
 *
 *   Neither is reachable from tests/roles.mjs, which drives the demo-mode UI and
 *   never touches Postgres. So this reads both sides off disk and compares them.
 *   It cannot prove the deployed function body is current -- only re-pasting the
 *   migration can -- but it does prove the repo is self-consistent, which is what
 *   let bug 2 reach production in the first place.
 *
 * Run: node scripts/role-consistency.mjs
 */

const ROLES_SOURCE = 'src/lib/auth.js';
const SQL_DIR = 'supabase';

/** Mirrors ROLES in src/lib/auth.js; verified below rather than assumed. */
const CANONICAL = ['Owner', 'Writer', 'Board Manager'];

/**
 * Roles that must NOT be assigned to a stored column. 'Editor' is the pre-rename
 * name and is the exact value that caused bug 1.
 */
const FORBIDDEN_STORED = ['Editor', 'Reporter', 'Managing Editor', 'Photographer'];

let failures = 0;
const fail = (msg) => {
  failures += 1;
  console.log(`FAIL  ${msg}`);
};
const pass = (msg) => console.log(`ok    ${msg}`);

/* --- 1. the client's own list ------------------------------------------------ */

const authSrc = readFileSync(ROLES_SOURCE, 'utf8');
const rolesMatch = authSrc.match(/export const ROLES\s*=\s*\[([^\]]*)\]/);
if (!rolesMatch) {
  fail(`could not find "export const ROLES = [...]" in ${ROLES_SOURCE}`);
} else {
  const clientRoles = rolesMatch[1]
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);

  const same =
    clientRoles.length === CANONICAL.length &&
    CANONICAL.every((r) => clientRoles.includes(r));
  if (same) {
    pass(`${ROLES_SOURCE} ROLES matches [${CANONICAL.join(', ')}]`);
  } else {
    fail(
      `${ROLES_SOURCE} ROLES is [${clientRoles.join(', ')}] but the database ` +
        `contract is [${CANONICAL.join(', ')}]`
    );
  }
}

/* --- 2. the CHECK constraint in the SQL migrations ---------------------------- */

const sqlFiles = readdirSync(SQL_DIR)
  .filter((f) => f.endsWith('.sql'))
  .map((f) => join(SQL_DIR, f));

/**
 * Strip a trailing SQL comment from one line.
 *
 * `line.replace(/--.*$/, '')` does NOT work on CRLF files. `.` excludes `\r` and
 * `$` without the `m` flag anchors only at the very end of the string, so the
 * match never completes, the "comment" is left in place, and every rule below
 * fires on documentation instead of code. Matching the comment body with an
 * explicit character class is immune to the line ending.
 */
const stripComment = (line) => line.replace(/--[\s\S]*/, '');

// Every `check (role in (...))` listing in the repo. Superseded files are still
// scanned: re-running an old migration puts its CHECK back, so a stale one that
// omits a canonical role is a landmine rather than history.
const checkDefs = [];
for (const file of sqlFiles) {
  const src = readFileSync(file, 'utf8');
  const re = /check\s*\(\s*role\s+(?:in|= any\s*\(\s*array\[)\s*(\([^)]*\)|\[(?:[^\]]*)\])/gi;
  let m;
  while ((m = re.exec(src)) !== null) {
    const listed = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
    checkDefs.push({ file, listed, index: m.index });
  }
}

if (!checkDefs.length) {
  fail('found no role CHECK constraint in supabase/*.sql -- has it been renamed?');
} else {
  // Authoritative = the definition in the highest-sorting migration file.
  const sorted = checkDefs.slice().sort((a, b) => {
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    return b.index - a.index;
  });
  const authoritative = sorted[sorted.length - 1];

  const ok =
    authoritative.listed.length === CANONICAL.length &&
    CANONICAL.every((r) => authoritative.listed.includes(r));
  if (ok) {
    pass(`role CHECK in ${authoritative.file} accepts [${authoritative.listed.join(', ')}]`);
  } else {
    fail(
      `role CHECK in ${authoritative.file} is [${authoritative.listed.join(', ')}] ` +
        `but the client sends [${CANONICAL.join(', ')}] -- a signup would 23514`
    );
  }

  let staleOk = true;
  for (const def of checkDefs) {
    if (def === authoritative) continue;
    const missing = CANONICAL.filter((r) => !def.listed.includes(r));
    if (missing.length) {
      staleOk = false;
      fail(
        `${def.file} has a role CHECK missing [${missing.join(', ')}]. Re-running ` +
          `it would break signup -- mark the file SUPERSEDED.`
      );
    }
  }
  if (staleOk) pass('every other role CHECK in the repo also lists all three roles');
}

/* --- 3. no function body assigns a retired role to a stored column ------------- */

for (const file of sqlFiles) {
  const src = readFileSync(file, 'utf8');
  src.split('\n').forEach((line, i) => {
    const code = stripComment(line); // a comment is documentation, not code
    if (!code.trim()) return;

    for (const bad of FORBIDDEN_STORED) {
      const lit = new RegExp(`'${bad}'`, 'i');

      // (a) A role variable assigned a retired value: `v_role := 'Editor'`.
      //     This is bug 1. Note `:=` specifically -- a bare `=` would also match
      //     the harmless `if v_role = 'editor'` compatibility test.
      const assigns = /\b(v_[a-z_]*role)\s*:=\s*/i.exec(code);
      if (assigns && lit.test(code.slice(assigns.index + assigns[0].length))) {
        fail(
          `${file}:${i + 1} assigns the retired role '${bad}' to ${assigns[1]}, ` +
            `which is stored in staff_accounts.role: ${line.trim()}`
        );
        continue;
      }

      // (b) A retired value used as a column DEFAULT, e.g. `p_role default 'Editor'`.
      if (/\bdefault\s+/i.test(code) && lit.test(code)) {
        fail(
          `${file}:${i + 1} defaults a parameter to the retired role ` +
            `'${bad}': ${line.trim()}`
        );
        continue;
      }

      // (c) A retired value written straight into a row.
      if (/\b(insert\s+into|update)\b/i.test(code) && lit.test(code)) {
        fail(
          `${file}:${i + 1} writes the retired role '${bad}' into a stored ` +
            `column: ${line.trim()}`
        );
      }
    }
  });
}

/* --- 4. no case-folded role that is then compared to the canonical list ------- */

for (const file of sqlFiles) {
  const src = readFileSync(file, 'utf8');
  const lines = src.split('\n');
  lines.forEach((line, i) => {
    // Bug 2's exact shape: case-fold a role variable at declaration, then compare
    // that same variable against the capitalised canonical list.
    //
    // Matches `v_role text := lower(...)`. The `text` is the TYPE sitting between
    // the variable name and the assignment, so there is no colon before it --
    // an earlier version of this pattern looked for `:\s*text\s*:=`, which can
    // never match this line and so silently passed a file with the bug in it.
    if (!/\btext\s*:=\s*(lower|upper)\s*\(/i.test(line)) return;

    const varName = (line.match(/(v_[a-z_]*role)/i) || [])[1];
    if (!varName) return;

    const window = lines.slice(i, i + 30).join('\n');
    if (new RegExp(`${varName}\\s+not\\s+in\\s*\\([^)]*'Owner'`, 'i').test(window)) {
      fail(
        `${file}:${i + 1} case-folds ${varName} on the way in AND compares it ` +
          `against the capitalised list: ${line.trim()}. That is bug 2 -- ` +
          `'Writer' becomes 'writer' and approval raises 'Unknown role.'`
      );
    }
  });
}

console.log(
  failures
    ? `\n${failures} role-consistency problem(s) found.`
    : '\nRole vocabulary is consistent across client and SQL.'
);
process.exit(failures ? 1 : 0);

