/* ==============================================================================
   tests/bylines.mjs — byline portraits, image fallbacks, status preservation
   ------------------------------------------------------------------------------
   Runs in bare Node against the REAL modules and the REAL source files, so a
   refactor that breaks one of these guarantees fails here instead of quietly on
   a reader's phone.

   Three shipped defects live behind the assertions below:

     • renderByline() called ITSELF instead of bylineSticker(), so the first
       story card painted on the site raised a stack overflow and the whole
       publication was blank.

     • bylineSticker() took no `portrait`, so the foreign-key lookup the
       publication had already performed was thrown away and every byline fell
       back to matching on name -- the path that lets one staffer's typo print
       somebody else's face next to a story.

     • Editing an approved account's role called wire_approve_account(), which
       writes status='active' and restamps approved_at. A suspended account
       re-activated itself the moment the Owner edited its role. The staff
       editor had the same shape of bug from the other side: `status` was read
       off a <select> that reports '' for any value it does not list, and that
       '' was saved straight back over the stored status.

   Run:  node tests/bylines.mjs
   ========================================================================== */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* --------------------------------------------------------------------------
   Demo mode persists to localStorage, which does not exist in bare Node.
   Same stub tests/curation.mjs uses, so the store's write path is exercised
   rather than skipped.
   ------------------------------------------------------------------------ */
if (!globalThis.localStorage) {
  const backing = new Map();
  globalThis.localStorage = {
    getItem: (key) => (backing.has(key) ? backing.get(key) : null),
    setItem: (key, value) => backing.set(key, String(value)),
    removeItem: (key) => backing.delete(key),
    clear: () => backing.clear()
  };
}

const credits = await import('../src/lib/credits.js');

const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const publicSrc = read('src/views/public.js');
const adminSrc = read('src/views/admin.js');
const creditsSrc = read('src/lib/credits.js');
const authSrc = read('src/lib/auth.js');

let pass = 0;
let fail = 0;
const failures = [];

function report(label, ok, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`  PASS  ${label}`);
  } else {
    fail += 1;
    failures.push(`${label}${detail ? `\n        ${detail}` : ''}`);
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`);
  }
}

const count = (haystack, needle) => haystack.split(needle).length - 1;

/** Pull a named function/arrow body out of a source file. */
function bodyOf(src, signature) {
  const start = src.indexOf(signature);
  if (start === -1) return '';
  // Skip the parameter list before looking for the body: a default such as
  // `opts = {}` opens a brace that is not the function body.
  const paren = src.indexOf('(', start);
  const params = balanced(src, paren);
  if (params === null) return '';
  const open = src.indexOf('{', paren + params.length);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return '';
}

/** Read a balanced (...) / [...] / {...} span, or null when it never closes. */
function balanced(text, start) {
  if (start < 0 || !'{(['.includes(text[start])) return null;
  const close = { '(': ')', '[': ']', '{': '}' }[text[start]];
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    if ('{(['.includes(text[i])) depth += 1;
    else if ('})]'.includes(text[i])) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

console.log('\npublic.js — one byline path, and it does not call itself\n');

const renderByline = bodyOf(publicSrc, 'function renderByline(');

report('renderByline exists', Boolean(renderByline));
report(
  'renderByline delegates to bylineSticker, not to itself',
  /return\s+bylineSticker\(/.test(renderByline) && !/return\s+renderByline\(/.test(renderByline),
  'a self-call here is a stack overflow on the first painted card'
);
report(
  'renderByline credits the byline NAME, never the account pointer',
  /bylineSticker\(\s*article\?\.author/.test(renderByline) &&
    !/authorAccountId|portraitForArticle/.test(renderByline),
  'author_account_id is who may edit the row, not who wrote it: resolving a face from it printed the Owner beside a reporter byline'
);
report(
  'public.js does not import portraitForArticle at all',
  !/portraitForArticle/.test(publicSrc),
  'the foreign-key portrait path was removed; the name is the only key'
);
report(
  'public.js still imports bylineSticker',
  /import\s*\{[^}]*\bbylineSticker\b[^}]*\}\s*from\s*'\.\.\/lib\/credits\.js'/.test(publicSrc)
);

/* Every renderer that used to reach for bylineSticker directly. A card, the
   Weekly slot, Today's Pick, the modal and BOTH search strips. */
const bylineCallSites = [
  ['the latest-grid card', /articleCard[\s\S]*?renderByline\(article,/],
  ["Today's Pick", /renderTodaysPick[\s\S]*?renderByline\(todaysPick,/],
  ['the weekly slot', /renderWeeklySlot[\s\S]*?renderByline\(item,/],
  ['the article modal', /openArticle[\s\S]*?renderByline\(article,/],
  ['the search strip (empty query)', /runSearch[\s\S]*?renderByline\(article, \{/]
];
for (const [label, re] of bylineCallSites) {
  report(`${label} renders its byline through renderByline`, re.test(publicSrc));
}
report(
  'no call site is left calling bylineSticker directly',
  count(publicSrc, 'bylineSticker(') === 1,
  `expected the single call inside renderByline, found ${count(publicSrc, 'bylineSticker(')}`
);
report(
  'no duplicated byline line survives in the weekly slot',
  !/\}\s*\n\s*\$\{(?:render)?[bB]yline\(/.test(publicSrc),
  'a second byline in the same card renders the byline twice'
);

console.log('\ncredits.js — the portrait the caller resolved is the one that prints\n');

const withPortrait = credits.bylineSticker('Grace Wanjiku', {
  portrait: 'https://cdn.test/grace.jpg'
});
report(
  'an explicit portrait is rendered even when the name index is empty',
  withPortrait.includes('src="https://cdn.test/grace.jpg"') &&
    withPortrait.includes('byline-sticker-name'),
  'without this the resolved foreign-key portrait is thrown away and the byline falls back to the name'
);
report(
  'an unsafe portrait URL is refused rather than rendered',
  !credits
    .bylineSticker('Grace Wanjiku', { portrait: 'javascript:alert(1)' })
    .includes('src="javascript')
);
report(
  'no portrait at all still renders the plain text byline',
  credits.bylineSticker('Grace Wanjiku').includes('By Grace Wanjiku')
);
report(
  'the sticker image falls back on a broken URL',
  /<img[\s\S]*?imageFallbackAttr\(\)/.test(creditsSrc)
);
report(
  'the fallback disarms itself, so a dead image cannot loop',
  /this\.onerror=null;/.test(read('src/lib/dom.js'))
);

console.log('\ncredits.js — only APPROVED portraits reach a byline\n');

credits.indexStaffPortraits([
  { name: 'Grace Wanjiku', portrait_url: 'https://cdn.test/ok.jpg', portrait_status: 'approved' },
  { name: 'Pending Person', portrait_url: 'https://cdn.test/new.jpg', portrait_status: 'pending' },
  { name: 'Rejected Person', portrait_url: 'https://cdn.test/bad.jpg', portrait_status: 'rejected' },
  { name: 'Unreviewed Person', portrait_url: 'https://cdn.test/none.jpg' }
]);

report(
  'an approved portrait resolves',
  credits.portraitFor('Grace Wanjiku') === 'https://cdn.test/ok.jpg'
);
report(
  'a portrait still awaiting the Owner review never reaches a byline',
  credits.portraitFor('Pending Person') === null,
  'this is the whole point of the review gate'
);
report(
  'a rejected portrait never reaches a byline',
  credits.portraitFor('Rejected Person') === null
);
report(
  'a portrait with no review state never reaches a byline',
  credits.portraitFor('Unreviewed Person') === null
);
report(
  'a byline nobody has a profile for resolves to nothing',
  credits.portraitForArticle({ author: 'Nobody At All' }) === null
);

console.log('\none byline, one face — and never the account operator\n');

/* THE BUG THIS EXISTS FOR
   -----------------------
   Portrait lookup went through `articles.author_account_id`, which migration 007
   defines as "the account the author signs in with" -- a PERMISSIONS pointer.
   The Owner posting a piece credited to a reporter is ordinary practice, so three
   articles bylined "Mercy Kamande" showed HER profile (they pointed at her
   account) and a fourth showed the OWNER's (it pointed there). One byline, two
   avatars: the inconsistency that started this. */
const STAFF_FACE = 'https://cdn.test/staff-grace.jpg';
const CREDITS_FACE = 'https://cdn.test/credits-grace.jpg';

credits.indexStaffPortraits([
  { name: 'Grace Wanjiku', portrait_url: STAFF_FACE, portrait_status: 'approved' },
  { name: 'Chief Owner', portrait_url: 'https://cdn.test/chief-owner.jpg', portrait_status: 'approved' }
]);
credits.indexPortraits([
  { name: 'Grace Wanjiku', portrait_url: CREDITS_FACE },
  { name: 'Amara K.', portrait_url: 'https://cdn.test/amara.jpg' }
]);

report(
  'the account pointer is ignored entirely: one byline, one face',
  credits.portraitForArticle({ author: 'Grace Wanjiku', authorAccountId: 'acct-mercy' }) ===
    credits.portraitForArticle({ author: 'Grace Wanjiku', authorAccountId: 'acct-owner' }) &&
    credits.portraitForArticle({ author: 'Grace Wanjiku', authorAccountId: 'acct-mercy' }) ===
      STAFF_FACE,
  'resolving a face from author_account_id is what printed two different people under one byline'
);
report(
  'the removed lookup cannot be reached from the module at all',
  typeof credits.portraitForAccountId === 'undefined' &&
    !/portraitIndexById/.test(read('src/lib/credits.js')),
  'a dead export invites the next person to wire it back up'
);
report(
  'the staff profile outranks the Credits page for a name both carry',
  credits.portraitFor('Grace Wanjiku') === STAFF_FACE,
  'the Credits roster is the fallback for contributors, not the authority on staff'
);
report(
  'the Credits roster still answers for a contributor with no staff profile',
  credits.portraitFor('Amara K.') === 'https://cdn.test/amara.jpg'
);

/* Loading one roster must not be able to un-answer the other: the two used to
   share a single map, so whichever page loaded last decided every byline. */
credits.indexPortraits([{ name: 'Amara K.', portrait_url: 'https://cdn.test/amara.jpg' }]);
report(
  'reloading the Credits roster does not drop a staff portrait',
  credits.portraitFor('Grace Wanjiku') === STAFF_FACE,
  'one shared map means the answer depends on which page loaded last'
);

/* A shared surname must resolve to nobody rather than to the wrong person. */
credits.indexStaffPortraits([
  { name: 'Amara K.', portrait_url: 'https://cdn.test/amara-k.jpg', portrait_status: 'approved' },
  { name: 'Amara Z.', portrait_url: 'https://cdn.test/amara-z.jpg', portrait_status: 'approved' }
]);
report(
  'an ambiguous bare surname resolves to nobody, not to the wrong staffer',
  credits.portraitFor('Amara') === null
);
report(
  'the same ambiguous roster still resolves each full name exactly',
  credits.portraitFor('Amara K.') === 'https://cdn.test/amara-k.jpg' &&
    credits.portraitFor('Amara Z.') === 'https://cdn.test/amara-z.jpg'
);

// Put a known roster back for the assertions below.
credits.indexStaffPortraits([
  { name: 'Grace Wanjiku', portrait_url: STAFF_FACE, portrait_status: 'approved' }
]);
credits.indexPortraits([]);

console.log('\nadmin.js — the Staff tab feeds the foreign-key index\n');

report(
  'admin.js imports indexStaffPortraits',
  /import\s*\{[^}]*\bindexStaffPortraits\b[^}]*\}\s*from\s*'\.\.\/lib\/credits\.js'/.test(adminSrc)
);
report(
  'the Staff tab primes it',
  /function\s+renderStaffTab\(\)[\s\S]*?primeStaffPortraits\(/.test(adminSrc)
);
report(
  'the Staff tab indexes the roster without touching the account list',
  /function\s+renderStaffTab\(\)[\s\S]*?primeStaffPortraits\(/.test(adminSrc) &&
    /indexStaffPortraits\(/.test(adminSrc) &&
    !/accountIdByUsername/.test(adminSrc),
  'the staff-to-account join only existed to key portraits by author_account_id, which points at whoever operated the CMS'
);
report(
  "the Staff tab passes each staffer's name, not just a url",
  /name: member\.name,/.test(adminSrc),
  'indexStaffPortraits keys by name; without it the staff roster indexes nothing'
);

console.log('\nrendered images — a dead URL must not leave a broken icon\n');

for (const [file, src] of [
  ['public.js', publicSrc],
  ['admin.js', adminSrc],
  ['credits.js', creditsSrc]
]) {
  const images = count(src, '<img');
  const guarded = count(src, '${imageFallbackAttr(');
  report(
    `${file}: all ${images} rendered <img> carry a fallback`,
    images > 0 && images === guarded,
    `${guarded} guarded, ${images} rendered`
  );
}

console.log('\nsaving details must not overwrite a status\n');

const saveStaff = bodyOf(adminSrc, 'async function saveStaffFromForm(');
report(
  'the staff payload does not hard-code status from the dropdown',
  !/status:\s*byId\('staff-status'\)\.value/.test(saveStaff),
  'a <select> reports \'\' for a value it does not list, and \'\' was saved over the status'
);
report(
  'the staff save only writes a status the dropdown can represent',
  /normaliseStaffStatus\(byId\('staff-status'\)\.value\)/.test(saveStaff) &&
    /if \(chosenStatus\) payload\.status = chosenStatus;/.test(saveStaff)
);
report(
  'an unrecognised stored status is not re-written',
  /function\s+normaliseStaffStatus\(value\)[\s\S]*?\|\| ''/.test(adminSrc)
);
report(
  'the editor pre-selects only a representable status',
  /normaliseStaffStatus\(member\?\.status\)/.test(adminSrc)
);

const roleHandler = bodyOf(adminSrc, 'if (target instanceof HTMLSelectElement && target.dataset.accountSaved)');
report(
  'editing an approved role does not call the approval RPC',
  !/approveAccount\(/.test(roleHandler) && /setAccountRole\(/.test(roleHandler),
  'approveAccount writes status and approved_at; a role edit has no business doing that'
);
report(
  'admin.js imports setAccountRole',
  /import\s*\{[^}]*\bsetAccountRole\b[^}]*\}\s*from\s*'\.\.\/lib\/auth\.js'/.test(adminSrc)
);
report(
  'auth.js exposes setAccountRole as a distinct call',
  /export\s+async\s+function\s+setAccountRole\(/.test(authSrc) &&
    /wire_set_account_role/.test(authSrc)
);

/* The SQL is the boundary that actually protects the status, so assert the
   UPDATE itself rather than trusting the client's intent. Comments are stripped
   first: the note explaining what is deliberately absent would otherwise read
   as a violation of its own rule. */
const migration = read('supabase/024_set_account_role.sql');
const stripSqlComments = (sql) => sql.replace(/--[^\n]*/g, '');
const updateStart = migration.indexOf('update public.staff_accounts');
const accountUpdate = stripSqlComments(
  migration.slice(updateStart, migration.indexOf('where id = p_id', updateStart))
);
report(
  'the new RPC writes role and nothing else on staff_accounts',
  /update\s+public\.staff_accounts\s+set\s+role\s*=/.test(accountUpdate) &&
    !/status|approved_at|is_owner/.test(accountUpdate),
  'a column named in this UPDATE is a column an edit can still overwrite'
);
const mirrorStart = migration.indexOf('update public.staff');
const staffMirror = stripSqlComments(
  migration.slice(mirrorStart, migration.indexOf('where username = v_user', mirrorStart))
);
report(
  'the staff mirror touches role only, so a suspension survives an edit',
  /update\s+public\.staff\s+set\s+role\s*=\s*v_stored/.test(staffMirror)
);

/* 42883: function min(uuid) does not exist.
   Postgres ships no min()/max() aggregate for uuid, so an aggregate applied
   straight to an id column aborts the statement. Migration 007's backfill raised
   42883 on its first run and linked nothing. Nothing about that is visible until
   a query is pasted, so it is asserted here instead. */
const sqlFiles = [
  'supabase/007_article_ownership.sql',
  'supabase/024_set_account_role.sql',
  'supabase/025_backfill_article_ownership.sql',
  'supabase/026_repair_article_attribution.sql',
  'supabase/027_restore_article_ownership.sql'
];
for (const file of sqlFiles) {
  const live = stripSqlComments(read(file));
  const bare = live.match(/\b(?:min|max)\s*\(\s*[A-Za-z0-9_.]*\bid\b\s*\)/gi) || [];
  report(
    `${file}: no min()/max() applied straight to a uuid column`,
    bare.length === 0,
    bare.length ? `cast it: min(id::text)::uuid -- ${bare.join(', ')}` : ''
  );
}
report(
  'the repaired 007 backfill casts before aggregating',
  /min\(id::text\)::uuid/.test(read('supabase/007_article_ownership.sql'))
);

/* 42501: only the Owner can reassign an article.
   articles_reassign_guard_trg raises on ANY change to author_account_id unless
   is_owner(), and is_owner() resolves a bearer token the SQL Editor never sends
   -- so it is false there. Any migration that writes the column has to stand the
   guard down and put it back, or it aborts on the first row. */
for (const file of [
  'supabase/025_backfill_article_ownership.sql',
  'supabase/026_repair_article_attribution.sql',
  'supabase/027_restore_article_ownership.sql'
]) {
  const live = stripSqlComments(read(file));
  const writesColumn = /update public\.articles/.test(live);
  if (!writesColumn) continue;
  report(
    `${file}: stands the reassignment guard down before writing`,
    live.indexOf('disable trigger articles_reassign_guard_trg') > -1 &&
      live.indexOf('disable trigger articles_reassign_guard_trg') <
        live.indexOf('update public.articles'),
    'without this it raises 42501 on the first row'
  );
  report(
    `${file}: re-enables the guard, and a failure cannot leave it off`,
    live.indexOf('enable trigger articles_reassign_guard_trg') >
      live.indexOf('update public.articles') &&
      /exception when others then[\s\S]*?raise;/.test(live)
  );
}

/* THE ERROR, ASSERTED SO IT CANNOT COME BACK
   -----------------------------------------
   025 inferred articles.author_account_id from the byline. 026 then "repaired"
   025's output by clearing links whose byline disagreed with the account, and
   destroyed a correct one: the Owner had posted a piece bylined "Mercy Kamande"
   while signed in as the Owner.

   Both were wrong because articles.author_account_id is a PERMISSIONS pointer --
   migration 007: "the account the author signs in with", and the column comment
   says NULL means only the Owner may delete the row -- while articles.author is
   a byline credit. They describe different things, so a byline is no evidence
   about who owns a row. Getting it wrong decides who can delete a story.

   A byline may name anybody. The Owner posting a reporter's piece is the normal
   case on a single-desk paper. */
const backfill = read('supabase/025_backfill_article_ownership.sql');
const repair = read('supabase/026_repair_article_attribution.sql');
const restore = read('supabase/027_restore_article_ownership.sql');

report(
  '007 says in so many words what the column is, and the tests quote it',
  /points at staff_accounts\.id - the account the/.test(read('supabase/007_article_ownership.sql')),
  'this sentence is the whole reason the byline cannot be used to infer ownership'
);
report(
  'the 007 column comment names it as an ownership/permissions marker',
  /NULL means ownership unknown/.test(read('supabase/007_article_ownership.sql'))
);
report(
  '025 is marked superseded and warns against inferring ownership from a byline',
  /SUPERSEDED/.test(backfill) && /027_restore_article_ownership\.sql/.test(backfill),
  '025 already ran here; the next person to read it must not run it on a fresh database'
);
report(
  '026 is marked superseded and records that it cleared a correct link',
  /SUPERSEDED/.test(repair) &&
    /cleared one link that was CORRECT/i.test(repair) &&
    /027_restore_article_ownership\.sql/.test(repair),
  'a repair script that destroyed correct data must say so at the top, not be quietly reusable'
);
report(
  '026 records WHY it was wrong: byline and account are different things',
  /PERMISSIONS pointer/.test(repair) && /SIGNS IN WITH/.test(repair)
);
report(
  '027 restores only rows that are currently NULL',
  /where id = v_article\s*\n\s*and author_account_id is null/.test(stripSqlComments(restore)),
  'this must never overwrite an attribution that is already correct'
);
report(
  '027 takes both ids from the Owner rather than inferring them',
  /v_article uuid := 'PASTE-THE-ARTICLE-UUID-HERE'/.test(restore) &&
    /v_owner   uuid := 'PASTE-THE-OWNER-ACCOUNT-UUID-HERE'/.test(restore) &&
    /Fill in both UUIDs/.test(restore),
  'no table anywhere records the creating account for an article, so this cannot be automated'
);
report(
  '027 refuses to run with the placeholders still in place',
  /raise exception 'Fill in both UUIDs/.test(stripSqlComments(restore))
);
report(
  '027 says a byline that disagrees with its owner is the correct state',
  /byline_matches_account/.test(restore) && /EXPECTED TO BE FALSE/.test(restore),
  'this is the assertion that stops 026 being run a second time'
);
report(
  '027 finds the Owner account with a read-only query rather than assuming',
  /select id, username, display_name, is_owner/.test(restore) &&
    /where is_owner/.test(restore)
);

/* A `create table if not exists` is a no-op against a live table, so every
   `unique` declared inside one has to be treated as unproven. Both of these
   tables are keyed by username, and wire_login resolves an account by username,
   so a duplicate there is a login bug and not merely untidy. */
const schema = read('supabase/schema.sql');
const credentials = read('supabase/credentials.sql');
report(
  'the duplicate-username diagnostic is still offered',
  /group by username\s*\n?\s*having count\(\*\) > 1/.test(stripSqlComments(repair)),
  'wire_login resolves an account BY username, so a clash is a login bug too'
);
report(
  'the diagnostic reports whether username is actually unique',
  /username_is_unique/.test(repair)
);
report(
  'adding the missing unique constraints is left to the Owner, not run here',
  /^--\s*alter table public\.staff_accounts$/m.test(repair) &&
    /^--\s*add constraint staff_accounts_username_key unique \(username\);$/m.test(repair) &&
    /^--\s*alter table public\.staff$/m.test(repair),
  'a migration that picks a winner among duplicate accounts repeats the bug'
);
report(
  'the table declarations that lost their constraint are the ones in question',
  /create table if not exists public\.staff_accounts/.test(credentials) &&
    /create table if not exists public\.staff\b/.test(schema) &&
    /username\s+text\s+not null unique/.test(credentials) &&
    /username\s+text\s+not null unique/.test(schema),
  'if these stop matching, re-check whether the constraint is real or only declared'
);


console.log(`\n${pass} passed, ${fail} failed`);

if (fail) {
  console.log(`\n${fail} FAILED:\n`);
  for (const f of failures) console.log(`  - ${f}`);
  console.log('');
  process.exit(1);
}

console.log('RESULT: PASS — bylines, image fallbacks and status preservation are intact.\n');
