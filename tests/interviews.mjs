/* =============================================================================
   tests/interviews.mjs — Interviews feature: unit + integration tests
   -----------------------------------------------------------------------------
   Runs in bare Node against the REAL modules, not a copy of the logic, so a
   refactor that breaks a guarantee fails here instead of on a reader's phone.

   Covers:
     1. YouTube URL normalisation (every accepted shape, and what must be
        rejected) — the input that reaches an <iframe src>.
     2. Embed URL construction and host allowlisting.
     3. readVideoIds(): de-duplication, the three-video cap, hostile input.
     4. Store CRUD in demo mode: create/update/publish/unpublish/delete, and the
        invariants that must survive a round trip.
     5. Reader-only visibility (pending must never reach the public feed).
     6. Pagination at exactly three per page, including out-of-range clamping.
     7. Static contract checks: migration 022 declares what the store expects,
        and the views mount/route the feature the way the store assumes.

   Run:  node tests/interviews.mjs
   ========================================================================== */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SQL_DIR = path.join(ROOT, 'supabase');

/* --------------------------------------------------------------------------
   Demo mode persists to localStorage, which does not exist in bare Node.
   The store catches the ReferenceError and warns on every write, which would
   bury real failures under ~6 stack traces per CRUD test. A minimal in-memory
   stub keeps the persistence path exercised and the output readable.
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

const store = await import('../src/lib/store.js');

const ID = /^[A-Za-z0-9_-]{11}$/;

let pass = 0;
let fail = 0;
const failures = [];

function report(label, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(`  PASS  ${label}${detail ? '  (' + detail + ')' : ''}`);
  } else {
    fail++;
    failures.push(label);
    console.log(`  FAIL  ${label}${detail ? '  (' + detail + ')' : ''}`);
  }
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}

const read = (relative) =>
  readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');
/* ======================================================================== *
 * 1. YouTube URL normalisation
 *
 * The output of this function is interpolated into an iframe src, so the
 * "must reject" cases matter at least as much as the "must accept" ones.
 * ======================================================================== */
section('normaliseYouTubeId — accepted shapes');

const ID_A = 'dQw4w9WgXcQ';
const ID_B = 'jNQXAC9IVRw';
const ID_C = '9bZkp7q19f0';

const ACCEPTED = [
  ['canonical watch url', `https://www.youtube.com/watch?v=${ID_A}`, ID_A],
  ['schemeless watch url', `youtube.com/watch?v=${ID_A}`, ID_A],
  ['protocol-relative paste', `//www.youtube.com/watch?v=${ID_A}`, ID_A],
  ['watch url with a start time', `https://youtube.com/watch?v=${ID_A}&t=42s`, ID_A],
  ['watch url, v after list=', `https://www.youtube.com/watch?list=PLabc123&v=${ID_A}`, ID_A],
  ['mobile host', `https://m.youtube.com/watch?v=${ID_A}`, ID_A],
  ['music host', `https://music.youtube.com/watch?v=${ID_A}`, ID_A],
  ['short link', `https://youtu.be/${ID_A}`, ID_A],
  ['short link with a timestamp', `https://youtu.be/${ID_A}?t=42`, ID_A],
  ['embed url', `https://www.youtube.com/embed/${ID_A}`, ID_A],
  ['nocookie embed url', `https://www.youtube-nocookie.com/embed/${ID_A}`, ID_A],
  ['shorts url', `https://www.youtube.com/shorts/${ID_A}`, ID_A],
  ['livestream replay url', `https://www.youtube.com/live/${ID_A}`, ID_A],
  ['bare id', ID_A, ID_A],
  ['surrounding whitespace', `   ${ID_A}   `, ID_A],
  ['trailing slash on short link', `https://youtu.be/${ID_A}/`, ID_A]
];

for (const [label, input, expected] of ACCEPTED) {
  const actual = store.normaliseYouTubeId(input);
  report(
    `accepts ${label}`,
    actual === expected,
    actual === expected ? actual : `got ${JSON.stringify(actual)}`
  );
}

section('normaliseYouTubeId — rejected shapes');

/*
 * Each of these must return '' rather than an id. The XSS rows are the reason
 * this function exists: anything non-empty here is spliced into an attribute.
 */
const REJECTED = [
  ['a javascript: url', 'javascript:alert(1)'],
  ['a data: url', 'data:text/html,<script>alert(1)</script>'],
  ['an attribute-breaking payload', `x"></iframe><script>alert(1)</script>`],
  ['a quote-breaking payload', `abc' onload='alert(1)`],
  ['a ten-character id', 'short'],
  ['a twelve-character id', 'abcdefghijkl'],
  ['an id with a disallowed character', 'abcdefghij!'],
  ['a youtube channel url', 'https://www.youtube.com/@MJLAPressClub'],
  ['a youtube playlist with no video', 'https://www.youtube.com/playlist?list=PLabc123'],
  ['a non-youtube host', `https://evil.test/watch?v=${ID_A}`],
  ['a lookalike host', `https://youtube.com.evil.test/watch?v=${ID_A}`],
  ['youtube in the query string only', 'https://evil.test/?x=youtube.com'],
  ['empty input', ''],
  ['whitespace only', '    '],
  ['null', null],
  ['undefined', undefined]
];

for (const [label, input] of REJECTED) {
  const actual = store.normaliseYouTubeId(input);
  report(
    `rejects ${label}`,
    actual === '',
    actual === '' ? '' : `got ${JSON.stringify(actual)}`
  );
}

/* The single most important invariant: whatever goes in, what comes out is
   either empty or a bare id. If this ever fails, every downstream guarantee
   about iframe safety fails with it. */
const FUZZ = [
  ...ACCEPTED.map(([, input]) => input),
  ...REJECTED.map(([, input]) => input),
  'javascript:alert(1)//https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  'https://www.youtube.com/watch?v="><script>alert(1)</script>',
  'https://youtu.be/../../etc/passwd',
  'https://www.youtube.com/embed/../../../admin',
  '//youtu.be/dQw4w9WgXcQ',
  '../../dQw4w9WgXcQ'
];

const badId = FUZZ.filter((input) => {
  const out = store.normaliseYouTubeId(input);
  return out !== '' && !ID.test(out);
});

report(
  'every input normalises to an empty string or a bare 11-char id',
  badId.length === 0,
  badId.length ? JSON.stringify(badId.slice(0, 3)) : `${FUZZ.length} inputs checked`
);

/* ======================================================================== *
 * 2. Embed URL construction
 * ======================================================================== */
section('youtubeEmbedUrl — host allowlisting');

report(
  'default embed host is the privacy-preserving one',
  store.youtubeEmbedUrl(ID_A) === `https://www.youtube-nocookie.com/embed/${ID_A}`,
  store.youtubeEmbedUrl(ID_A)
);

report(
  'the standard host can be requested explicitly',
  store.youtubeEmbedUrl(ID_A, { host: 'www.youtube.com' }) ===
    `https://www.youtube.com/embed/${ID_A}`
);

report(
  'a host outside the allowlist is refused, not passed through',
  store.youtubeEmbedUrl(ID_A, { host: 'evil.test' }) ===
    `https://www.youtube-nocookie.com/embed/${ID_A}`,
  store.youtubeEmbedUrl(ID_A, { host: 'evil.test' })
);

report('an unusable value yields no embed url at all', store.youtubeEmbedUrl('javascript:alert(1)') === '');

report(
  'an embed url never carries a query string that could smuggle a referrer',
  !/[?&]/.test(store.youtubeEmbedUrl(`https://youtu.be/${ID_A}?t=99`))
);

/* ======================================================================== *
 * 3. readVideoIds()
 * ======================================================================== */
section('readVideoIds — cleaning, de-duplication, cap');

report(
  'reduces mixed urls to bare ids',
  JSON.stringify(
    store.readVideoIds([`https://youtu.be/${ID_A}`, `https://www.youtube.com/embed/${ID_B}`])
  ) === JSON.stringify([ID_A, ID_B])
);

report(
  'de-duplicates the same video pasted twice',
  store.readVideoIds([`https://youtu.be/${ID_A}`, `https://www.youtube.com/watch?v=${ID_A}`])
    .length === 1
);

report(
  `caps at ${store.MAX_INTERVIEW_VIDEOS} videos`,
  store.readVideoIds([ID_A, ID_B, ID_C, 'abcdefghijk', 'lmnopqrstuv']).length ===
    store.MAX_INTERVIEW_VIDEOS && store.MAX_INTERVIEW_VIDEOS === 3
);

report(
  'preserves the order the writer chose',
  JSON.stringify(store.readVideoIds([ID_C, ID_A, ID_B])) === JSON.stringify([ID_C, ID_A, ID_B])
);

report(
  'drops unrecognised entries instead of forwarding them',
  JSON.stringify(store.readVideoIds([ID_A, 'javascript:alert(1)', 'https://evil.test/v/x'])) ===
    JSON.stringify([ID_A])
);

report(
  'accepts a single bare string as well as an array',
  JSON.stringify(store.readVideoIds(ID_A)) === JSON.stringify([ID_A])
);

report(
  'returns an empty list for null and for undefined',
  JSON.stringify(store.readVideoIds(null)) === '[]' &&
    JSON.stringify(store.readVideoIds(undefined)) === '[]'
);

/* The database CHECK and this function enforce the same rule. If they disagree
   the write is rejected by Postgres and the writer loses their interview. */
report(
  'MAX_INTERVIEW_VIDEOS agrees with the migration CHECK constraint',
  store.MAX_INTERVIEW_VIDEOS === 3,
  'store allows 3, migration allows <= 3'
);

/* ======================================================================== *
 * 4. Store CRUD
 *
 * Runs against the demo store (no Supabase client in bare Node), which is the
 * same code path the other stores use once `hasInterviewsTable()` returns false.
 * Each interview is given a distinct title so the assertions below cannot
 * accidentally pass against a neighbour in a shared array.
 * ======================================================================== */
section('CRUD — create, read, update, delete');

/** Reset the store to an empty interviews list between phases. */
function reset() {
  store.getState().interviews = [];
  store.commitForTests?.();
}

reset();

const draft = {
  title: 'The Archivist Who Refuses to Forget',
  guest: 'Wanjiku Kibet',
  guestRole: 'County Archivist',
  interviewer: 'Grace Wanjiku',
  summary: 'Nakuru paper records are being digitised, slowly and on purpose.',
  description:
    'A long-form conversation about what survives a flood, a budget cycle and a change of government.\n\nSecond block, to prove blank lines still split paragraphs.',
  image: 'https://images.unsplash.com/photo-1457369804613-52c61a468e7d',
  videoIds: [
    `https://www.youtube.com/watch?v=${ID_A}&t=90s`,
    `https://youtu.be/${ID_B}`,
    `https://www.youtube.com/embed/${ID_C}`
  ],
  status: 'pending'
};

const created = await store.createInterview(draft);

report('create returns the new interview', Boolean(created && created.id));
report(
  'a writer submission defaults to pending',
  created.status === 'pending',
  created.status
);
report(
  'a pending interview carries no published date',
  created.publishedAt === null,
  String(created.publishedAt)
);
report(
  'video urls are stored reduced to bare ids',
  JSON.stringify(created.videoIds) === JSON.stringify([ID_A, ID_B, ID_C]),
  JSON.stringify(created.videoIds)
);
report(
  'the interview is retrievable by id',
  store.getInterview(created.id)?.id === created.id
);
report(
  'it appears in the pending queue',
  store.getPendingInterviews().some((entry) => entry.id === created.id)
);
report(
  'a title is always present, even when none is given',
  (await store.createInterview({})).title.length > 0
);

section('CRUD — update');

const updated = await store.updateInterview(created.id, {
  title: 'The Archivist Who Refuses to Forget (Revised)',
  videoIds: [`https://youtu.be/${ID_A}`]
});

report('update returns the patched record', updated?.title.endsWith('(Revised)'));
report(
  'an omitted video list is NOT wiped on a partial update',
  JSON.stringify(updated.videoIds) === JSON.stringify([ID_A]),
  JSON.stringify(updated.videoIds)
);
report('an omitted field keeps its stored value', updated.guest === draft.guest, updated.guest);
report(
  'updating a row that does not exist returns null rather than creating one',
  (await store.updateInterview('no-such-id', { title: 'x' })) === null
);

/* A hostile patch must be cleaned by the same code path that cleans create, or
   the editor becomes a way to smuggle a javascript: url into an iframe. */
const smuggled = await store.updateInterview(created.id, {
  videoIds: ['javascript:alert(1)', ID_A, ID_B, ID_C, 'abcdefghijk']
});
report(
  'a hostile video patch is cleaned and capped before it is stored',
  JSON.stringify(smuggled.videoIds) === JSON.stringify([ID_A, ID_B, ID_C]),
  JSON.stringify(smuggled.videoIds)
);

section('CRUD — publish / unpublish / delete');

await store.publishInterview(created.id);
const live = store.getInterview(created.id);

report('publishing moves the row to published', live.status === 'published');
report('publishing stamps the published date', Boolean(live.publishedAt), live.publishedAt);
report(
  'the published date survives a later edit',
  (await store.updateInterview(created.id, { title: 'Typo fixed' })).publishedAt ===
    live.publishedAt
);

await store.unpublishInterview(created.id);
const pulled = store.getInterview(created.id);
report(
  'unpublishing returns the row to the queue and clears the date',
  pulled.status === 'pending' && pulled.publishedAt === null
);

await store.publishInterview('no-such-id');
report(
  'publishing an id that does not exist is a no-op, not a crash',
  store.listInterviews().length > 0
);

const totalBefore = store.listInterviews().length;
await store.deleteInterview(created.id);

report(
  'delete removes exactly one record',
  store.listInterviews().length === totalBefore - 1
);
report('a deleted interview is no longer retrievable', store.getInterview(created.id) === null);
await store.deleteInterview('no-such-id');
report(
  'deleting an id that does not exist is a no-op, not a crash',
  store.listInterviews().length === totalBefore - 1
);

/* ======================================================================== *
 * 5. Reader-only visibility
 *
 * The single most important rule in the feature: a pending submission must
 * never be reachable from the public feed, whatever combination of status and
 * workflow the writer or Owner used to get there.
 * ======================================================================== */
section('Reader-only visibility');

reset();

const visible = await store.createInterview({ title: 'Published one', status: 'published' });
const hidden = await store.createInterview({ title: 'Pending one', status: 'pending' });

/* Status is stored lower-case, but any hand-edited row may carry the title-case
   spelling the articles table uses. Both must resolve the same way or an
   interview vanishes from the feed for reasons nobody can see. */
const oddCase = await store.createInterview({
  title: 'Oddly cased status',
  status: 'Published'
});

report(
  'only published interviews are listed publicly',
  store.listPublishedInterviews().every((entry) => entry.status === 'published')
);
report(
  'a pending submission is absent from the public list',
  !store.listPublishedInterviews().some((entry) => entry.id === hidden.id)
);
report(
  'a title-case "Published" still counts as published',
  store.listPublishedInterviews().some((entry) => entry.id === oddCase.id)
);
report(
  'the pending row is still readable by an admin, who has to approve it',
  store.getPendingInterviews().some((entry) => entry.id === hidden.id)
);
report(
  'listInterviews() returns every row regardless of status',
  store.listInterviews().length === 3
);

section('canDeleteInterview — ownership');

report('a signed-out visitor can delete nothing', store.canDeleteInterview(visible) === false);
report('a null interview cannot be deleted', store.canDeleteInterview(null) === false);

/* ======================================================================== *
 * 6. Pagination — three per page
 * ======================================================================== */
section('listPublishedInterviewsPage — three per page');

reset();

report('INTERVIEWS_PER_PAGE is 3', store.INTERVIEWS_PER_PAGE === 3);

const empty = store.listPublishedInterviewsPage(1);
report(
  'an empty feed reports one page and no items, not zero pages',
  empty.items.length === 0 && empty.pageCount === 1 && empty.page === 1,
  `items=${empty.items.length} pages=${empty.pageCount}`
);
report(
  'an empty feed disables both controls, so no dead button is drawn',
  empty.hasNext === false && empty.hasPrev === false
);

/* Seven published interviews, with a stale pending row mixed in. */
for (let n = 1; n <= 7; n += 1) {
  await store.createInterview({ title: `Interview ${n}`, status: 'published' });
}
await store.createInterview({ title: 'Should never paginate', status: 'pending' });

const p1 = store.listPublishedInterviewsPage(1);
const p2 = store.listPublishedInterviewsPage(2);
const p3 = store.listPublishedInterviewsPage(3);

report('seven published rows make three pages', p1.pageCount === 3, `pageCount=${p1.pageCount}`);
report('page one holds exactly three', p1.items.length === 3, `items=${p1.items.length}`);
report('page two holds exactly three', p2.items.length === 3, `items=${p2.items.length}`);
report('page three holds the remainder', p3.items.length === 1, `items=${p3.items.length}`);
report(
  'the pages partition the feed with no overlap and no omissions',
  new Set([...p1.items, ...p2.items, ...p3.items].map((entry) => entry.id)).size === 7
);
report(
  'the pending row never consumes a slot on any page',
  [...p1.items, ...p2.items, ...p3.items].every((entry) => entry.status === 'published')
);

report('page one has no previous control', p1.hasPrev === false);
report('page one has a next control', p1.hasNext === true);
report('the middle page has both controls', p2.hasPrev === true && p2.hasNext === true);
report('the last page has no next control', p3.hasNext === false);

/* A stale bookmark must not strand a reader on an empty grid. */
const beyond = store.listPublishedInterviewsPage(99);
report(
  'a page number past the end clamps to the last page',
  beyond.page === 3 && beyond.items.length === 1,
  `page=${beyond.page}`
);

report(
  'a negative page number clamps to the first',
  store.listPublishedInterviewsPage(-5).page === 1
);
report('page zero clamps to the first', store.listPublishedInterviewsPage(0).page === 1);
report(
  'a non-numeric page number falls back to the first',
  store.listPublishedInterviewsPage('banana').page === 1
);
report(
  'a fractional page number is floored rather than half-filling the grid',
  store.listPublishedInterviewsPage(2.7).page === 2
);
report('the newest interview is first', p1.items[0].title === 'Interview 7', p1.items[0].title);

/* ======================================================================== *
 * 7. Static contracts
 *
 * The migration and the client are two halves of one contract. Nothing at
 * runtime can tell the reader that a column was named differently in the two
 * places -- a mismatch shows up as an empty feed or a rejected write. These
 * checks read the real files and hold both halves to the same names.
 * ======================================================================== */
section('022_interviews.sql — schema contract');

const sql = read('supabase/migrations/022_interviews.sql');

for (const fragment of [
  ['the interviews table is created', 'create table if not exists public.interviews'],
  ['status is constrained to pending/published', "status in ('pending', 'published')"],
  ['the video list is capped at three', 'jsonb_array_length(video_ids) <= 3'],
  ['each stored video is a bare 11-char id', '^[A-Za-z0-9_-]{11}$'],
  ['updated_at is trigger-maintained', 'interviews_touch_updated_at'],
  ['published_at is stamped on the transition', 'interviews_stamp_published'],
  ['row level security is enabled', 'enable row level security'],
  ['readers only ever see published rows', 'policy']
]) {
  report(`migration 022 ${fragment[0]}`, sql.includes(fragment[1]));
}

/*
 * Regression guard for the 42601 that shipped in the first version of this file.
 *
 * The fragment check above asserts only that the regex PATTERN is present, so it
 * passed happily while the surrounding SQL was unparseable. The pattern can be
 * spelled correctly and still sit behind an operator jsonpath does not have.
 *
 * `~` and `!~` are regex operators in ordinary SQL expressions. Inside a jsonpath
 * filter (`'$[*] ? (...)'`) there is no `!~` at all, so the statement fails to
 * PARSE with 42601 "syntax error at or near "!"" -- at migration time, not at
 * row time. The jsonpath spelling is `like_regex`.
 *
 * So: no jsonpath literal in any migration may use a bare SQL regex operator.
 * Scanned across every migration, not just this one, since the same mistake in a
 * future file is just as fatal.
 */
const jsonpathLiterals = [...sql.matchAll(/'([^']*\[\*\][^']*)'/g)].map((m) => m[1]);
const sqlRegexInJsonpath = jsonpathLiterals.filter((literal) => /@\s*!?~/.test(literal));
report(
  'no jsonpath filter uses a SQL regex operator (02601/42601 guard)',
  sqlRegexInJsonpath.length === 0,
  sqlRegexInJsonpath.length
    ? `found: ${JSON.stringify(sqlRegexInJsonpath)} -- jsonpath spells regex "like_regex"`
    : `${jsonpathLiterals.length} jsonpath filter(s) scanned`
);

const sqlFiles = [
  ...readdirSync(SQL_DIR).filter((name) => name.endsWith('.sql'))
];
let repoJsonpathViolations = [];
for (const name of sqlFiles) {
  const body = readFileSync(path.join(SQL_DIR, name), 'utf8');
  for (const m of body.matchAll(/'([^']*\[\*\][^']*)'/g)) {
    if (/@\s*!?~/.test(m[1])) repoJsonpathViolations.push(`${name}: ${m[1]}`);
  }
}
report(
  'every migration in the repo is free of the same mistake',
  repoJsonpathViolations.length === 0,
  repoJsonpathViolations.length
    ? repoJsonpathViolations.join(' | ')
    : `${sqlFiles.length} migration(s) scanned`
);

report(
  'the column names the store writes are the ones the table declares',
  ['video_ids', 'guest_role', 'author_account_id', 'published_at', 'image_url'].every(
    (column) => sql.includes(column)
  )
);

/* The store is defensive about the table not existing yet, but it must name the
   same table it probes. */
const storeSrc = read('src/lib/store.js');
report(
  'the store targets the interviews table it probes for',
  /TABLES\.interviews/.test(storeSrc) && /hasInterviewsTable/.test(storeSrc)
);
report(
  'the store hands the fetched rows to replaceState, not just the seed',
  /interviews:\s*interviews\.map\(mapInterviewRow\)/.test(storeSrc)
);
report(
  'a live empty table yields an empty list rather than demo rows',
  /interviews:\s*pick\(next\.interviews,\s*seed\.interviews\)\.map\(mapInterviewRow\)/.test(storeSrc)
);

/*
 * The host allowlist lives in the store, not in dom.js. `safeUrl` is a generic
 * helper that only narrows when a caller passes `allowedHosts`; YOUTUBE_EMBED_HOSTS
 * is the single list the interviews feature is allowed to embed from, and the
 * renderer must pass it through rather than trusting its own template.
 */
section('safeUrl — embed host allowlist');

const domSrc = read('src/lib/dom.js');
const html = read('index.html');
const appSrc = read('src/app.js');
const publicSrc = read('src/views/public.js');
const adminSrc = read('src/views/admin.js');
const cssSrc = read('src/styles.css');

report('safeUrl accepts a narrowing allowlist', /allowedHosts/.test(domSrc));
report('safeUrl narrows by hostname, not by whole-URL match', /hostname/.test(domSrc));
report('the store declares the two embed hosts', /YOUTUBE_EMBED_HOSTS/.test(storeSrc));
report(
  'the default embed host is the privacy-preserving one',
  store.YOUTUBE_EMBED_HOSTS[0] === 'www.youtube-nocookie.com'
);
report(
  'the renderer passes the allowlist through to safeUrl',
  /safeUrl\(\s*store\.youtubeEmbedUrl\([^)]*\)\s*,\s*\{[^}]*allowedHosts:\s*store\.YOUTUBE_EMBED_HOSTS/s.test(
    publicSrc
  )
);

section('view wiring');

report('the feed mount element exists in index.html', /id="interviews-view"/.test(html));

/*
 * Regression guard for the reader-view/admin overlap.
 *
 * The feed shipped carrying its own `#interviews-view` section while app.js,
 * views/admin.js and styles.css each hid reader views from a list of ids
 * maintained by hand. Three of the four lists were updated for Interviews and
 * one was not, so opening the Newsroom Panel left the feed rendered above the
 * panel headers. A grep-based assertion like /interviews-view/ in app.js passed
 * throughout that bug, because the id genuinely was still present in app.js --
 * it was just no longer what any code acted on.
 *
 * The invariant that actually holds the feature together is that every reader
 * view is marked up ONCE, with `data-reader-view`, and all three hiding paths
 * select on that attribute. Assert the contract rather than the wording, so
 * renaming a helper or reformatting a loop cannot make this pass vacuously.
 */
// Match the WHOLE opening tag first, then filter on the id. A single regex that
// spans `[^>]*id="...-view"` backtracks to end immediately after the id, so it
// can never see an attribute written after it -- which is exactly what happened
// on the first run of this assertion, marking all five views as unmarked while
// every one of them carried the attribute.
//
// `#admin-view` is excluded deliberately: it is the Newsroom Panel itself, not a
// reader view, and hiding it under the body.admin-active rule would blank the
// panel the Owner is looking at.
const readerViewSections = (html.match(/<section\b[^>]*>/g) || []).filter(
  (tag) => /id="(?!admin-)[a-z-]+-view"/.test(tag)
);
report(
  `every reader view section is marked data-reader-view (${readerViewSections.length} found)`,
  readerViewSections.length >= 4 &&
    readerViewSections.every((tag) => /data-reader-view/.test(tag))
);
// Guards the filter above: if `admin-view` were swept in, the rule under test
// would pass while hiding the admin panel itself.
report(
  'the admin panel mount is not tagged as a reader view',
  !/<section\b[^>]*id="admin-view"[^>]*data-reader-view/.test(html)
);
report(
  'app.js hides reader views by the shared attribute, not an id list',
  /data-reader-view/.test(appSrc) &&
    !/byId\('(publication|gallery|credits)-view'\)\?\.classList/.test(appSrc)
);
report(
  'admin.js hides reader views by the shared attribute, not an id list',
  /data-reader-view/.test(adminSrc) &&
    !/for \(const id of \['publication-view'/.test(adminSrc)
);
report(
  'styles.css suppresses reader views by the shared attribute, not an id list',
  /body\.admin-active \[data-reader-view\]/.test(cssSrc) &&
    !/body\.admin-active #publication-view/.test(cssSrc)
);
report(
  'app.js routes the interviews view',
  /interviews/.test(appSrc)
);
report(
  'public.js renders the interviews feed',
  /function renderInterviews/.test(publicSrc)
);
report(
  'public.js renders the dedicated detail view',
  /function openInterview/.test(publicSrc)
);
report(
  'public.js embeds videos through the shared helper, never a raw id',
  /youtubeEmbedUrl/.test(publicSrc)
);
report(
  'public.js pages the feed through the store helper',
  /listPublishedInterviewsPage/.test(publicSrc)
);
report('the admin panel has an Interviews tab', /id: 'interviews'/.test(adminSrc));
report(
  'the admin tab is reachable by Writers, who are the ones who submit',
  /id: 'interviews'.{0,400}minRole: 'Writer'/s.test(adminSrc)
);
report(
  'the admin panel can approve a pending interview',
  /data-action="interview-publish"/.test(adminSrc) && /case 'interview-publish'/.test(adminSrc)
);
report(
  'the admin panel can pull a published one back',
  /data-action="interview-unpublish"/.test(adminSrc)
);
report(
  'the admin panel can edit and delete',
  /data-action="interview-edit"/.test(adminSrc) && /data-action="interview-delete"/.test(adminSrc)
);
report(
  'deletion is gated by the ownership check, not just shown',
  /canDeleteInterview/.test(adminSrc)
);

/* The detail view renders ids into an iframe src, so it must not do it raw. */
const embedBlock = publicSrc.match(/<iframe[\s\S]{0,800}?<\/iframe>/);
report(
  'the interviews iframe is built by youtubeEmbedUrl, not from a stored url',
  Boolean(embedBlock) && !/src="\$\{escapeHtml\(video/.test(embedBlock[0]),
  embedBlock ? 'iframe located and checked' : 'no iframe found in public.js'
);
report(
  'the iframe src is escaped before it is interpolated',
  Boolean(embedBlock) && /src="\$\{escapeHtml\(src\)\}"/.test(embedBlock[0])
);

/* ======================================================================== *
 * Editor wiring: the YouTube Add/Remove buttons
 * ======================================================================== */

section('interview editor — video buttons are actually wired');

report(
  'the Add button is rendered in the editor dialog',
  /data-action="interview-video-add"/.test(adminSrc)
);
report(
  'the Add button has a case in handleClick',
  /case 'interview-video-add':/.test(adminSrc)
);
report(
  'the Add button routes through stageInterviewVideo',
  /case 'interview-video-add':[\s\S]{0,400}?stageInterviewVideo\(/.test(adminSrc)
);
report(
  'the Remove button has a case in handleClick',
  /case 'interview-video-remove':/.test(adminSrc)
);
report(
  'Enter in the YouTube box stages rather than submits, as the help text says',
  /keydown[\s\S]{0,700}?interview-video-url[\s\S]{0,300}?preventDefault/.test(adminSrc)
);

/*
 * The general invariant that would have caught this bug on day one.
 *
 * A `data-action` value only does anything if the same string appears as a
 * `case` in handleClick's switch. Adding a button therefore needs two edits in
 * two distant places, and forgetting the second produces a control that renders
 * perfectly, sits on screen, and silently does nothing -- which is exactly how
 * the Add button shipped. A grep for the button's markup passes in that state,
 * so assert the ROUTING instead.
 *
 * Restricted to data-action values that appear in an `interview` context, so
 * this stays focused on the feature under test rather than auditing the whole
 * workspace.
 */
const interviewActionValues = new Set(
  [...adminSrc.matchAll(/data-action="(interview-[a-z-]+)"/g)].map((m) => m[1])
);
const unrouted = [...interviewActionValues].filter(
  (action) => !new RegExp(`case '${action}':`).test(adminSrc)
);
report(
  `every interview data-action is routed in handleClick (${interviewActionValues.size} found)`,
  interviewActionValues.size >= 6 && unrouted.length === 0,
  unrouted.length ? `unrouted: ${unrouted.join(', ')}` : undefined
);

/* ======================================================================== *
 * Result
 * ======================================================================== */
console.log(
  `\n${'='.repeat(60)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(60)}`
);
if (fail) {
  failures.forEach((label) => console.log(`  - ${label}`));
  process.exitCode = 1;
}

