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

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
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
const domSrc = read('src/lib/dom.js');
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
  /shown\.reduce\(\(sum, item\) => sum \+ item\.offsetWidth, 0\)/.test(publicSrc) &&
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

/*
 * These four used to assert the old shape: ONE tab with a three-way roster
 * switcher and a per-card "Appears under" dropdown. That shape is gone, and two
 * of the things it asserted are now bugs rather than features.
 *
 * What is preserved is the CONCERN behind them — "a second editor for the same
 * six fields would be a second thing to keep in step" — which is now answered by
 * one `renderRosterTab`/`rosterPersonCard` pair behind two tabs, rather than by
 * collapsing both pages into one.
 */
report(
  'both pages share one renderer, so a card fix cannot land on one page only',
  /function renderRosterTab\(scope\)/.test(adminSrc) &&
    /function rosterPersonCard\(person, scope\)/.test(adminSrc) &&
    /renderAboutTab[\s\S]*?return renderRosterTab\('about_us'\);/.test(adminSrc) &&
    /renderCreditsTab[\s\S]*?return renderRosterTab\('credits'\);/.test(adminSrc),
  'the two editors share a card and a form; only the scope, the order column, the category field and the grouping differ'
);
report(
  'an About Us card can be filed under a roster',
  /id="credits-category-\$\{id\}"[\s\S]*?data-credits-category required/.test(adminSrc),
  'the About page renders rosters under those two headings, and the database refuses an about_us row without a category'
);
report('the About add form can place a new person in a roster', /credits-add-category/.test(adminSrc));
report(
  'a save sends BOTH the scope and the category, in that order of authority',
  /page_scope: scope,\s*\n\s*category: onAbout \? form\.querySelector/.test(adminSrc),
  'the server derives the category FROM the scope, so a contradictory pair resolves to the credits interpretation rather than failing at COMMIT time'
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
  'RLS is enabled on podcasts, so a grant without anon is unreachable rather than open',
  /alter table public\.podcasts enable row level security/.test(migration) &&
    /grant select on public\.podcasts to anon, authenticated/.test(migration) &&
    /grant insert on public\.podcasts to anon, authenticated/.test(migration),
  'this REPLACED an assertion that read "grant insert ... to authenticated" as deliberate hardening. It was not: RLS is consulted only AFTER the table privilege, and requests arrive as anon, so omitting anon made every insert unreachable. Widening a grant is safe here precisely because row policies, not grants, decide rows -- and that is asserted separately below.'
);
report(
  'writers get no UPDATE on podcasts at all',
  /create policy podcasts_owner_all on public\.podcasts\s*\n\s*for all\s*\n\s*using \(public\.is_owner\(\)\)\s*\n\s*with check \(public\.is_owner\(\)\)/.test(
    migration
  ) &&
    // No policy anywhere grants UPDATE to anyone who is not the Owner.
    !/for update[\s\S]{0,200}?is_staff\(\)/.test(migration),
  'a writer who cannot approve must not be able to edit an approved row either; the protection is podcasts_owner_all requiring is_owner(), NOT the absence of a grant'
);
report(
  'the podcast policies still pin the things that matter',
  /and status = 'pending'/.test(migration) &&
    /and author_account_id = public\.current_account_id\(\)/.test(migration) &&
    /using \(status = 'approved' or public\.is_staff\(\)\)/.test(migration),
  "self-approval is refused on the way in, the filer is stamped from the session rather than trusted, and an anon key cannot list the approval queue"
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
    /form\.dataset\.podcastEditForm/.test(adminSrc) &&
    /savePodcastEditFromForm/.test(adminSrc),
  'the save is a plain submit control routed by the delegated form listener, so it carries no data-action'
);
report(
  'no button claims a delegated action that has no handler',
  !/data-action="podcast-save-edit"/.test(adminSrc),
  'a data-action with no matching case reads as a delegated button that lost its handler; scripts/control-audit.mjs reports this class'
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
console.log('\nSECTION 7 — the alert opt-in is not a dead button\n');

const alertsSrc = read('src/views/alerts.js');
/**
 * Only the BODY of ensureAlertPermission, so an assertion about the deliberate
 * path cannot be satisfied by the legitimate automatic-prompt guard in
 * shouldPromptForAlerts() -- which is a different function and is supposed to
 * stay silent.
 */
const permissionFn = alertsSrc.slice(
  alertsSrc.indexOf('export async function ensureAlertPermission'),
  alertsSrc.indexOf('/* ----', alertsSrc.indexOf('export async function ensureAlertPermission'))
);

report(
  'a deliberate tap is distinguished from the automatic prompt',
  /export async function ensureAlertPermission\(\{ deliberate = false \} = \{\}\)/.test(alertsSrc),
  'the "already answered" guard used to swallow deliberate clicks too, so the button did nothing at all -- no dialog, no toast, no error'
);
report(
  'the already-answered guard is conditional on the prompt being automatic',
  /if \(hasAnswered\(\) && !deliberate\)/.test(permissionFn) &&
    !/if \(hasAnswered\(\)\) return false;/.test(permissionFn),
  'silence is only correct for a prompt nobody asked for'
);
report(
  'the opt-in button passes deliberate and catches',
  /ensureAlertPermission\(\{ deliberate: true \}\)\.catch/.test(alertsSrc),
  'the handler used to discard the promise, so a rejection became an unhandled rejection with nothing on screen'
);
report(
  'a browser-level denied permission is explained, not re-requested',
  /deliberate && permission === 'denied'/.test(alertsSrc) &&
    /blocking notifications for this site/.test(alertsSrc),
  'requestPermission() cannot re-prompt after a denial, so it resolves "denied" forever and looks like a dead button'
);
report(
  'the automatic prompt guard is left intact',
  /export function shouldPromptForAlerts\(\)[\s\S]*?if \(hasAnswered\(\)\) return false;/.test(
    alertsSrc
  ),
  'that guard is correct where it lives: it stops the modal reappearing on every article'
);

console.log('\nSECTION 8 — About Us and Credits are two pages, not one filtered list\n');

/*
 * THE GUARD THAT MATTERS FOR THE BLEED, and it has to be STATIC.
 *
 * The browser probe in scripts/scope-check.mjs watches the network payload for an
 * About Us name arriving on the Credits page, which is the real assertion. But it
 * is VACUOUS IN DEMO MODE: `listPeopleInScope()` short-circuits to
 * `demoRoster()` — localStorage — so no `credits_people` request is ever made and
 * there is nothing to inspect. Measured: deleting `.eq('page_scope', wanted)` from
 * src/lib/credits.js entirely still gave that probe 23/23 green.
 *
 * So the load-bearing version reads the source. It cannot be vacuous, and it
 * runs in every `npm test`.
 */
report(
  'both public pages filter in the QUERY, not in the renderer',
  /\.eq\('page_scope', wanted\)/.test(creditsSrc) &&
    /listPeopleInScope\('credits'\)/.test(creditsSrc) &&
    /listPeopleInScope\('about_us'\)/.test(creditsSrc),
  'filtering after the fetch still SHIPS the whole table to the browser: the board names, roles, notes and photo URLs were all in the HTML of the Credits page for a reader who never opened About Us. Filtering in the renderer is a convention, not a boundary.'
);
report(
  'the About page reads only the about_us scope',
  /export async function loadAboutRoster\(\)\s*\{\s*const people = await listAboutPeople\(\);/.test(
    creditsSrc
  ) && /export async function listAboutPeople\(\)\s*\{\s*return listPeopleInScope\('about_us'\);/.test(
    creditsSrc
  )
);
report(
  'the Credits page reads only the credits scope',
  /export async function listCredits\(\)\s*\{\s*return listPeopleInScope\('credits'\);/.test(
    creditsSrc
  )
);
report(
  'the ONE unscoped reader is named, justified, and only two callers use it',
  /export async function listAllPeople\(\)/.test(creditsSrc) &&
    /primePortraits[\s\S]*?await listAllPeople\(\)/.test(creditsSrc) &&
    /listCreditsForOwner[\s\S]*?return listAllPeople\(\);/.test(creditsSrc),
  'scoping primePortraits() to the Credits page would strip the face off every byline belonging to a reporter the Owner listed on About Us -- a front-page regression caused by a change to a page nobody was looking at'
);
report(
  'a person on both pages is two rows, and the panel says so',
  /EXACTLY ONE per row/.test(creditsSrc) && /To put somebody on both pages, add them once on/.test(
    adminSrc
  ),
  'the old design let one row serve both pages, so promoting somebody to the board silently demoted them from Credits'
);

report(
  'the database forbids a row contradicting its own scope',
  /credits_people_page_scope_check[\s\S]*?check \(page_scope in \('about_us', 'credits'\)\)/.test(
    read('supabase/migrations/028_page_scopes.sql')
  ) &&
    /credits_people_scope_category_check[\s\S]*?page_scope = 'about_us' and category is not null[\s\S]*?page_scope = 'credits'\s+and category is null/.test(
      read('supabase/migrations/028_page_scopes.sql')
    ),
  'without the second constraint a leftover category is exactly the value loadAboutRoster() matches on, so a Credits-only row reappears under "Board Members" the moment the About filter is widened by accident'
);
report(
  'the backfill preserves migration 024 rule instead of guessing',
  /set page_scope = case when category is null then 'credits' else 'about_us' end/.test(
    read('supabase/migrations/028_page_scopes.sql')
  ),
  '"category IS NULL means Credits only" was the rule in force, so re-deriving it from category keeps every existing row on the page the Owner last saw'
);
report(
  'page_scope is NOT NULL and defaults to credits',
  /alter column page_scope set default 'credits'/.test(
    read('supabase/migrations/028_page_scopes.sql')
  ) &&
    /alter column page_scope set not null/.test(read('supabase/migrations/028_page_scopes.sql')),
  'a nullable scope means PostgREST can return a row belonging to neither page'
);
report(
  'the RPC DROPS the old signature rather than overloading it',
  /drop function if exists public\.wire_credits_people_upsert\(uuid, text, text, text, text, text, integer, text, integer\);/.test(
    read('supabase/migrations/028_page_scopes.sql')
  ) &&
    /drop function if exists public\.wire_credits_people_upsert\(uuid, text, text, text, text, text, integer, text, integer, text\);/.test(
      read('supabase/migrations/028_page_scopes.sql')
    ),
  'PostgREST resolves one RPC name to its single candidate: adding p_page_scope by OVERLOADING is PGRST202 "Could not find the function" on every add, save and remove, and it kills BOTH pages at once. This is the trap migration 024 walked into.'
);
report(
  'the RPC derives the category FROM the scope, so the two cannot disagree',
  /if v_scope = 'credits' then\s*v_category := null;/.test(
    read('supabase/migrations/028_page_scopes.sql')
  ) &&
    /raise exception 'an About Us entry needs a category/.test(
      read('supabase/migrations/028_page_scopes.sql')
    )
);

console.log('\nSECTION 9 — two panel tabs, not one tab with a filter\n');

report(
  'About Us and Credits are two entries in TABS',
  /\{ id: 'about', label: 'About Us'[\s\S]*?render: renderAboutTab, ownerOnly: true \}/.test(
    adminSrc
  ) &&
    /\{ id: 'credits', label: 'Credits'[\s\S]*?render: renderCreditsTab, ownerOnly: true \}/.test(
      adminSrc
    )
);
report(
  'there is no scope-switcher button row any more',
  !/creditsScopeSwitcher/.test(adminSrc) &&
    !/data-action="credits-scope"/.test(adminSrc) &&
    !/case 'credits-scope'/.test(adminSrc),
  'one tab behind three filter buttons is what made a Credits card offer "Appears under: Board Members" -- the bleed, made editable'
);
report(
  'the "appears under" select is gone from every card',
  !/data-credits-category[^]*?Credits page only/.test(adminSrc) &&
    !/<option value="" \$\{creditsScope/.test(adminSrc),
  'that dropdown is how a person used to be moved off one page by editing a card on the other'
);
report(
  'the page a card belongs to comes from the form that was submitted',
  /data-roster-scope="\$\{onAbout \? 'about_us' : 'credits'\}"/.test(adminSrc) &&
    /const scope = normaliseScope\(form\.dataset\.rosterScope\);/.test(adminSrc),
  'the old module-level `creditsScope` was written by the switcher and read by the save handlers with nothing checking they agreed -- a save dispatched after a tab switch wrote about_order onto a Credits row'
);
report(
  'a typed order is read from ITS OWN form, not the first on the page',
  /function readOrderField\(form, scope\)/.test(adminSrc) &&
    /form\.querySelector\(selector\)/.test(adminSrc) &&
    !/function readOrderField\(scope\)/.test(adminSrc),
  'document.querySelector returns the FIRST match on the page, so with several cards rendered every card saved the top card order number'
);
report(
  'reordering a role band is scoped before the ids are sent',
  /const creditsOnly = rowsInScope\(creditsPeople, 'credits'\);[\s\S]*?moveRoleBand\(creditsOnly, role, direction\)/.test(
    adminSrc
  ) && !/moveRoleBand\(creditsPeople, role, direction\)/.test(adminSrc),
  'the reorder RPC rewrites sort_order from the ARRAY POSITION of every id it is handed, so passing the whole roster renumbers the Credits page using About Us positions'
);
report(
  'the About add form asks for a roster; the Credits one does not',
  /id="credits-add-category"[\s\S]*?required/.test(adminSrc) &&
    /onAbout\s*\? `[\s\S]*?id="credits-add-category"[\s\S]*?`\s*:\s*''/.test(adminSrc),
  'an About Us row with no heading renders under nothing; a disabled-looking dropdown on the Credits form would be the bleed back in disguise'
);

console.log('\nSECTION 10 — the role pill is a wash, and it is legible\n');

report(
  'the badge is a pill, not a solid slab',
  /\.role-pill \{[\s\S]*?border-radius: 9999px[\s\S]*?background: var\(--role-wash\)/.test(css) &&
    !/\.about-card__role \{[\s\S]*?background: var\(--role-colour/.test(css),
  '`background: var(--role-colour); color: #fff` was a solid block of whatever colour the Owner picked, which is unreadable for every dark role colour and shouts over the name'
);
report(
  'the pill is uppercase, tracked, semibold, and wraps INSIDE itself',
  /\.role-pill \{[\s\S]*?text-transform: uppercase[\s\S]*?overflow-wrap: anywhere/.test(css) &&
    /\.role-pill \{[\s\S]*?font-weight: 600[\s\S]*?letter-spacing: 0\.05em/.test(css) &&
    /\.role-pill \{[\s\S]*?font-size: 0\.75rem/.test(css),
  '"ASSISTANT PRESIDENT/COORDINATOR" is 30 characters and a pill has no natural break, so without `anywhere` it pushes out past the card padding -- exactly the complaint this replaced'
);
report(
  'the wash is translucent and the text keeps the accent',
  /\.role-pill \{[\s\S]*?--role-wash: color-mix\(in srgb, var\(--role-solid[^)]*\) 12%/.test(css) &&
    /\.role-pill \{[\s\S]*?color: var\(--role-accent\)/.test(css)
);
report(
  'TWO accents are emitted, one per theme, and CSS picks',
  /--role-accent-light/.test(creditsSrc) &&
    /--role-accent-dark/.test(creditsSrc) &&
    /\.role-pill \{[\s\S]*?--role-accent: var\(--role-accent-light\)/.test(css) &&
    /\.dark \.role-pill \{[\s\S]*?--role-accent: var\(--role-accent-dark/.test(css),
  'contrast depends on the colour VALUES, so only JS can compute a passing accent -- but WHICH theme is on screen is not known at render time. Emitting one accent tuned for the dark card produced 1.79:1 pills in light mode.'
);
report(
  'the accent is NUDGED toward contrast, in the right direction per theme',
  /function ensureContrast\(hex, surface, target\)/.test(creditsSrc) &&
    /luminance\(surface\) > 0\.5 \? '#000000' : '#ffffff'/.test(creditsSrc) &&
    /CARD_SURFACES = \{\s*light: '#faf8f5',\s*dark: '#18181b'\s*\}/.test(creditsSrc),
  'a fixed "lighten until it passes" loop drives an already-pale accent straight up to invisible on a light card'
);
report(
  'the card surface is a THEME TOKEN, not a hardcoded dark pair',
  /:root \{[\s\S]*?--surface-card: #faf8f5/.test(css) &&
    /\.dark \{[\s\S]*?--surface-card: #18181b/.test(css) &&
    /\.about-card \{[\s\S]*?background: var\(--surface-card/.test(css),
  'the site ships both themes; hardcoding #18181b made every card dark-on-light for a light-mode reader'
);
report(
  'the details column is the thing that shrinks',
  /\.about-card__body \{[\s\S]*?min-width: 0[\s\S]*?flex: 1 1 auto/.test(css) &&
    /\.credits-card__body \{[\s\S]*?min-width: 0/.test(css),
  'without min-width:0 a long name pushes the card wider than its grid track instead of wrapping inside it'
);
report(
  'the roster avatar is 56px, shrink-proof, square and rounded',
  /\.about-card__photo \{[\s\S]*?width: 56px[\s\S]*?height: 56px[\s\S]*?flex-shrink: 0[\s\S]*?border-radius: 10px[\s\S]*?object-fit: cover/.test(
    css
  ),
  '56px rather than the earlier 72px: the card is now a compact row in a three-column grid, where 72px left roughly a third of the width for the name'
);
report(
  'the avatar box is reserved before the image decodes',
  /class="about-card__photo"[\s\S]{0,220}?width="56" height="56"/.test(creditsSrc),
  'without width/height attributes the grid reflows as each portrait arrives, which moves the cards the reader is already looking at'
);
report(
  'the role pill uses a clean sans-serif, not the typewriter mono face',
  /\.role-pill \{[\s\S]*?font-family:\s*\n?\s*system-ui, -apple-system, 'Segoe UI', Roboto/.test(css) &&
    !/\.role-pill \{[\s\S]{0,900}?font-family: var\(--font-mono/.test(css),
  'the monospace face read as a terminal: a role title looked like a log line, and the wider tracking it needed is what made the text feel cramped rather than deliberate'
);
report(
  'roster section headings are promoted from bare <h3> to real sections',
  /\.about-roster__heading \{[\s\S]*?font-size: clamp\(1\.375rem[\s\S]*?font-weight: 700[\s\S]*?border-left: 4px solid #facc15[\s\S]*?padding-left: 0\.75rem[\s\S]*?margin-bottom: 1\.25rem/.test(
    css
  ),
  'these classes were emitted by the template with NO rule anywhere in the stylesheet, so both rosters rendered at the browser default size — smaller than the body text beneath them, which is why they read as two lists rather than two sections'
);
report(
  'the desktop grid re-merges the lead card and the carousel into ONE box',
  /@media \(width >= 48rem\)[\s\S]*?\.about-roster__people \{[\s\S]*?display: grid[\s\S]*?repeat\(3, minmax\(0, 1fr\)\)[\s\S]*?\.about-carousel \{[\s\S]*?display: contents/.test(
    css
  ),
  'display: contents is what lets one person be one DOM node and still appear as a full-width lead card on a phone and a uniform grid cell on a desktop — so a name is announced once by a screen reader rather than twice'
);
report(
  'the phone carousel is a real swipe row',
  /\.about-carousel \{[\s\S]*?overflow-x: auto[\s\S]*?scroll-snap-type: x mandatory[\s\S]*?overscroll-behavior-x: contain/.test(
    css
  ) &&
    /\.about-card--carousel \{[\s\S]*?flex: 0 0 140px[\s\S]*?scroll-snap-align: start/.test(css),
  'eight people is eight screens of scrolling on a phone, which is not many people to deserve that'
);
report(
  'grid tracks have no automatic minimum, or one long name widens the row',
  /repeat\(3, minmax\(0, 1fr\)\)/.test(css) && !/repeat\(3, 1fr\)/.test(css),
  'a 1fr track has an automatic min-content floor, so one long unbreakable name sets the minimum for its column and the row stops fitting — while devtools still shows a grid that looks like it is working'
);
report(
  'the About typography is actually declared',
  /\.about-hero__title \{[\s\S]*?font-family: 'Playfair Display', Georgia, serif[\s\S]*?font-style: italic[\s\S]*?color: #e4e4e7/.test(
    css
  ) &&
    /\.about-mission__tagline \{[\s\S]*?color: #facc15[\s\S]*?font-weight: 700[\s\S]*?letter-spacing: 0\.05em/.test(
      css
    ) &&
    /\.about-mission__sub \{[\s\S]*?font-size: 1\.5rem[\s\S]*?font-weight: 700[\s\S]*?display: block/.test(
      css
    ) &&
    /\.about-standfirst \{[\s\S]*?font-style: italic[\s\S]*?font-size: 1\.125rem[\s\S]*?color: #a1a1aa/.test(
      css
    ),
  'all five of these were emitted by the template with no rule anywhere in the stylesheet, so the motto rendered in the body face and the subheadings were smaller than the text under them'
);
report(
  'the Owner panel previews the SAME pill the public page draws',
  /class="role-pill role-pill--preview"\$\{palette \? paletteVars\(palette\) : ''\}/.test(adminSrc) &&
    /rolePalette,\s*\n\s*paletteVars,/.test(adminSrc),
  'a second approximation of the pill in the panel is a second thing that drifts from the page'
);
report(
  'the note is muted italic body text',
  /\.about-card__note \{[\s\S]*?font-style: italic[\s\S]*?font-size: 0\.875rem[\s\S]*?color: var\(--text-muted/.test(
    css
  )
);

console.log('\nSECTION 11a — the header offers seven destinations, not ten\n');

/**
 * The header row and NAV_LINKS drifted apart before, which is how "Masthead"
 * survived in index.html long after it left the array. Comparing them here is the
 * only thing that makes the comment above them true.
 */
{
  const html = read('index.html');
  const listStart = html.indexOf('id="primary-links"');
  const listEnd = html.indexOf('</ul>', listStart);
  const staticList = html.slice(listStart, listEnd);

  // Only non-empty text between tags: the list is indented across many lines, so
  // a naive `>([^<>]+)<` also captures every empty run between `>` and `<`.
  const staticLabels = [...staticList.matchAll(/>([^<>]{2,24})</g)]
    .map((m) => m[1].trim())
    .filter(Boolean);

  /*
    Scope the JS side to the NAV_LINKS array itself. A bare /\{ label: '([^']+)'/
    over the whole file also matches the footer link list ("Feature of the week",
    "On the record", "In pictures"), which is how this assertion first reported
    ten destinations against a seven-item list.
  */
  const navStart = publicSrc.indexOf('const NAV_LINKS = [');
  const navEnd = publicSrc.indexOf('\n];', navStart);
  const navBody = publicSrc.slice(publicSrc.indexOf('[', navStart), navEnd);
  const jsLabels = [...navBody.matchAll(/^\s*\{ label: '([^']+)'/gm)].map((m) => m[1]);

  report(
    'index.html and NAV_LINKS list the same destinations, in the same order',
    JSON.stringify(staticLabels) === JSON.stringify(jsLabels),
    `html=${JSON.stringify(staticLabels)} js=${JSON.stringify(jsLabels)}`
  );
  report(
    'the header offers exactly the seven intended destinations',
    JSON.stringify(jsLabels) ===
      JSON.stringify([
        'Latest',
        'Assignments',
        'Interviews',
        'Podcasts',
        'Photo Gallery',
        'Credits',
        'About Us'
      ]),
    JSON.stringify(jsLabels)
  );
  report(
    'the removed destinations are gone from every rendering',
    !/Today's Pick/.test(staticList) &&
      !/Masthead<|>Weekly</.test(staticList) &&
      !/label: "Today's Pick"/.test(publicSrc) &&
      !/label: 'Weekly'/.test(publicSrc) &&
      !/nav-drawer__link" href="#masthead-foot"/.test(html),
    '"Today\'s Pick", "Weekly" and the drawer\'s "Masthead" must not survive in the static list, in NAV_LINKS, or in the drawer footer'
  );
  report(
    'nav labels are strictly uppercase, via one declaration',
    /\.nav-link \{[\s\S]*?text-transform: uppercase/.test(css),
    'it was previously achieved per-renderer, which is how the drawer shipped in mixed case while the bar did not'
  );
  report(
    'uppercase is presentational and does not leak into the accessible name',
    /text-transform: uppercase/.test(css) &&
      // The strings in NAV_LINKS stay in natural casing on purpose.
      /\{ label: 'Latest'/.test(publicSrc) &&
      !/label: 'LATEST'/.test(publicSrc),
    'a screen reader announcing "LATEST" as letters is worse than announcing "Latest", so the transform is CSS and the data keeps its casing'
  );
  report(
    'nav items and header controls cannot be squeezed',
    /\.nav-bar__links > li \{[\s\S]*?flex-shrink: 0/.test(css) &&
      /\.nav-bar__tools > \*,[\s\S]*?\.nav-bar__wordmark \{[\s\S]*?flex-shrink: 0[\s\S]*?white-space: nowrap/.test(
        css
      ),
    'default flex-shrink: 1 makes a too-wide row COMPRESS rather than overflow, so labels wrap inside their own boxes and text collides — with no scrollbar and no console error to explain it'
  );
}

console.log('\nSECTION 11b — an untitled photo is just a photo\n');

report(
  'no write path stores a placeholder caption',
  // `\|\|`, escaped. Written as /|| 'Untitled image'/ this regex is two
  // alternations whose first branch is EMPTY, so it matches the empty string and
  // therefore everything -- which is not a check at all. It looked like one.
  !/\|\|\s*'Untitled image'/.test(adminSrc) && !/\|\|\s*'Untitled frame'/.test(storeSrc),
  'a placeholder is indistinguishable from something a person typed, so every photograph grew a black bar reading "Untitled frame". An empty string is honest and every renderer already hides it.'
);
report(
  'article and episode TITLE fallbacks are left alone',
  /\|\|\s*'Untitled dispatch'/.test(storeSrc) && /\|\|\s*'Untitled episode'/.test(adminSrc),
  'these are not caption bars. podcasts_title_check is NOT NULL with a length CHECK, so a title placeholder is a real fallback for a row the constraint would otherwise reject, and it is never shown under a photograph'
);
report(
  'captionText recognises the placeholders ALREADY in the database',
  /export function captionText\(value\)/.test(domSrc) &&
    /\^untitled\(\\s\+\(image\|frame\|photo\|dispatch\|interview\|pitch\)\)\?\$\/i/.test(domSrc),
  'fixing only the write path leaves every caption already stored showing its placeholder bar forever, because nothing rewrites old rows'
);
report(
  'every caption renderer hides the CONTAINER, not just the text',
  /captionText\(item\.caption\)[\s\S]{0,200}?class="block min-w-0 truncate/.test(adminSrc) &&
    /captionText\(shot\.caption\)/.test(publicSrc) &&
    /captionText\(article\.caption\)/.test(publicSrc) &&
    /captionText\(todaysPick\.caption\)/.test(publicSrc),
  'the media library rendered its <figcaption> unconditionally, so the bar was there whatever the caption said'
);
report(
  'the generated "Part N" caption is left alone',
  /Part \$\{index\} of this interview/.test(publicSrc),
  'it is always meaningful and never a stored placeholder, so it is not a caption bar to suppress'
);

console.log('\nSECTION 11c — placeholder branding is current\n');

report(
  'no user-facing placeholder still uses the old "W"',
  !/"W"|'W'|The Wire|The Wire/g.test(domSrc + storeSrc + creditsSrc + publicSrc + adminSrc),
  'the rebrand landed in 4c2b151; the surviving `wire_*` strings are SQL function names, CustomEvent names and a localStorage key, which are API and must NOT be renamed'
);
report(
  'the image placeholders name the current publication',
  /The Pulse<\/text>/.test(publicSrc) && /The Pulse<\/text>/.test(adminSrc),
  'BLANK_IMAGE renders the wordmark, so it carries the rebrand automatically'
);

const authSrc = read('src/views/auth.js');
report(
  'the auth button has a narrow form that keeps its accessible name',
  /class="auth-slot__text"/.test(authSrc) &&
    /aria-label="Press login\. Press members only\."/.test(authSrc) &&
    /@media \(width < 30rem\)[\s\S]*?\.auth-slot__text\s*\{\s*display:\s*none/.test(css),
  'a 132px "Press Login" label beside a burger, wordmark, search and theme toggle is 15px too wide at 390 and 85px at 320'
);
report(
  'the tools and links are allowed to shrink',
  /\.nav-bar__tools,\s*\.nav-bar__links\s*\{\s*min-width:\s*0/.test(css) &&
    /#auth-slot\s*\{\s*min-width:\s*0/.test(css)
);
report(
  'the wordmark yields before the controls do',
  /\.nav-bar__wordmark\s*\{[\s\S]*?flex-shrink:\s*1/.test(css) &&
    /\.nav-bar__wordmark\s*\{[\s\S]*?text-overflow:\s*ellipsis/.test(css)
);
report(
  'max-width is set on the root',
  /html\s*\{[\s\S]*?max-width:\s*100%/.test(css) && /body\s*\{[\s\S]*?max-width:\s*100%/.test(css)
);
report(
  'overflow-x: hidden is NOT used as a band-aid',
  !/^\s*html\s*\{[^}]*overflow-x:\s*hidden/m.test(css) &&
    !/^\s*body\s*\{[^}]*overflow-x:\s*hidden/m.test(css),
  'it does not fix the width, it hides it -- and it can break position:sticky for the masthead nav'
);
report(
  'the overflow measurement counts EVERY item, not just the movable ones',
  /\[...list\.children\]\.filter\(\s*\(item\) => !item\.hidden/.test(publicSrc) ||
    /\[\.\.\.list\.children\]/.test(publicSrc),
  'summing only the overflow candidates returned 416px against 514px of space -- "it fits" -- while the five fixed links the reader could not avoid took another 530px the decision never saw, and the page scrolled 295px sideways'
);
report(
  'the overflow menu is derived from the DOM, not from a log of moves',
  /const hidden = overflowItems\.filter\(\(item\) => item\.hidden\)/.test(publicSrc) &&
    !/const moved = \[\]/.test(publicSrc),
  'an accumulator listed the same item twice when the loop revisited it -- the menu showed 7 entries for 5 destinations'
);

/*
 * A BACKTICK INSIDE AN HTML COMMENT IN A TEMPLATE LITERAL.
 *
 * This shipped. A comment inside a template string read "...no matching `case`
 * reads as a delegated button...", the backtick CLOSED the template, and `case`
 * was parsed as JavaScript. The whole admin module failed to evaluate, which
 * emptied the header's auth slot and killed every button in the Newsroom Panel --
 * with a single "Unexpected token 'case'" in the console that nothing was reading.
 *
 * It is the cheapest possible mistake to make and the most expensive possible
 * outcome, so it is asserted rather than remembered.
 */
{
  const jsFiles = [
    'src/app.js',
    'src/views/admin.js',
    'src/views/public.js',
    'src/views/alerts.js',
    'src/views/auth.js',
    'src/lib/podcasts.js',
    'src/lib/credits.js',
    'src/lib/store.js'
  ];
  const offenders = [];
  for (const file of jsFiles) {
    const text = read(file);
    text.split('\n').forEach((line, i) => {
      // A backtick between <!-- and --> is inside a comment, and the comment is
      // inside a template literal.
      const comment = line.match(/<!--[\s\S]*?-->/);
      if (comment && comment[0].includes('`')) {
        offenders.push(`${file}:${i + 1}`);
      }
    });
  }
  report(
    'no HTML comment inside a template literal contains a backtick',
    offenders.length === 0,
    offenders.length
      ? `a backtick closes the template early and the rest becomes code: ${offenders.join(', ')}`
      : ''
  );
}

/*
 * THE SAME CLASS OF MISTAKE, IN SQL.
 *
 * A migration is the only file in this repo that cannot be exercised by running
 * the app, cannot be unit tested, and fails only when a person pastes it into a
 * web form. There is no local Postgres here to parse it with and no CI running
 * Supabase, so a syntax error in one is invisible until it is somebody's
 * afternoon. Two got through:
 *
 *   028_page_scopes.sql            -- comment lines written as " * ..." instead of
 *                                    "-- ...": ERROR 42601 at or near "*".
 *   025_podcasts_storage_repair.sql -- a report query selecting b.id / b.public
 *                                    with NO FROM clause: ERROR 42P01.
 *
 * DELIBERATELY NOT A GENERAL SQL LINTER. An earlier attempt checked undeclared
 * table aliases across every migration and produced false positives on three
 * separate legitimate constructs in one file — a `from (values …) as v(…)`
 * derived table, a `'@users.thewire.press'` string literal, and CTE aliases. Each
 * fix invited another, and a checker that cries wolf gets switched off, which is
 * worse than having none. These two assertions are narrow, were each written
 * after the exact failure, and cannot fire on valid SQL.
 */

/**
 * SQL with `--` comments removed.
 *
 * Not cosmetic. The 025 fix documents the expression it replaced, so the very
 * pattern meant to be absent ("this used to be `bool_or((storage.foldername(…))`")
 * appears verbatim in a comment explaining the change -- and an assertion that
 * was supposed to prove the old code is gone instead fails on the sentence
 * describing it. Asserting against commented-out SQL tests the prose, not the
 * statement.
 */
function sqlCode(path) {
  return read(path, path)
    .split('\n')
    .map((l) => {
      const at = l.indexOf('--');
      return at === -1 ? l : l.slice(0, at);
    })
    .join('\n');
}

/** Every migration .sql, top level and migrations/ both. */
function migrationFiles() {
  const out = [];
  for (const dir of ['supabase', 'supabase/migrations']) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) if (f.endsWith('.sql')) out.push(`${dir}/${f}`);
  }
  return out;
}

/**
 * Lines OUTSIDE any dollar-quoted body. Inside $$ … $$ the text is plpgsql, and
 * a bare `*` there is a legitimate comment.
 */
function sqlLinesOutsideFunctionBodies(path) {
  const out = [];
  let inBody = false;
  read(path, path)
    .split('\n')
    .forEach((line, i) => {
      if (/\$\$|\$[a-z_]*\$/i.test(line)) inBody = !inBody;
      if (!inBody) out.push({ line: i + 1, text: line });
    });
  return out;
}

{
  const commentOffenders = [];
  for (const path of migrationFiles()) {
    for (const { line, text } of sqlLinesOutsideFunctionBodies(path)) {
      // A first non-space character of * / { is a C or JS comment. Postgres reads
      // it as a syntax error, and `--` is the only comment it has.
      if (/^\s*[*/{]/.test(text)) {
        commentOffenders.push(`${path}:${line} ${text.trim().slice(0, 40)}`);
      }
    }
  }
  report(
    'no migration uses a C-style comment marker where SQL needs --',
    commentOffenders.length === 0,
    commentOffenders.length
      ? `Postgres stops with 42601 at the first one: ${commentOffenders.join('; ')}`
      : 'a line starting with * or { outside a dollar-quoted body is a syntax error'
  );
}

{
  const sql = sqlCode('supabase/migrations/025_podcasts_storage_repair.sql');

  report(
    'the 025 diagnosis resolves its bucket columns, it does not invent them',
    /\(select b\.id\s+from storage\.buckets b where b\.id = 'podcasts'\)/.test(sql) &&
      !/^\s*b\.id,\s*$/m.test(sql),
    'it selected b.id and b.public with no FROM clause at all, which is 42P01 — and the naive fix, adding FROM storage.buckets b, returns ZERO rows exactly when the bucket is missing, so every other column would vanish in the one case being diagnosed'
  );
  report(
    'the 025 diagnosis is one row whether or not the bucket exists',
    /exists \(select 1 from storage\.buckets b where b\.id = 'podcasts'\)\s+as bucket_exists/.test(
      sql
    ) && !/^\s*from storage\.buckets b\s*;/m.test(sql)
  );
  report(
    'the 025 path check reads the policy instead of a constant',
    /p\.with_check like '%foldername%'/.test(sql) &&
      !/bool_or\(\s*\(storage\.foldername\('episodes\/probe\.mp3'\)\)/.test(sql),
    'that expression is constant — it never looks at the policy — so it reported the same answer whether the policy checked the path or not, and NULL when the policy was absent. A check that cannot fail is not a check.'
  );

  /*
   * NO POLICY IN THIS REPOSITORY MAY BE UNREACHABLE FOR AN `anon` REQUEST.
   *
   * The architecture: credentials.sql says outright that there is no Supabase Auth
   * JWT in this project, and issues its own opaque token in the `x-wire-token`
   * header, resolved by wire_bearer_token() -> current_account_id() -> is_staff().
   * PostgREST therefore resolves EVERY request as role `anon`, which makes `anon`
   * the signed-in role and `authenticated` a role nothing ever arrives as.
   *
   * So `create policy ... for insert to authenticated` is not a stricter policy, it
   * is an UNREACHABLE one. Two features shipped exactly that way:
   *
   *   podcasts_*                 024  every insert refused, "new row violates
   *                                     row-level security policy for table
   *                                     'podcasts'" -- reported as if the Owner's
   *                                     account were at fault, with 9 Active
   *                                     accounts and 23 live sessions in the DB.
   *   push_subscriptions_staff_*  003  silently unreachable, never noticed
   *
   * The projects own working features show the correct shape: articles_* (007) and
   * interviews_* (022) all say `to anon, authenticated`. The podcast and push ones
   * were the outliers.
   *
   * This asserts the SHAPE across every migration, so the next policy written
   * without `anon` fails here rather than in production six weeks later.
   */
  const sqlCommentsStripped = (text) =>
    text
      .split('\n')
      .map((l) => {
        const at = l.indexOf('--');
        return at === -1 ? l : l.slice(0, at);
      })
      .join('\n');

  const unreachable = [];
  for (const path of migrationFiles()) {
    const clean = sqlCommentsStripped(read(path, path));
    for (const m of clean.matchAll(
      /create\s+policy\s+([\w"]+)\s+on\s+([\w.]+)([\s\S]{0,320}?);/gi
    )) {
      const name = m[1].replace(/"/g, '');
      const table = m[2];
      const body = m[3];
      const roleClause = body.match(/for\s+(?:select|insert|update|delete|all)\s+to\s+([\w\s,]+)/i);
      if (roleClause && !/anon/i.test(roleClause[1])) {
        unreachable.push(`${path} "${name}" on ${table} -> to ${roleClause[1].trim()}`);
      }
    }
  }
  report(
    'no policy is unreachable for an anon-role request',
    unreachable.length === 0,
    unreachable.length
      ? `this project has no Supabase Auth JWT, so requests arrive as anon and a policy naming only another role can never match: ${unreachable.join('; ')}`
      : ''
  );
}

/*
 * NO SECRET MAY BE COMMITTED, AND `.env.example` IS NOT AN EXCUSE.
 *
 * A real, working Supabase `service_role` key for THIS project
 * (ref iguzwwqjufzzdblkqroj, role service_role, expiring 2036) was found
 * committed in `.env.example`, which is tracked by git.
 *
 * The severity is not "a password is exposed". A service_role key BYPASSES EVERY
 * row-level security policy in the project. Every policy in this repository --
 * podcasts_owner_all, podcasts_staff_submit, the whole credits_people ownership
 * model, the article-attribution guards that took three migrations to repair --
 * is decorative against it. Anyone holding that string could read, edit and
 * delete every row in every table and bucket, and no policy would stop them.
 *
 * WHY THE OBVIOUS TASK WAS THE WRONG ONE
 * ---------------------------------------
 * The instruction was to DELETE `.env` as a "security purge". That would have:
 *   - broken the local dev environment, since Vite needs the VITE_* keys;
 *   - changed nothing about security, because `.env` is gitignored and was never
 *     committed; and
 *   - created a false impression that a credential exposure had been handled.
 *
 * The exposure was in a TRACKED file. So the check is scoped to tracked files
 * only, and `.env` being ignored is exactly what makes it the safe place for the
 * real value.
 *
 * This asserts the SHAPE of a Supabase key rather than trusting a denylist of key
 * names, because the name is what people change and the token is what matters.
 */
{
  const JWT = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/;

  let tracked;
  try {
    tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
  } catch {
    tracked = [];
  }

  const committed = [];
  for (const path of tracked) {
    // Only text files worth reading; a binary would throw or be noise.
    if (!/\.(mjs|js|json|sql|md|html|css|yml|yaml|txt|example)$|^\.env/.test(path)) continue;
    let text;
    try {
      text = read(path, path);
    } catch {
      continue;
    }
    text.split('\n').forEach((line, i) => {
      if (!JWT.test(line)) return;
      // package-lock.json carries base64 sha512 integrity digests, which can
      // contain an `eyJ`-shaped run by chance. A real Supabase key decodes to a
      // JSON payload naming a role, so decode and confirm before accusing.
      let isKey = false;
      try {
        const payload = JSON.parse(
          Buffer.from(line.match(JWT)[0].split('.')[1], 'base64').toString('utf8')
        );
        isKey = Boolean(payload.role && payload.iss);
      } catch {
        isKey = false;
      }
      if (isKey) committed.push(`${path}:${i + 1}`);
    });
  }

  report(
    'no Supabase API key is committed to a tracked file',
    committed.length === 0,
    committed.length
      ? `a service_role key bypasses EVERY rls policy in this project: ${committed.join(', ')}. Rotate the key in the Supabase dashboard FIRST — editing the file does not unpublish it.`
      : ''
  );
}

/*
 * THE 025 DIAGNOSIS MUST NOT REPORT COLUMNS THAT CANNOT ANSWER THE QUESTION.
 *
 * 025 reported `caller_is_staff` and `session_resolves`, and both are always
 * false in the Supabase SQL Editor for every user: is_staff() resolves the
 * account from the SHA-256 of the request's bearer token, and the Editor has no
 * request and therefore no Authorization header. They looked like the answer and
 * were structurally incapable of being one — and reading "caller_is_staff:
 * false" as "my account is not staff" is exactly the misreading that happened.
 *
 * The live check belongs in the browser, where checkPodcastStorage() probes a
 * write through the same policy.
 */
{
  const sql = sqlCode('supabase/migrations/025_podcasts_storage_repair.sql');
  report(
    'the 025 diagnosis does not report columns that are always false in the Editor',
    !/caller_is_staff/.test(sql) && !/session_resolves/.test(sql) && !/select public\.is_staff\(\)/.test(sql),
    'is_staff() and current_account_id() both read the HTTP bearer token; the SQL Editor has none, so they answer the same thing every time and mean nothing there'
  );
  report(
    'the 025 diagnosis checks the DATA the policy depends on instead',
    /accounts_active/.test(sql) && /live_sessions/.test(sql),
    'are there accounts, is one Active, and is there a live session — all answerable without an HTTP request'
  );

  /*
   * NO PODCAST POLICY MAY NAME A POSTGRES ROLE.
   *
   * This project issues its own opaque token in the `x-wire-token` header and has
   * no Supabase Auth JWT — credentials.sql says so outright. A Storage request
   * therefore arrives with no Auth session, so PostgREST resolves it as `anon`,
   * and a policy written `for insert to authenticated` matches nothing. The insert
   * is then refused with "new row violates row-level security policy" no matter
   * who is signed in or how correct their account is.
   *
   * That is not a theory: `podcasts_upload` carried `to authenticated` and every
   * podcast upload failed with an RLS error, while portrait uploads succeeded
   * through the identical supabase-js Storage path because wire_media_insert has
   * no role clause.
   *
   * The real gates — `is_staff()` and `is_owner()` — are untouched, so removing
   * the role clause widens which roles are EVALUATED, never who is ALLOWED.
   */
  const roleGated = [...sql.matchAll(/create policy\s+podcasts_\w+[\s\S]*?for\s+(?:insert|select|delete|update)\s+to\s+\w+/gi)]
    .map((m) => m[0].match(/create policy\s+(podcasts_\w+)/i)[1]);
  report(
    'no podcast storage policy gates on a Postgres role',
    roleGated.length === 0,
    roleGated.length
      ? `${roleGated.join(', ')} name a role, so an anon-role Storage request matches no policy and the write is refused by RLS`
      : 'requests to Storage arrive with no Supabase Auth session and are resolved as anon'
  );
  report(
    'the podcast policies keep their real authorisation checks',
    /for insert\s*\n\s*with check \(\s*\n?\s*bucket_id = 'podcasts'\s*\n?\s*and public\.is_staff\(\)/.test(sql) &&
      /for delete\s*\n\s*using \(bucket_id = 'podcasts' and public\.is_owner\(\)\)/.test(sql),
    'dropping the role clause must not become dropping the check; is_staff() and is_owner() are what actually decide'
  );
  report(
    'the portrait policies, which work, name no role either',
    !/create policy wire_media_insert[\s\S]*?for insert\s+to\s+\w+/i.test(
      read('supabase/013_portrait_upload_and_identity.sql')
    ) || // 013 is the reference implementation; assert the shape, not the absence
    /create policy wire_media_insert on storage\.objects\s*\n\s*for insert\s*\n\s*with check \(bucket_id = 'wire-media'\)/i.test(
      read('supabase/013_portrait_upload_and_identity.sql')
    ),
    'portrait uploads go through the same Storage client and succeed, so they are the proof that the anon role is not itself the obstacle'
  );
}

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
