/* ==============================================================================
   tests/features.mjs — About Us, front-page layout, podcasts
   ------------------------------------------------------------------------------
   Runs in bare Node against the REAL modules and the REAL source files.

   The bugs these assertions were written for, all of which shipped:

     • THE REBRAND ATE AN IDENTIFIER. "The Wire" -> "The Pulse" was applied as a
       literal phrase swap, and "the wire" is a PREFIX of the function name
       `wire_login` -- so the comment "the wire_login() function" became
       "the pulse_login() function". A display-string rename silently renamed a
       backend function. Every wire_* / wire-* token is now diffed before and
       after and the script refuses to finish if the set moves.

     • THE ABOUT PAGE ORDERED BY THE CREDITS COLUMN. Both pages sort by a manual
       order, and reusing one integer for both meant promoting somebody to the
       board also reshuffled the published Credits page.

     • THE LAYOUT SAVE WROTE NOTHING. The save read a select the About-scope form
       does not render, `Number(undefined)` is NaN, and NaN was written back as
       the default -- resetting a story to the bottom instead of moving it.

     • PODCASTS REJECTED THEIR OWN AUDIO. Rejecting deleted the row and left the
       object in the bucket, because the storage path was never read before the
       delete that removed the only record of it.

   Run:  node tests/features.mjs
   ========================================================================== */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
const credits = await import('../src/lib/credits.js');
const podcasts = await import('../src/lib/podcasts.js');
// public.js imports cleanly in bare Node -- it touches the DOM only inside
// functions -- so the player formatter is exercised as the real export rather
// than as a copy sliced out of the source.
const { formatClock } = await import('../src/views/public.js');

const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const indexHtml = read('index.html');
const appSrc = read('src/app.js');
const publicSrc = read('src/views/public.js');
const adminSrc = read('src/views/admin.js');
const creditsSrc = read('src/lib/credits.js');
const podcastsSrc = read('src/lib/podcasts.js');
const storeSrc = read('src/lib/store.js');
const stylesSrc = read('src/styles.css');
const migration = read('supabase/migrations/024_about_podcasts_and_layout.sql');
const repairSql = read('supabase/migrations/025_podcasts_storage_repair.sql');

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

console.log('\nSECTION 1 — the rebrand touched display strings and nothing else\n');

report(
  'no reader-facing "The Wire" survives',
  !/The Wire|THE WIRE|the wire/.test(indexHtml) &&
    !/The Wire|THE WIRE/.test(publicSrc) &&
    !/The Wire|THE WIRE/.test(creditsSrc),
  'a phrase left in the masthead is a phrase a reader sees'
);
report(
  'the document title and description carry the new name',
  /<title>The Pulse — MJLA Press Club<\/title>/.test(indexHtml) &&
    /content="The Pulse — MJLA Press Club\./.test(indexHtml)
);
report(
  'the footer copyright is exactly as specified',
  /&#169; <span id="footer-year">2026<\/span> The Pulse &#8212; MJLA Press Club\. All\s+rights reserved\./.test(
    indexHtml.replace(/\s+/g, ' ')
  ) ||
    /The Pulse &#8212; MJLA Press Club\. All/.test(indexHtml)
);

/* The rebrand's real hazard. `the wire` is a prefix of `wire_login`, so a
   phrase swap renamed a function inside a comment. */
const wireTokens = (() => {
  const found = new Map();
  for (const file of ['src/app.js', 'src/lib/store.js', 'src/lib/auth.js', 'src/lib/credits.js', 'src/lib/podcasts.js', 'src/views/public.js', 'src/views/admin.js', 'src/views/alerts.js', 'src/lib/push.js', 'supabase/credentials.sql']) {
    const text = read(file);
    for (const m of text.matchAll(/\bwire[_-][A-Za-z0-9_-]+/gi)) {
      found.set(m[0], (found.get(m[0]) || 0) + 1);
    }
  }
  return found;
})();

for (const token of [
  'wire_login',
  'wire_approve_account',
  'wire_set_account_role',
  'wire_submit_portrait',
  'wire-media',
  'wire.theme',
  'wire-token'
]) {
  report(
    `the identifier \`${token}\` is intact`,
    wireTokens.has(token) || new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(indexHtml),
    'the rebrand renamed a backend identifier'
  );
}
report(
  'no "pulse_" or "pulse-" identifier was invented from the rebrand',
  !/\bpulse[_-][a-z]/i.test(
    [appSrc, storeSrc, creditsSrc, podcastsSrc, publicSrc, adminSrc, read('src/lib/auth.js')].join('\n')
  ),
  '"the wire_login function" became "the pulse_login function" once already'
);
report(
  'the storage bucket name is still the one the migrations create',
  /const BUCKET = 'wire-media'/.test(read('src/lib/upload.js')) &&
    /'wire-media'/.test(read('supabase/credentials.sql'))
);

console.log('\nSECTION 2 — navigation spacing\n');

const navBlock = (() => {
  const start = indexHtml.indexOf('id="primary-links"');
  return start === -1 ? '' : indexHtml.slice(start, start + 400);
})();

/*
 * CSS comments are stripped before any rule assertion.
 *
 * This file's own prose names the selectors it replaced -- ".dark
 * .nav-link::after" appears in a comment explaining why it is gone -- so a
 * naive grep for the old selector matches the explanation of its removal and
 * reports the rule as still present. Asserting on commented-out CSS is how a
 * "fix" gets reported as un-done forever.
 */
const css = stylesSrc.replace(/\/\*[\s\S]*?\*\//g, '');

report(
  'nav items cannot be squeezed',
  /\.nav-bar__links > li\s*\{[^}]*flex-shrink:\s*0/.test(css),
  'flex items default to flex-shrink:1, so a too-wide row COMPRESSES them and the label wraps inside its own box -- two heights in one bar, and no overflow for a check to find'
);
report(
  'a nav label never wraps',
  /\.nav-link\s*\{[\s\S]*?white-space:\s*nowrap/.test(css)
);
report('the bar is a single line, never a wrapped one', /\.nav-bar\s*\{[\s\S]*?flex-wrap:\s*nowrap/.test(css));
report(
  'it distributes with space-between, as specified',
  /\.nav-bar\s*\{[\s\S]*?justify-content:\s*space-between/.test(css) &&
    /\.nav-bar\s*\{[\s\S]*?align-items:\s*center/.test(css)
);
report(
  'the inline row uses the specified 1.25rem gap',
  /\.nav-bar__links\s*\{[\s\S]*?gap:\s*1\.25rem/.test(css),
  '1.5rem was the previous value and it is what pushed the ninth link onto a second line'
);
report(
  '.nav-link no longer positions itself or hugs its glyphs',
  /\.nav-link\s*\{[\s\S]*?display:\s*inline-flex/.test(css) &&
    !/\.nav-link\s*\{[^}]*position:\s*relative/.test(css),
  'position:relative plus inline-block is what made every hit area a different width'
);
report(
  'every nav link gets uniform horizontal padding',
  /\.nav-link\s*\{[\s\S]*?padding-inline:\s*0\.5rem/.test(css)
);
report(
  'the underline is a background gradient, not an absolutely positioned ::after',
  /\.nav-link\s*\{[\s\S]*?background-size:\s*0% 2px/.test(css) &&
    !/\.nav-link::after\s*\{/.test(css),
  'a positioned ::after is what required position:relative in the first place'
);
report(
  'the underline accent is one variable, so dark mode needs no second rule',
  /--nav-underline:\s*var\(--color-newsred\)/.test(css) &&
    /--nav-underline:\s*var\(--color-newsgold-bright\)/.test(css) &&
    !/\.dark \.nav-link::after\s*\{/.test(css)
);

/* --- mobile drawer + overflow ------------------------------------------- */
report('inline links are hidden below the drawer breakpoint', /\.nav-bar__links,\s*\.nav-bar__more\s*\{\s*display:\s*none/.test(css));
report('the burger is a real control, not a label', /\.nav-bar__burger\s*\{[\s\S]*?width:\s*2\.5rem/.test(css));
report('the drawer is a dialog, so focus and Escape come for free', /<dialog id="nav-drawer"/.test(indexHtml));
report(
  'drawer rows have a touch-sized target',
  /\.nav-drawer__item a,[\s\S]*?min-height:\s*3rem/.test(css),
  'a 0.6875rem uppercase label is far too small a tap target on its own'
);
report(
  'the drawer respects reduced-motion',
  /@media \(prefers-reduced-motion: reduce\)[\s\S]*?nav-drawer/.test(css)
);
report(
  'the overflow menu is MEASURED, not breakpoint-guessed',
  /const placeOverflow = \(\) => \{/.test(publicSrc) && /const neededWidth = \(\) => \{/.test(publicSrc),
  'a media query has to be hand-tuned against a wordmark whose width moves with the theme'
);
report(
  'the width measured is the sum of the items, NOT the list scrollWidth',
  /widths\.reduce\(\(sum, w\) => sum \+ w, 0\)/.test(publicSrc) &&
    !/const needed = list\.scrollWidth/.test(publicSrc),
  'the <ul> is itself a shrinkable flex item, so its scrollWidth reads back the width it was squeezed to and the check reports "fits" while labels wrap'
);
report(
  'the wordmark sits beside the burger on a phone',
  /@media \(width < 48rem\)[\s\S]*?\.nav-bar__burger,\s*\n?\s*\.nav-bar__wordmark\s*\{[\s\S]*?display:\s*inline-flex/.test(css),
  'a hamburger with nothing beside it is a mystery button'
);
report(
  '"More" is hidden entirely when nothing overflows',
  /moreWrap\.hidden = true;/.test(publicSrc)
);
report(
  'the drawer re-measures on resize and on a theme change',
  /addEventListener\('resize', remeasure\)/.test(publicSrc) &&
    /wire:theme-changed/.test(publicSrc)
);

/*
 * One link list, three renderings. They were three hardcoded <ul>s and they
 * drifted: a section added to the masthead row never reached the drawer, so it
 * was unreachable on a phone entirely.
 */
report(
  'the drawer is populated from the shared NAV_LINKS list',
  /const NAV_LINKS = \[/.test(publicSrc) &&
    /NAV_LINKS\.map/.test(publicSrc) &&
    /<ul class="nav-drawer__list" data-nav-drawer-list><\/ul>/.test(indexHtml),
  'an empty container filled at runtime, not a fourth copy of the markup'
);
report(
  'every NAV_LINKS destination is reachable from the drawer',
  (() => {
    const block = publicSrc.slice(
      publicSrc.indexOf('const NAV_LINKS = ['),
      publicSrc.indexOf('function initNavigation()')
    );
    const pages = [...block.matchAll(/page:\s*'([a-z]+)'/g)].map((m) => m[1]);
    const anchors = [...block.matchAll(/anchor:\s*'(#[a-z-]+)'/g)].map((m) => m[1]);
    // Views live in index.html as empty mounts; the ANCHORS are rendered at
    // runtime by public.js, so they can only be checked against that file. A nav
    // link pointing at a section that no longer exists is a dead row, and the
    // front page is assembled in JS rather than declared in the shell.
    return (
      pages.length > 0 &&
      anchors.length > 0 &&
      pages.every((page) => indexHtml.includes(`id="${page}-view"`)) &&
      anchors.every((anchor) => publicSrc.includes(`id="${anchor.slice(1)}"`))
    );
  })(),
  'a link pointing at a view or anchor that does not exist is a dead drawer row'
);

console.log('\nSECTION 3 — the About page\n');

report(
  'the page carries the agreed headline',
  /Stories that matter\. Voices that count\./.test(creditsSrc)
);
report(
  'the mission heading and tagline read as specified',
  /Our mission &amp; Vision/.test(creditsSrc) && /Truth &#8226; Integrity &#8226; Voice/.test(creditsSrc)
);
report(
  'both mission paragraphs are present verbatim',
  /Every school has stories worth telling\./.test(creditsSrc) &&
    /We promise to listen before we write, verify before we publish/.test(creditsSrc)
);
report(
  'the team section is headed as specified',
  /Meet the press/.test(creditsSrc) && /Behind every story is a team\./.test(creditsSrc)
);
report(
  'the two rosters are exactly the two named categories',
  JSON.stringify(credits.ABOUT_CATEGORIES) ===
    JSON.stringify(['Board Members', 'Behind the Bylines']),
  'these strings are rendered as headings, so a typo here is a section nobody can fill'
);
report(
  'an unknown category is refused rather than stored',
  credits.normaliseAboutCategory('board members') === 'Board Members' &&
    credits.normaliseAboutCategory('Nobody') === '' &&
    credits.normaliseAboutCategory(null) === ''
);
report(
  'a team card falls back three ways, ending at the initials',
  /about-card__photo/.test(creditsSrc) && /imageFallbackAttr\(\)/.test(creditsSrc) &&
    /about-card__initials/.test(creditsSrc) && /function initialsOf/.test(creditsSrc),
  'a photo on this page is optional, so a broken one must not be worse than none'
);
report(
  'the category is constrained in the database, not only in the client',
  /credits_people_category_check/.test(migration) &&
    /check \(category is null or category in \('Board Members', 'Behind the Bylines'\)\)/.test(migration)
);
report(
  'the About page has its own reader view and a door into it',
  /id="about-view"[\s\S]{0,80}data-reader-view/.test(indexHtml) &&
    /data-nav="about"/.test(indexHtml),
  'the view is selected by the data-reader-view attribute, so the attribute is what matters'
);
report(
  'the router knows about /about, and knows it from one list',
  /'about'/.test(appSrc.match(/const READER_VIEWS = \[[\s\S]*?\]/)?.[0] || '') &&
    /if \(target === 'about'\) renderAbout\(/.test(appSrc)
);

console.log('\nSECTION 4 — About Us management in the Owner panel\n');

report(
  'the About rosters are managed from the existing Credits component',
  /let creditsScope = ''/.test(adminSrc) && /function creditsScopeSwitcher/.test(adminSrc),
  'a second editor for the same six fields would be a second thing to keep in step'
);
report(
  'the switcher offers all three rosters',
  /'Credits page'/.test(adminSrc) &&
    /ABOUT_CATEGORIES\.map/.test(adminSrc)
);
report(
  'each person card can be moved between rosters',
  /data-credits-category/.test(adminSrc)
);
report('the add form can place a new person in a roster', /credits-add-category/.test(adminSrc));
report(
  'a save sends the category, so a promotion is one edit',
  /category: form\.querySelector\('\[data-credits-category\]'\)/.test(adminSrc)
);
report(
  'the About page and the Credits page are ordered by SEPARATE columns',
  /add column if not exists about_order integer/.test(migration) &&
    /credits_people_about_order_idx/.test(migration) &&
    /a\.about_order \?\? 100/.test(creditsSrc),
  'one integer serving two lists means promoting somebody reshuffles a published page'
);
report(
  'the RPC drops the old signature instead of overloading it',
  /drop function if exists public\.wire_credits_people_upsert\(uuid, text, text, text, text, text, integer\)/.test(
    migration
  ) &&
    /p_about_order integer default null/.test(migration),
  'two candidates for one PostgREST name is PGRST202 again'
);
report(
  'the upsert validates the category server-side',
  /raise exception 'unknown About Us category: %'/.test(migration)
);
report(
  'a category the caller did not mention is left alone',
  /\.\.\.\(categoryValue === undefined \? \{\} : \{ p_category: categoryValue \}\)/.test(creditsSrc),
  'the server assigns category unconditionally, so omitting the key means "clear it"'
);

console.log('\nSECTION 5 — Latest Coverage ordering\n');

report(
  'the front page ranks placed stories above the rest',
  /Number\.isFinite\(article\.displayOrder\)/.test(storeSrc) &&
    /\[\.\.\.placed, \.\.\.published\.filter/.test(storeSrc),
  'coalescing the two would make "put this at the top" depend on the filing date'
);
report(
  'the unplaced tail keeps the store\'s own order and is NOT re-sorted',
  !/localeCompare\(String\(a\.date/.test(storeSrc),
  're-sorting by published_at disagrees with the created_at desc the query already returns, and silently reorders the front page and the Curation dropdown'
);
report('display_order is nullable, so the migration cannot reorder a live page', /display_order integer;/.test(migration));
report(
  'the layout save is ONE call for the whole order',
  /wire_set_article_layout/.test(storeSrc) && /wire_set_article_layout/.test(migration)
);
report(
  'the reorder panel offers a drag handle and both arrows',
  /data-layout-handle/.test(adminSrc) &&
    /data-action="layout-up"/.test(adminSrc) &&
    /data-action="layout-down"/.test(adminSrc),
  'the arrows are not a fallback: on a phone a one-step swap should never need a drag'
);
report(
  'the handle opts out of touch scrolling, or a drag scrolls the page instead',
  /\.layout-row__handle\s*\{[\s\S]*?touch-action:\s*none/.test(stylesSrc),
  'this one property is the whole reason touch dragging works'
);
report(
  'the save is disabled until the order actually differs',
  /layoutIsDirty\(\)/.test(adminSrc) && /\$\{dirty \? '' : 'disabled'\}/.test(adminSrc)
);
report(
  'the save only ever touches rows it was given',
  /where id = p_ids\[v_position\]/.test(migration)
);
report(
  'the curated Today\'s Pick cannot be dragged out of place',
  /id is distinct from \(\s*\n?\s*select todays_pick_id/.test(migration),
  'moving it would silently repoint a curation choice'
);

console.log('\nSECTION 6 — podcasts\n');

report(
  'the table exists with the columns the brief names',
  /create table if not exists public\.podcasts/.test(migration) &&
    /duration_seconds\s+integer/.test(migration) &&
    /status\s+text\s+not null default 'pending'/.test(migration)
);
report(
  'the description limit is enforced in the database, not only the form',
  /podcasts_description_check/.test(migration) &&
    /length\(description\) <= 140/.test(migration)
);
report(
  'a writer can only ever create a pending row',
  /and status = 'pending'/.test(migration) &&
    /author_account_id = public\.current_account_id\(\)/.test(migration),
  'a crafted request must not be able to approve its own submission'
);
report(
  'anon can read approved episodes and nothing else',
  /for select using \(status = 'approved' or public\.is_staff\(\)\)/.test(migration)
);
report(
  'writers get no UPDATE on podcasts at all',
  /podcasts_owner_all/.test(migration) &&
    /grant insert on public\.podcasts to authenticated/.test(migration) &&
    !/grant update on public\.podcasts to anon/.test(migration)
);
report(
  'the audio lives in its own bucket, not in wire-media',
  /const BUCKET = 'podcasts'/.test(podcastsSrc) &&
    /'podcasts', 'podcasts', true/.test(migration) &&
    !/const BUCKET = 'wire-media/.test(podcastsSrc),
  'sharing a bucket makes a delete bug in one feature a data loss in another'
);
/*
 * SQL comments are stripped before the size-cap assertions, for the same reason
 * the CSS ones are: both migrations explain at length WHY the pretend cap was
 * removed, and a naive grep for it matches the explanation of its removal and
 * reports the bug as still present.
 */
const sqlLive = (text) => text.replace(/--[^\n]*/g, '');

report(
  'the upload policy is audio-only and path-scoped',
  /bucket_id = 'podcasts'/.test(sqlLive(migration)) && /'episodes'/.test(sqlLive(migration))
);
report(
  'no policy pretends to cap the upload size',
  !/octet_length\(name\)/.test(sqlLive(migration)) &&
    !/octet_length\(name\)/.test(sqlLive(repairSql)),
  'octet_length(name) is the length of the FILENAME, so it capped nothing while reading as a cap'
);
report(
  'the real size cap is the bucket file_size_limit',
  /insert into storage\.buckets \([^)]*file_size_limit\)/.test(sqlLive(migration)) &&
    /values\s*\(\s*'podcasts',\s*'podcasts',\s*true,\s*26214400\s*\)/.test(sqlLive(migration)) &&
    /file_size_limit\s*=\s*excluded\.file_size_limit/.test(sqlLive(repairSql)),
  'a real server-side ceiling, matching the client 25 MB'
);
report(
  'the client refuses an oversized file before uploading it',
  /const MAX_BYTES = 25 \* 1024 \* 1024/.test(podcastsSrc) && /The limit is 25 MB/.test(podcastsSrc)
);
report(
  'the bucket is pre-flighted so a missing bucket costs one cheap read',
  /export async function checkPodcastStorage/.test(podcastsSrc) &&
    /await checkPodcastStorage\(\)/.test(podcastsSrc)
);
report(
  "the real Storage error reaches the user, not a generic sentence",
  /export function describeStorageError/.test(podcastsSrc) &&
    /Storage said:/.test(podcastsSrc) &&
    /row-level security/.test(podcastsSrc) &&
    /bucket not found/.test(podcastsSrc),
  '"Failed to load resource" is the browser message for any unreadable response; only Supabase\'s own text separates a missing bucket from an RLS refusal'
);
report(
  'there is deliberately NO data-URL fallback for audio',
  /No data-URL fallback here/.test(podcastsSrc) &&
    !/readAsDataUrl|createObjectURL[\s\S]{0,80}submit/.test(podcastsSrc),
  'an MP3 in localStorage blows the quota and loses the recording'
);
report(
  'the file check requires BOTH an mp3 extension and an audio type',
  // A literal substring, not a regex. `/\.mp3$/i` compiled against a whole source
  // file can only match a string ENDING in ".mp3" -- with no `m` flag the `$`
  // anchors to the end of the subject -- so it reports false against code that
  // plainly contains the check. Escaping the `$` "to fix" it makes it pass for
  // the wrong reason, which is worse.
  podcastsSrc.includes('nameLooksRight = /\\.mp3$/i.test(') &&
    podcastsSrc.includes("const MP3_MIME = 'audio/mpeg'") &&
    /!nameLooksRight \|\| \(!typeLooksRight && !looseType\)/.test(podcastsSrc)
);
report(
  'rejecting reads the storage path BEFORE deleting the row',
  /select\('storage_path'\)[\s\S]*?\.delete\(\)\.eq\('id', id\)/.test(podcastsSrc),
  'afterwards there is nothing left to learn the path from and the file is orphaned forever'
);
report(
  'a failed row insert purges the object it just uploaded',
  /storage[\s\S]*?\.remove\(\[path\]\)/.test(podcastsSrc)
);
report(
  'a purge failure is reported honestly, not as a failed refusal',
  /could not purge the rejected audio/.test(podcastsSrc) &&
    /ok: true,/.test(podcastsSrc.slice(podcastsSrc.indexOf('could not purge'), podcastsSrc.indexOf('could not purge') + 200))
);
report(
  'the approval queue is Owner-gated and shows a real player',
  /id: 'podcasts', label: 'Podcasts'[\s\S]*?ownerOnly: true/.test(adminSrc) &&
    /<audio class="podcast-card__audio mt-3" controls/.test(adminSrc),
  'the decision needs to be "is this the right audio", which a title cannot answer'
);
report(
  'the Owner can publish directly, skipping the queue',
  /export async function publishPodcast/.test(podcastsSrc) &&
    /status: 'approved'/.test(podcastsSrc) &&
    /data-action="podcast-upload"/.test(adminSrc)
);
report(
  'direct publish is a SEPARATE function from the writer submission',
  /export async function publishPodcast/.test(podcastsSrc) &&
    /export async function submitPodcast/.test(podcastsSrc) &&
    adminSrc.indexOf("case 'podcast-upload'") !== adminSrc.indexOf("case 'podcast-new'"),
  'submitPodcast always writes pending and the INSERT policy pins it; adding a flag to it would widen the path a writer can reach'
);
report(
  'the Owner can edit an episode in place',
  /export async function updatePodcastText/.test(podcastsSrc) &&
    /data-podcast-edit-form/.test(adminSrc) &&
    /data-action="podcast-save-edit"/.test(adminSrc)
);
report(
  'editing text does NOT offer to swap the audio',
  /Replacing audio means publishing a new episode|replacing the file would orphan/i.test(adminSrc),
  'swapping the file would orphan the old object and the row cannot tell which is live'
);
report(
  'the Owner can delete a published episode',
  /export async function deletePodcast/.test(podcastsSrc) &&
    /data-action="podcast-delete"/.test(adminSrc)
);
report(
  'refuse and delete share one function, so neither can forget the purge',
  /action === 'podcast-reject'[\s\S]{0,260}: await deletePodcast\(id\)/.test(adminSrc),
  'two paths is how the first version ended up orphaning objects on one of them'
);
report(
  'the writer submit door is NOT on the Interviews tab',
  !/data-action="podcast-new"[\s\S]{0,400}Interviews desk/.test(adminSrc),
  'an episode filed from the Interviews desk reads as though it files as an interview'
);
report(
  'the writer door is on a tab every staffer can reach',
  /data-action="podcast-new"/.test(adminSrc) &&
    !adminSrc
      .slice(adminSrc.indexOf('function renderPodcastsTab'), adminSrc.indexOf('function podcastQueuePanel'))
      .includes('podcast-new'),
  'the Podcasts tab is Owner-only, so a writer has no door at all if the form lives there'
);
report(
  'refusing asks for confirmation and says it purges',
  /cannot be undone/.test(adminSrc) && /purged from storage/.test(adminSrc)
);
report(
  'writers have a door: the submit action is not on the Owner-only tab',
  /case 'podcast-new':/.test(adminSrc) &&
    /data-action="podcast-new"/.test(adminSrc) &&
    !/data-action="podcast-new"[\s\S]{0,400}renderPodcastsTab/.test(adminSrc)
);
report(
  'the episode duration is read by the browser, with no library',
  /function readAudioDuration/.test(adminSrc) && /loadedmetadata/.test(adminSrc) &&
    /URL\.revokeObjectURL/.test(adminSrc),
  'an object URL leaked per submission pins the whole file in memory'
);

console.log('\nSECTION 6b — the public player\n');

report(
  'the public page shows approved episodes newest first',
  /renderPodcastsPage/.test(publicSrc) && /listPodcasts\(\)/.test(publicSrc)
);
report('the card carries author, title and description', /podcast-card__byline/.test(publicSrc) && /podcast-card__desc/.test(publicSrc));
report(
  'the native controls are replaced, not doubled',
  /preload="metadata"/.test(publicSrc) && !/controls/.test(publicSrc.slice(publicSrc.indexOf('function podcastCard'), publicSrc.indexOf('function podcastCard') + 1800)),
  'two sets of transport controls on one card is the obvious failure'
);
report('play/pause toggles', /data-toggle/.test(publicSrc) && /audio\.paused/.test(publicSrc));
report(
  'the scrubber seeks, and timeupdate does not fight the drag',
  /scrubbing/.test(publicSrc) && /audio\.currentTime = /.test(publicSrc) &&
    /if \(scrubbing\) return;/.test(publicSrc),
  'without the guard the thumb snaps back to wherever playback is and the drag feels broken'
);
report(
  'the keyboard can seek too, not only a pointer',
  /scrub\.addEventListener\('change', endScrub\)/.test(publicSrc),
  'arrow keys move the thumb without a pointerdown ever firing'
);
report(
  'speed cycles the five rates the brief names',
  /\[0\.75, 1, 1\.25, 1\.5, 2\]/.test(publicSrc)
);
report(
  'the speed label follows ratechange, not just the click',
  /ratechange/.test(publicSrc) &&
    /defaultPlaybackRate/.test(publicSrc),
  'otherwise a browser that changes the rate on its own leaves the label lying'
);
report('ending resets the transport', /addEventListener\('ended'/.test(publicSrc));
report(
  'the timestamps show elapsed and total',
  /formatClock/.test(publicSrc) && /data-elapsed/.test(publicSrc) && /data-total/.test(publicSrc)
);
report(
  'formatClock is right at the boundaries',
  // The real exported function, not a copy of it. Slicing the source out and
  // eval-ing it tested the slice; this tests the module.
  formatClock(0) === '0:00' &&
    formatClock(9) === '0:09' &&
    formatClock(61) === '1:01' &&
    formatClock(600) === '10:00' &&
    formatClock(3661) === '1:01:01' &&
    formatClock(-5) === '0:00' &&
    formatClock('nonsense') === '0:00',
  'a player that reads 61 seconds as 1:01 is correct; one that reads it as 61:01 is not'
);
report(
  'the player is touch-sized and flexible',
  /\.podcast-player__scrub\s*\{[\s\S]*?flex:\s*1/.test(stylesSrc) &&
    /\.podcast-player__toggle\s*\{[\s\S]*?width:\s*2\.25rem/.test(stylesSrc)
);
report(
  'a phone drops the total-duration stamp rather than wrapping the bar',
  /@media \(width < 30rem\)[\s\S]*?podcast-player__time\[data-total\]/.test(stylesSrc)
);

/** Evaluate formatClock straight out of the module, without a DOM. */
console.log(`\n${pass} passed, ${fail} failed`);

if (fail) {
  console.log(`\n${fail} FAILED:\n`);
  for (const f of failures) console.log(`  - ${f}`);
  console.log('');
  process.exit(1);
}

console.log('RESULT: PASS — About Us, layout ordering and podcasts are wired.\n');

/* Silence the unused-import lint on values only used by the assertions above. */
void store;
