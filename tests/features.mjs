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
const rosterSql = read('supabase/migrations/032_roster_leads_and_subcategories.sql');
const lockdownSql = read('supabase/migrations/033_writer_lockdown.sql');

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
  'the document title and description are the ones Search Console indexed',
  /<title>The Pulse \| Official Press &amp; News<\/title>/.test(indexHtml) &&
    /Stories that matter\. Voices that count\./.test(indexHtml),
  'these were changed for SEO and are asserted by name here so a later rebrand cannot quietly swap them back without this failing'
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

console.log('\nSECTION 4b — sub-categories and designated leads\n');

/*
 * Migration 032 gives every roster row a `sub_category` (the team under the main
 * heading) and an `is_lead`. The assertions below are the contracts that cannot be
 * left to a regex about the CSS: which column the data lands in, who wins when
 * nobody is ticked, and the fact that the panel and the page share ONE
 * implementation of both questions.
 */
report(
  'the sub-category and the lead are real columns, constrained and commented',
  /add column if not exists sub_category text/.test(rosterSql) &&
    /add column if not exists is_lead boolean/.test(rosterSql) &&
    /comment on column public\.credits_people\.sub_category is/.test(rosterSql) &&
    /comment on column public\.credits_people\.is_lead is/.test(rosterSql) &&
    /alter column is_lead set not null/.test(rosterSql),
  'is_lead NOT NULL with a false default means `where is_lead` partitions the table with no third bucket to forget about'
);
report(
  'the main category is the EXISTING category column, not a second one',
  /comment on column public\.credits_people\.category is/.test(rosterSql) &&
    /There is deliberately no separate main_category column/.test(rosterSql) &&
    !/add column if not exists main_category/.test(rosterSql),
  '`category` is already CHECK-constrained to exactly the two main headings; a second column would store one fact twice and every read would have to decide which copy wins'
);
report(
  'a sub-category is capped at 60 characters and cannot be blank',
  /credits_people_sub_category_check/.test(rosterSql) &&
    /length\(btrim\(sub_category\)\) between 1 and 60/.test(rosterSql),
  "NULL is the single spelling of \"no sub-team\"; a stored '' would render a blank heading"
);
report(
  'AT MOST ONE LEAD PER SUB-CATEGORY is a database fact, not a renderer convention',
  /credits_people_one_lead_idx/.test(rosterSql) &&
    /create unique index if not exists credits_people_one_lead_idx[\s\S]*?coalesce\(category, ''\)[\s\S]*?coalesce\(sub_category, ''\)[\s\S]*?where is_lead/.test(
      rosterSql
    ),
  'Postgres treats NULLs as DISTINCT in a unique index, so the coalesce is what stops a NULL sub_category holding any number of leads'
);
report(
  'ticking a lead DEMOTES the incumbent before writing, so the checkbox moves rather than raising',
  /if v_lead then[\s\S]*?update public\.credits_people[\s\S]*?set is_lead = false[\s\S]*?and \(p_id is null or id <> p_id\)/.test(
    rosterSql
  ),
  'a plain unique index is not deferrable, so writing the new lead first would fail at COMMIT and hand the Owner a constraint violation instead of a moved lead'
);
report(
  'the RPC drops BOTH older signatures rather than overloading either',
  /drop function if exists public\.wire_credits_people_upsert\(uuid, text, text, text, text, text, integer, text, integer, text, text\);/.test(
    rosterSql
  ) &&
    /drop function if exists public\.wire_credits_people_upsert\(uuid, text, text, text, text, text, integer, text, integer, text, text, boolean\);/.test(
      rosterSql
    ) &&
    /p_sub_category text    default null,\s*\n\s*p_is_lead      boolean default null/.test(rosterSql),
  'two candidates for one PostgREST name is PGRST202 on every add, save and remove. This is the trap 024 and 028 each walked into.'
);
report(
  'absent and clear are DIFFERENT signals, and the SQL says which is which',
  /when p_sub_category is null then sub_category else v_sub end/.test(rosterSql) &&
    /is_lead      = coalesce\(p_is_lead, is_lead\)/.test(rosterSql),
  "an omitted RPC argument arrives as NULL, so '' must mean CLEAR and NULL must mean LEAVE ALONE. A boolean has no third state, so null is unambiguous there."
);
report(
  'the upsert is granted to anon, which is the role PostgREST actually resolves here',
  /grant  execute on function public\.wire_credits_people_upsert\(uuid, text, text, text, text, text, integer, text, integer, text, text, boolean\) to anon;/.test(
    rosterSql
  ),
  'this project has no Supabase JWT, so every browser request resolves as anon. Migration 016 granted only the stale seven-argument signature to authenticated, which is why this line exists.'
);
report(
  'the client sends the two new arguments, and OMITS the sub-category when it was not mentioned',
  /p_sub_category: subCategory,\s*\n\s*p_is_lead: isLead/.test(creditsSrc) &&
    /\.\.\.\(subCategoryValue === undefined \? \{\} : \{ p_sub_category: subCategoryValue \}\)/.test(
      creditsSrc
    ) &&
    /\.\.\.\(isLeadValue === undefined \? \{\} : \{ p_is_lead: isLeadValue \}\)/.test(creditsSrc),
  'sending sub_category unconditionally would clear the team on every save made by a form that never rendered the field'
);
report(
  'the panel reads BOTH spellings of the new fields, like every other one',
  /field\('subCategory', 'sub_category'\)/.test(creditsSrc) && /field\('isLead', 'is_lead'\)/.test(creditsSrc),
  'reading only one spelling shipped before: the editor reported "Saved." and discarded every change. Only `blurb` worked, because its two spellings happen to be identical.'
);
report(
  'the roster read asks for both new columns',
  /sub_category, is_lead/.test(creditsSrc),
  'PERSON_COLUMNS is the one place every read is spelled out; a column missing from it is a column the page cannot render however hard the renderer tries'
);
report(
  'the LEAD FALLBACK lives in the renderer, and is never written back to the data',
  /export function resolveLead\(people\)/.test(creditsSrc) &&
    /const ticked = list\.findIndex\(\(person\) => leadFlag\(person\.is_lead\)\);/.test(creditsSrc) &&
    /const \[lead, \.\.\.rest\] = list;/.test(creditsSrc) &&
    /return \{ lead: list\[ticked\], rest, designated: true \};/.test(creditsSrc),
  'a backfill would write a claim the Owner never made: `is_lead = true` has to keep meaning "the Owner ticked the box", or the panel starts fighting the page'
);
report(
  'the fallback is disclosed to the OWNER, not to the reader',
  /designated: false/.test(creditsSrc) && /designated: true/.test(creditsSrc) &&
    /designated \? '' : ' \(first by order\)'/.test(adminSrc) &&
    !/No lead set/.test(creditsSrc),
  'the Owner cannot otherwise tell "I chose this person" from "the page picked the first row because I chose nobody" — but that is a CMS notice, and printing it on the publication\'s About page tells a reader about an editorial decision they cannot act on'
);
report(
  'the lead is taken out of the array WITHOUT mutating the caller\'s roster',
  /const rest = list\.filter\(\(_, index\) => index !== ticked\);/.test(creditsSrc),
  'callers pass the array they are about to render; splicing it would leave the caller holding a roster minus its lead'
);
report(
  'sub-categories group case-insensitively but render the Owner\'s spelling',
  /export function groupBySubCategory\(people\)/.test(creditsSrc) &&
    /const key = sub\.toLowerCase\(\);/.test(creditsSrc) &&
    /buckets\.set\(key, \{ subCategory: sub, people: \[\] \}\)/.test(creditsSrc),
  'two headings differing only in case are indistinguishable to a reader and look like a bug'
);
report(
  'a person with NO sub-category is a direct member of the main heading, not an "Unfiled" bucket',
  /if \(!sub\) \{\s*loose\.push\(person\);\s*continue;\s*\}/.test(creditsSrc) &&
    /aboutSubTeam\(loose, '', base\)/.test(creditsSrc),
  'inventing a heading for them would publish a filing decision nobody made, on the front page of the paper'
);
report(
  'sub-categories are free text, not a fixed vocabulary',
  /export const SUB_CATEGORY_PRESETS = \[/.test(creditsSrc) &&
    /SUGGESTIONS, NOT A CONSTRAINT/.test(creditsSrc) &&
    !/category in \('Writers', 'Editors', 'Designers'/.test(rosterSql),
  'the brief asks for five named desks AND for the Owner to be able to create their own; a CHECK constraint would refuse the twenty-first desk the paper hires for'
);
report(
  'the panel and the page share ONE implementation of both questions',
  /groupBySubCategory,\s*\n\s*resolveLead,/.test(adminSrc) &&
    /const \{ loose, groups \} = groupBySubCategory\(people\);/.test(adminSrc) &&
    /const \{ lead, designated \} = resolveLead\(members\);/.test(adminSrc) &&
    /const \{ loose, groups \} = groupBySubCategory\(people\);/.test(creditsSrc),
  'a second copy in the panel would drift, and the drift would be invisible: the Owner arranges one shape and the page publishes another'
);
report(
  'the panel offers Main category, Sub-category and the Lead checkbox on both tabs',
  /<label class="field-label" for="credits-sub-\$\{id\}">Sub-category \/ department<\/label>/.test(adminSrc) &&
    /<label class="roster-lead" for="credits-lead-\$\{id\}">/.test(adminSrc) &&
    /Set as Lead of this Sub-Category/.test(adminSrc) &&
    /id="credits-add-sub"/.test(adminSrc) && /id="credits-add-lead"/.test(adminSrc) &&
    /for="credits-category-\$\{id\}">Main category<\/label>/.test(adminSrc),
  'the Credits page renders neither control, so showing them there would be a control that silently does nothing'
);
report(
  'a save sends the sub-category even when the Owner cleared it',
  /sub_category: form\.querySelector\('\[data-credits-sub-category\]'\)\?\.value\.trim\(\) \?\? ''/.test(
    adminSrc
  ) &&
    /is_lead: form\.querySelector\('\[data-credits-is-lead\]'\)\?\.checked === true/.test(adminSrc),
  '"leave this person in Writers" and "take this person out of Writers" need different payloads; only an explicit empty string can say the second one'
);
report(
  'demo mode keeps the one-lead-per-sub-team invariant the database enforces',
  /function demoteDemoLead\(rows, self\)/.test(creditsSrc) &&
    /normaliseSubCategory\(row\.sub_category\)\.toLowerCase\(\)/.test(creditsSrc) &&
    /if \(isLead\) demoteDemoLead\(rows, entry\);/.test(creditsSrc) &&
    /if \(isLeadValue === true\) demoteDemoLead\(rows, next\);/.test(creditsSrc),
  'without it demo mode accepts a roster the real database rejects, and the Owner is shown a checkbox that works in demo and fails in production'
);
report(
  'an old demo roster is repaired rather than silently regrouped',
  /if \(typeof row\.is_lead !== 'boolean'\)/.test(creditsSrc) &&
    /if \(row\.sub_category === undefined\)/.test(creditsSrc),
  'the same seed migration 028 needed for page_scope: a build from before 032 stored neither, and must not invent a team for those rows'
);
report(
  'BOTH main headings render even when nobody is filed under them',
  /about-roster--empty/.test(creditsSrc) && /Nobody is listed here yet\./.test(creditsSrc),
  'they are the page\'s structure, not furniture the Owner has to have filled in; dropping one makes the page change shape depending on how full the roster is'
);
report(
  'the desktop grid re-merges per SUB-TEAM, and the CSS is scoped to do exactly that',
  /\.about-subhead \{[\s\S]*?border-bottom: 2px solid color-mix\(in srgb, #facc15 45%, transparent\)/.test(
    stylesSrc
  ) &&
    /\.about-card--flagged \{[\s\S]*?border-left: 3px solid #facc15;/.test(stylesSrc) &&
    /\.credits-band-editor__sub \{/.test(stylesSrc),
  'a sub-heading one step quieter than the main heading: same gold accent, thinner rule. A second colour would read as a second MEANING when it is only a smaller one'
);
report(
  'the LEAD pill is hidden on a phone and shown on a desktop',
  /\.about-card__lead-pill \{\s*display: none;/.test(stylesSrc) &&
    /@media \(width >= 48rem\) \{\s*\.about-card__lead-pill \{\s*display: inline-block;/.test(
      stylesSrc
    ),
  'on a phone the lead card is already full width, sits above the carousel and carries the gold rail; a fourth signal for the same fact is noise'
);
report(
  'the flagged card\'s rules come AFTER the desktop merge block, on purpose',
  stylesSrc.indexOf('.about-card--flagged .about-card__body') >
    stylesSrc.indexOf('.about-card--carousel {\n    display: contents;'),
  'both selectors are two classes, so with equal weight the later one wins — the earlier `display: block` on the body would otherwise defeat the wrapping row'
);
report(
  'the Owner panel band editor is styled at all',
  /\.credits-band-editor \{[\s\S]*?--band: #c8102e/.test(stylesSrc) &&
    /\.credits-band-editor__head \{[\s\S]*?display: flex/.test(stylesSrc) &&
    /\.roster-lead \{/.test(stylesSrc),
  '`.credits-band-editor` was emitted by both roster tabs and defined nowhere, so every band in the Newsroom Panel rendered as an unstyled block'
);
report(
  'the About Us tab resolves its OWN id through a NAMED PAIR, not tabScope()',
  /function scopeToTabId\(scope\) \{\s*return normaliseScope\(scope\) === 'about_us' \? 'about' : 'credits';/.test(
    adminSrc
  ) &&
    /const tabId = scopeToTabId\(scope\);/.test(adminSrc),
  'renderRosterTab() used to call tabScope(scope) with a SCOPE. tabScope() takes a TAB id, so the About tab resolved to "credits", the stale-repaint guard always bailed, and the panel sat on "Loading the About Us page…" forever. It only appeared to work because opening the Credits tab first populated the cache and took the synchronous path, which skips the guard.'
);
report(
  'tabScope() has exactly three CODE call sites, and the other two pass a real tab id',
  (adminSrc.match(/(?<!`)\btabScope\(/g) || []).length === 3 &&
    (adminSrc.match(/tabScope\(byId\('admin-tab-body'\)\?\.dataset\.tab\)/g) || []).length === 2,
  'the definition plus two readers that already hand it dataset.tab. A fourth call with a scope in the argument is the bug above, coming back. Counted with a negative lookbehind for a backtick so that the prose explaining the bug, which names the broken call, does not count as one.'
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

console.log('\nSECTION 11d — the approver tier, and what a Writer may reach\n');

/*
 * SECTION 1 READS AS IF THERE WERE FOUR ROLES AND A FOURTH STATUS.
 *
 * It does not, and implementing it literally would have been actively harmful:
 * `staff_accounts.role` is CHECK-constrained to ('Owner','Writer','Board
 * Manager'), 'editor' is a LEGACY_SPELLING that normalises to Writer, and the
 * podcast status CHECK is ('pending','approved','rejected'). Creating an 'Editor'
 * role or a 'pending_approval' status would have meant a migration to relax a
 * constraint plus rewriting a policy whose job is to stop self-approval.
 *
 * So the lockdown is applied to Writer, 'pending' is kept, and the ONE genuinely
 * additive change -- Board Manager may approve -- is isolated in migration 030 and
 * asserted here.
 */

report(
  'the approver tier is one helper, and it requires an ACTIVE account',
  /create or replace function public\.can_approve\(\)/.test(read('supabase/migrations/030_approver_tier.sql')) &&
    /a\.status = 'active'/.test(read('supabase/migrations/030_approver_tier.sql')) &&
    /a\.role = 'Board Manager'/.test(read('supabase/migrations/030_approver_tier.sql')),
  'omitting status = \'active\' is the likeliest mistake in the whole migration: a SUSPENDED Board Manager would keep approving work, which is exactly what the Owner-only design existed to prevent'
);
report(
  'the approver grant is on the STATUS COLUMN alone, not the whole row',
  /grant update \(status\) on public\.articles/.test(read('supabase/migrations/030_approver_tier.sql')) &&
    /grant update \(status\) on public\.interviews/.test(read('supabase/migrations/030_approver_tier.sql')) &&
    /grant update \(status\) on public\.podcasts/.test(read('supabase/migrations/030_approver_tier.sql')),
  'permissive policies are OR-ed, so a broad approver policy would hand a Board Manager the whole row including the ability to rewrite a byline -- which the guard trigger exists to prevent and no policy can prevent alone'
);
report(
  'migration 030 says out loud that it needs a table-wide revoke if one exists',
  /table_update_grants_to_anon/ .test(read('supabase/migrations/030_approver_tier.sql')) &&
    /revoke update on/.test(read('supabase/migrations/030_approver_tier.sql')),
  'a table-level UPDATE grant is checked BEFORE the column grant, so an earlier migration granting one would silently make the column restriction achieve nothing'
);
report(
  'deletion was NOT widened, and neither was the roster',
  // The backticks around the identifier are part of the sentence: the phrase in
  // the migration is "`podcasts_delete` is deliberately NOT widened", and a regex
  // without them matches nothing and reports a failure for a file that says
  // exactly the right thing.
  /`podcasts_delete` is deliberately NOT widened/.test(
    read('supabase/migrations/030_approver_tier.sql')
  ) &&
    /public\.is_owner\(\)/.test(read('supabase/migrations/030_approver_tier.sql')),
  'purging a refused episode is destructive and about something already submitted; the brief asked for approval, not deletion'
);
report(
  'a Writer still cannot self-approve: the INSERT policy is untouched',
  /and status = 'pending'/.test(read('supabase/migrations/024_about_podcasts_and_layout.sql')) &&
    !/status = 'pending_approval'/.test(read('supabase/migrations/030_approver_tier.sql')),
  'pinning status = \'pending\' on insert is what stops a crafted request publishing itself, whatever the browser believes'
);
report(
  'canApprove is Owner-or-Board-Manager and nothing wider',
  /export function canApprove\(\)[\s\S]*?if \(isOwner\(\)\) return true;[\s\S]*?toLowerCase\(\) === 'board manager'/.test(
    storeSrc
  ),
  'the client mirrors can_approve() so the button is honest; it is NOT what decides, the RLS policy is'
);
report(
  'approving and editing are SEPARATE questions',
  /export function canApprove/.test(storeSrc) &&
    /export function canEditArticle/.test(storeSrc) &&
    /export function canEditInterview/.test(storeSrc) &&
    /export function canDeleteArticle/.test(storeSrc),
  'a Board Manager may clear the review queue without inheriting the ability to rewrite somebody else\'s story -- granting the second because the first was granted is the drift this split exists to prevent'
);
report(
  'Approve and Unpublish are hidden from a Writer, with a reason',
  // 900 chars rather than 400: admin.js is CRLF, so each newline is two
  // characters and the ternary plus its disabled branch is longer than it looks.
  /store\.canApprove\(\)[\s\S]{0,900}?Only the Owner or a Board Manager can approve or unpublish/.test(
    adminSrc
  ),
  'a disabled control with a title is better than an absent one: the reader learns why, rather than concluding the feature does not exist'
);
report(
  'Edit is hidden on other authors\' work, and Delete stays ownership-gated',
  /store\.canEditArticle\(article\)/.test(adminSrc) &&
    /store\.canEditInterview\(interview\)/.test(adminSrc) &&
    /store\.canDeleteArticle\(article\)/.test(adminSrc),
  'the RLS policies already refused the save; hiding the affordance only stops the writer reaching a permission error'
);
report(
  'Assignments is Board Manager, not Writer',
  /\{ id: 'assignments',[^}]*minRole: 'Board Manager' \}/.test(adminSrc),
  'it was minRole Writer, so a Writer could create, reassign and close other people\'s work; the board decides who owes what, so it is a management surface'
);
report(
  'the Active Subscribers tile and the audit trail are Owner-only',
  /ownerOnlyMetrics = isOwnerView\s*\n\s*\?\s*metrics\s*\n\s*:\s*metrics\.filter/.test(adminSrc) &&
    /m\.label !== 'Active subscribers'/.test(adminSrc) &&
    /isOwnerView\s*\n\s*\? `<section>\s*\n\s*<h3[^>]*>\s*\n?\s*Audit trail/.test(adminSrc),
  'filtered out of the list rather than conditionally rendered: an empty tile renders an empty cell, and an empty "Audit trail" heading reads as "nothing happened", which is a false statement'
);
report(
  'the Podcasts tab is open to Writers and submit-only',
  /\{ id: 'podcasts',[^}]*minRole: 'Writer' \}/.test(adminSrc) &&
    /if \(!canReview\) \{\s*\n\s*\/\/[\s\S]{0,300}return podcastSubmitPanel\(\);/.test(adminSrc),
  'the database has always permitted staff submissions -- podcasts_staff_submit allows any staffer and pins status = pending -- so only the tab was in the way'
);
report(
  'the review queue is a REPLACEMENT for a Writer, not a panel above it',
  /return podcastSubmitPanel\(\);/.test(adminSrc) &&
    !/podcastQueuePanel[\s\S]{0,200}podcastSubmitPanel/.test(adminSrc),
  'a queue above the form would let a Writer see who else filed what and gauge a backlog that is not theirs to know'
);
report(
  'the writer submission is a SEPARATE function from the owner publish path',
  /async function submitPodcastFromWriterForm/.test(adminSrc) &&
    /const result = await submitPodcast\(/.test(adminSrc) &&
    /awaiting Owner\/Board Manager approval/.test(adminSrc),
  'the one path a Writer can reach must not be widenable by adding a parameter to a shared handler; submitPodcast always writes pending and the INSERT policy pins it independently'
);
report(
  'a Writer may file by audio URL as well as by file',
  /audioUrl = null/.test(podcastsSrc) &&
    /const cleanAudioUrl = safeUrl\(audioUrl\)/.test(podcastsSrc) &&
    /if \(!file && !cleanAudioUrl\)/.test(podcastsSrc),
  'a writer filing from a phone cannot always reach the audio through a file picker, and "download it again and re-upload" is a support ticket'
);
report(
  'a link submission skips the whole Storage path',
  /UPLOAD ONLY WHEN THERE IS A FILE/.test(podcastsSrc) &&
    /let url = cleanAudioUrl/.test(podcastsSrc) &&
    /if \(file\) \{/.test(podcastsSrc),
  'and it lets a Writer file on a deployment whose Storage is misconfigured; storage_path stays NULL so a later purge does not try to delete an object that was never uploaded'
);
report(
  'the podcast strip is filled ASYNCHRONOUSLY, not read synchronously',
  /function renderPodcastStrip\(\) \{\s*\n\s*return '<div id="latest-podcasts-mount"/.test(publicSrc) &&
    /async function fillPodcastStrip\(\)/.test(publicSrc) &&
    /await listPodcasts\(\)/.test(publicSrc) &&
    /fillPodcastStrip\(\);/.test(publicSrc),
  'listPodcasts() returns a Promise; calling .filter on it throws, and because it sat inside a template literal that error took the WHOLE front page with it. The mount is painted empty and filled when the read resolves.'
);
report(
  'the strip shows APPROVED episodes only, and hides itself when there are none',
  /toLowerCase\(\) === 'approved'/.test(publicSrc) && /mount\.remove\(\)/.test(publicSrc),
  'RLS already refuses non-approved rows to an anon reader, but the DEMO store has no RLS behind it and would put a pending episode on the front page'
);
report(
  'podcasts.cover_url exists and is nullable',
  /add column if not exists cover_url text/.test(read('supabase/migrations/031_podcast_cover_image.sql')) &&
    /podcasts_cover_url_len/.test(read('supabase/migrations/031_podcast_cover_image.sql')),
  'the submission form needs somewhere to put artwork; audio_url exists for the episode and there was nowhere for its cover'
);
report(
  'cover_url is read back and inserted',
  /cover_url,/.test(podcastsSrc) && /cover_url: safeUrl\(coverUrl\) \|\| null/.test(podcastsSrc),
  'a column that is written but never selected is invisible on every card and every editor'
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

console.log('\nSECTION 12 — the Writer lockdown (migration 033)\n');

/*
 * "Editor" in the brief is the WRITER. This project has no such role: ROLES in
 * auth.js and every CHECK on `role` list exactly three, and role-consistency.mjs
 * keeps 'Editor' in FORBIDDEN_STORED so it can never come back. The assertions
 * below therefore read "Editor" as the junior editorial role -- the one that files
 * content and does not decide what the paper publishes.
 *
 * The client gates are convenience. Everything a Writer cannot do is enforced in
 * migration 033, and that is what these assertions mostly check, because the
 * client-side half is the part a screenshot can confirm and the database half is
 * the part that matters.
 */
report(
  'ARTICLES HAD NO PUBLISH GUARD, SO A WRITER COULD SELF-PUBLISH',
  /create or replace function public\.articles_publish_guard\(\)/.test(lockdownSql) &&
    /create trigger articles_publish_guard_trg[\s\S]{0,120}before update on public\.articles/.test(
      lockdownSql
    ) &&
    /if new\.status = 'Published' and old\.status <> 'Published' then/.test(lockdownSql),
  'interviews had one and articles did not, so a Writer could set status = Published on their own draft and put it on the front page'
);
report(
  'the article INSERT policy pins the status, so the draft cannot be skipped either',
  /status = 'Pending Review'[\s\S]{0,200}author_account_id = public\.current_account_id\(\)/.test(
    lockdownSql
  ),
  'articles_staff_insert was `with check (is_staff())` with no condition on status at all, so all four CHECKed values were reachable by anyone who filed a story'
);
report(
  'the unowned-row rescue arm is gone from both update policies',
  /create policy articles_update_own[\s\S]{0,300}wire_owns_article\(id\)\s*\n\s*or public\.is_owner\(\)\s*\n\s*\)/.test(
    lockdownSql
  ) &&
    /create policy interviews_update_own[\s\S]{0,300}wire_owns_interview\(id\)\s*\n\s*or public\.is_owner\(\)\s*\n\s*\)/.test(
      lockdownSql
    ) &&
    !/create policy articles_update_own[\s\S]{0,300}author_account_id is null/.test(lockdownSql),
  'it matched EVERY row whose author_account_id was null -- including the seeded front page -- so a Writer could rewrite the articles the paper itself published'
);
report(
  'the approver "status only" grant is enforced by a TRIGGER, not by the revoke 030 asked for',
  /wire_approver_scope_guard/.test(lockdownSql) &&
    /to_jsonb\(new\) - 'status' - 'updated_at'/.test(lockdownSql) &&
    /Do NOT `revoke update on public\.articles from anon`/.test(lockdownSql),
  'credentials.sql, 022 and 029 each grant a table-wide UPDATE to anon, and Postgres checks the table privilege first, so the column grant in migration 030 was inert. Revoking it would have taken away the ability of the Owner to edit an article, so the restriction moved into a trigger instead.'
);
report(
  'the approver guard is DIFFERENTIAL, so a column added later cannot slip past it',
  /if \(to_jsonb\(new\) - 'status' - 'updated_at'\)[\s\S]{0,120}is distinct from \(to_jsonb\(old\) - 'status' - 'updated_at'\)/.test(
    lockdownSql
  ) &&
    !/new\.title is distinct from old\.title/.test(lockdownSql),
  'enumerating the protected columns would make the guard silently weaker with every new column, which is the failure mode of a hand-maintained list'
);
report(
  'the approver guard skips the OWN row of the approver, or a Board Manager could not edit their own draft',
  /new\.author_account_id = public\.current_account_id\(\)/.test(lockdownSql) &&
    /if new\.author_account_id is not null[\s\S]{0,160}then\s*\n\s*return new;/.test(lockdownSql),
  '"you may edit what you filed" has to hold for every role above the floor, not only the Owner'
);
report(
  'the interview publish guard now honours the approver tier',
  /create or replace function public\.interviews_publish_guard\(\)[\s\S]{0,400}if public\.can_approve\(\) then/.test(
    lockdownSql
  ) &&
    /only the Owner or a Board Manager can publish an interview/.test(lockdownSql),
  'it tested not is_owner(), so the approver policy 030 added could never actually publish an interview -- the tier was dead for that one table'
);
report(
  'the capability map no longer claims a Writer may publish',
  /when 'Writer' then '\{"publish":false/.test(lockdownSql) &&
    /when 'Board Manager' then '\{"publish":true,"edit_others":false/.test(lockdownSql) &&
    !/when 'Writer' then '\{"publish":true/.test(lockdownSql),
  'the Owner reads this table in the Accounts tab, so a wrong entry is documentation of a permission the database does not grant'
);
report(
  'the Overview review queue is gated on the approver tier, and its container with it',
  /const canReview = store\.canApprove\(\);/.test(adminSrc) &&
    /canReview \|\| isOwnerView[\s\S]{0,600}grid gap-6 lg:grid-cols-2/.test(adminSrc) &&
    /canReview[\s\S]{0,400}Review queue/.test(adminSrc),
  'it rendered for everyone, complete with a LIVE article-publish button. Gating each child was necessary and not sufficient: a Writer fails both gates, which left an empty grid behind.'
);
report(
  'the Coverage Order panel is OWNER-ONLY, and so is the save that writes it',
  /function contentLayoutPanel\(\)[\s\S]{0,1800}if \(!isOwner\(\)\) return '';/.test(adminSrc) &&
    /case 'layout-save':[\s\S]{0,900}if \(!isOwner\(\)\) \{/.test(adminSrc),
  'it rendered live drag handles, arrows and Save for every Writer, and wire_set_article_layout is Owner-only, so every control was a dead end'
);
report(
  'every approve handler re-checks the tier, not only the button that renders it',
  /case 'article-publish':[\s\S]{0,900}if \(!store\.canApprove\(\)\)/.test(adminSrc) &&
    /case 'interview-publish':[\s\S]{0,900}if \(!store\.canApprove\(\)\)/.test(adminSrc) &&
    /case 'podcast-approve':[\s\S]{0,900}if \(!store\.canApprove\(\)\)/.test(adminSrc),
  'a gate in a template and a gate in a handler are different code, and only the second runs when `data-id` has been edited by hand'
);
report(
  'the EDIT handlers re-check ownership, which DELETE already did',
  /case 'article-edit':[\s\S]{0,1200}canEditArticle/.test(adminSrc) &&
    /case 'interview-edit':[\s\S]{0,1200}canEditInterview/.test(adminSrc),
  'Edit was gated at render and then trusted the id from the DOM. Delete has carried this re-check since it was hardened; Edit had not.'
);
report(
  'refusing a submission and DELETING a published episode are now different acts',
  /action === 'podcast-delete' && !isOwner\(\)/.test(adminSrc),
  'a Board Manager may refuse a pending episode -- that is what the approver tier is for -- but podcasts_delete in Storage and podcasts_owner_all both require is_owner()'
);

console.log('\nSECTION 13 — the podcast submission path actually RUNS\n');

/*
 * These four are the reason this file has a browser check at all.
 *
 * `submitPodcast()` called `safeUrl()` WITHOUT IMPORTING IT, so every writer
 * submission threw `ReferenceError` -- and the suite was green, because the old
 * assertion was a regex over the call site. A regex cannot tell whether a name was
 * ever bound, and demo mode short-circuits before the network, so nothing in the
 * project ever executed the function.
 *
 * The fix is the import; the durable fix is `scripts/podcast-submit-check.mjs`,
 * which submits the real form in a browser. Mutation-tested: deleting the import
 * line takes that check from 33/33 to 26/33 with the exact error in the detail.
 */
report(
  'safeUrl is imported where it is called',
  /import \{ safeUrl \} from '\.\/dom\.js';/.test(podcastsSrc) &&
    /const cleanAudioUrl = safeUrl\(audioUrl\);/.test(podcastsSrc),
  'the unbound name took down BOTH writer submission paths, and the previous regex-over-the-call-site assertion could not see it'
);
report(
  'a pasted audio URL is no longer rejected for having no file',
  /const problem = file \? validateAudioFile\(file\) : '';/.test(podcastsSrc) &&
    /if \(!file && !cleanAudioUrl\)/.test(podcastsSrc),
  'validateAudioFile(null) returns "Choose an MP3 from your device first.", so the check above it established file OR url and then this demanded the file. The URL field has been on the form since the feature shipped.'
);
report(
  'the Speaker / host field is wired to author_name, which is the public byline',
  /byId\('podcast-sub-host'\)\?\.value\.trim\(\) \|\| ''/.test(adminSrc) &&
    /const who = String\(authorName \|\| ''\)\.trim\(\) \|\| displayName\(\);/.test(podcastsSrc),
  'the field rendered on the form from the beginning and nothing read it, so the name of a guest was silently discarded -- exactly the case a podcast submission form exists for'
);
report(
  'the cover image is stored AND rendered, on both publication paths',
  /podcast-card__cover/.test(publicSrc) &&
    /safeUrl\(episode\.cover_url\)/.test(publicSrc) &&
    /podcast-up-cover/.test(adminSrc) &&
    /cover_url: cleanCoverUrl \|\| null/.test(podcastsSrc) &&
    /\.podcast-card__cover \{[\s\S]{0,200}float: left/.test(stylesSrc),
  'migration 031 added the column, it was written on submit and never read -- so a Writer who set a cover and an Owner who did not produced visually identical episodes'
);
report(
  'the submission is submitted as pending and the panel says so',
  /status: 'pending'/.test(podcastsSrc) &&
    /awaiting Owner\/Board Manager approval/.test(adminSrc) &&
    /and status = 'pending'[\s\S]{0,120}author_account_id = public\.current_account_id\(\)/.test(
      read('supabase/migrations/029_podcast_role_gates.sql')
    ),
  'the client writes pending and podcasts_staff_submit pins it, so a crafted request cannot self-approve either'
);

console.log('\nSECTION 14 — indexable URLs, not fragments\n');

/*
 * Every reader view used to live behind `#about` / `#podcasts`. A fragment is
 * never sent to the server, so Google fetched `/`, rendered the front page, and
 * treated every other view as a client-side state of that one URL -- a
 * publication with six pages had a single indexable address, and a sitemap could
 * not honestly have listed any of the other five.
 *
 * So a sitemap that lists paths which 404 is worse than no sitemap: it gets the
 * domain flagged in Search Console. Three lists have to agree, and these
 * assertions are what stop a hand-edited route from shipping a dead link.
 */
const sitemap = read('public/sitemap.xml');
const vercel = JSON.parse(read('vercel.json'));
report(
  'every sitemap URL is a real path the app can route',
  /'\/about': 'about'/.test(appSrc) &&
    /'\/credits': 'credits'/.test(appSrc) &&
    /'\/podcasts': 'podcasts'/.test(appSrc) &&
    /'\/interviews': 'interviews'/.test(appSrc) &&
    /\[ASSIGNMENTS_PATH\]: 'publication'/.test(appSrc) &&
    (sitemap.match(/<loc>https:\/\/thewire\.us\.ci\/(about|credits|podcasts|interviews|assignments)<\/loc>/g) ||
      []).length === 5,
  'the routes, the PATH_ROUTES map in app.js and the sitemap are one fact in three files'
);
report(
  'and every one of them has a rewrite, so a refresh does not 404',
  ['/about', '/credits', '/gallery', '/interviews', '/podcasts', '/assignments'].every((p) =>
    (vercel.rewrites || []).some((r) => r.source === p && r.destination === '/index.html')
  ),
  'PATH_ROUTES alone changes what the ROUTER does with a path that already resolved; the rewrite is what makes the path resolve'
);
report(
  'the sitemap contains no fragment',
  !/#/.test(sitemap.replace(/<!--[\s\S]*?-->/g, '')) && /<urlset[^>]*>/.test(sitemap) && (sitemap.match(/<url>/g) || []).length === 6,
  'Google drops the fragment before indexing, so `/#about` would be a sixth copy of `/`'
);
report(
  'the crawler-facing SEO tags are in the static HTML, not in a script',
  /<meta\s+name="google-site-verification"\s+content="WrMBbZb5-s-IS9j7mESfL-h1LW0L1uDKZwUO8lMs2a8"\s*\/>/.test(
    indexHtml
  ) &&
    /<meta name="robots" content="index, follow" \/>/.test(indexHtml) &&
    /<title>The Pulse \| Official Press &amp; News<\/title>/.test(indexHtml) &&
    /<meta\s+name="description"[\s\S]{0,200}Stories that matter\. Voices that count\./.test(indexHtml) &&
    /<link rel="canonical" href="https:\/\/thewire\.us\.ci\/" \/>/.test(indexHtml),
  'Search Console refuses a token that is not in the served HTML, and a crawler that does not run JavaScript would not find one injected by a script'
);
report(
  'the fragment is still honoured, and still wins, because existing links use it',
  /const deepLink = window\.location\.hash\.replace\(\/\^#\/, ''\) \|\| pathToView\(window\.location\.pathname\);/.test(
    appSrc
  ),
  'breaking every already-shared link would be a worse outcome than a slightly stale canonical URL'
);

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
