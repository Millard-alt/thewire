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
  'renderByline resolves the portrait from the article foreign key',
  /portraitForArticle\(/.test(renderByline)
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
  { id: 'acct-approved', name: 'Grace Wanjiku', portrait_url: 'https://cdn.test/ok.jpg', portrait_status: 'approved' },
  { id: 'acct-pending', name: 'Pending Person', portrait_url: 'https://cdn.test/new.jpg', portrait_status: 'pending' },
  { id: 'acct-rejected', name: 'Rejected Person', portrait_url: 'https://cdn.test/bad.jpg', portrait_status: 'rejected' },
  { id: 'acct-none', name: 'Unreviewed Person', portrait_url: 'https://cdn.test/none.jpg' }
]);

report(
  'an approved portrait resolves by account id',
  credits.portraitForAccountId('acct-approved') === 'https://cdn.test/ok.jpg'
);
report(
  'a portrait still awaiting the Owner review never reaches a byline',
  credits.portraitForAccountId('acct-pending') === null,
  'this is the whole point of the review gate'
);
report(
  'a rejected portrait never reaches a byline',
  credits.portraitForAccountId('acct-rejected') === null
);
report(
  'a portrait with no review state never reaches a byline',
  credits.portraitForAccountId('acct-none') === null
);
report(
  'an article with an unknown account id falls back to its byline name',
  credits.portraitForArticle({ author: 'Nobody At All', authorAccountId: 'acct-missing' }) === null
);

console.log('\none person, one face — whichever way the byline resolves\n');

/* THE BUG THIS EXISTS FOR
   -----------------------
   A byline resolved two ways: by foreign key (from `staff`) or by name (from
   `credits_people`). Both were consulted, both answered, and they disagreed --
   so the same author wore a different photo on different cards depending on
   whether that article happened to carry an author_account_id. */
const STAFF_FACE = 'https://cdn.test/staff-grace.jpg';
const CREDITS_FACE = 'https://cdn.test/credits-grace.jpg';

credits.indexStaffPortraits([
  { id: 'acct-grace', name: 'Grace Wanjiku', portrait_url: STAFF_FACE, portrait_status: 'approved' }
]);
credits.indexPortraits([
  { name: 'Grace Wanjiku', portrait_url: CREDITS_FACE },
  { name: 'Amara K.', portrait_url: 'https://cdn.test/amara.jpg' }
]);

report(
  'a card WITH a foreign key and a card WITHOUT one show the same photo',
  credits.portraitForArticle({ author: 'Grace Wanjiku', authorAccountId: 'acct-grace' }) ===
    credits.portraitForArticle({ author: 'Grace Wanjiku', authorAccountId: null }),
  'the FK path and the name path disagreeing for one person is the reported symptom'
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
  { id: 'acct-a', name: 'Amara K.', portrait_url: 'https://cdn.test/amara-k.jpg', portrait_status: 'approved' },
  { id: 'acct-b', name: 'Amara Z.', portrait_url: 'https://cdn.test/amara-z.jpg', portrait_status: 'approved' }
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
  { id: 'acct-approved', name: 'Grace Wanjiku', portrait_url: STAFF_FACE, portrait_status: 'approved' }
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
  'the join is on username, the only column the two tables share',
  /accountIdByUsername\.get\(/.test(adminSrc) &&
    /indexStaffPortraits\(/.test(adminSrc)
);
report(
  "the join passes each staffer's NAME, not just the id",
  /name: member\.name,/.test(adminSrc),
  'indexStaffPortraits also builds the by-name index; without the name a byline with no author_account_id still resolves from the Credits roster and the two disagree again'
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

console.log(`\n${pass} passed, ${fail} failed`);

if (fail) {
  console.log(`\n${fail} FAILED:\n`);
  for (const f of failures) console.log(`  - ${f}`);
  console.log('');
  process.exit(1);
}

console.log('RESULT: PASS — bylines, image fallbacks and status preservation are intact.\n');
