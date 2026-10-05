/* ==============================================================================
   tests/curation.mjs — Curation tab → front-page feed
   ------------------------------------------------------------------------------
   Runs in bare Node against the REAL modules and the REAL source files, so a
   refactor that breaks a guarantee fails here instead of on a reader's phone.

   The bug this file was written for: the Curation tab's Save button did
   nothing. `#curation-form` had no branch in the delegated submit listener, so
   the click fell through to a native GET submit — the page reloaded before any
   save promise could resolve, the Owner's arrangement was discarded, and the
   front page kept its old order. Three defects sat underneath it:

     • the change handler routed on `curate-*` ids the renderer never emits;
     • the selects never marked the SAVED value `selected`, so every repaint
       showed the first option and a Save overwrote the real pick with it;
     • renderPublication resolved curation pointers through helpers that fall
       back to `articles[0]` of ANY status, so unpublishing the lead never
       re-sorted the page.

   Run:  node tests/curation.mjs
   ========================================================================== */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* --------------------------------------------------------------------------
   Demo mode persists to localStorage, which does not exist in bare Node.
   The store catches the ReferenceError and warns on every write, which would
   bury real failures under stack traces. A minimal in-memory stub keeps the
   persistence path exercised and the output readable.
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

const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const adminSrc = read('src/views/admin.js');
const publicSrc = read('src/views/public.js');
const appSrc = read('src/app.js');
const storeSrc = read('src/lib/store.js');
const schemaSrc = read('supabase/schema.sql');
const migrationSrc = read('supabase/migrations/023_show_this_week.sql');

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
  console.log(`\n${title}`);
}

/* ==========================================================================
   1. store — saveCuration
   ======================================================================== */

section('store — saveCuration round trip');

const published = store.listPublishedArticles();
report(
  'the seed carries published stories to curate',
  published.length >= 2,
  `${published.length} published`
);

const [first, second] = published;

await store.saveCuration({
  todaysPickId: first.id,
  weeklySlots: { article: first.id, event: second.id, picture: second.id }
});

report('the pick lands in state', store.getState().todaysPickId === first.id);
report(
  'all three weekly slots land in state',
  store.getState().weeklySlots.article === first.id &&
    store.getState().weeklySlots.event === second.id &&
    store.getState().weeklySlots.picture === second.id
);

/* The Save button submits all four selects at once, but the change handler
   writes one slot at a time — the merge must keep the others. */
await store.saveCuration({ weeklySlots: { article: second.id } });
report(
  'a one-slot write keeps the other slots',
  store.getState().weeklySlots.article === second.id &&
    store.getState().weeklySlots.event === second.id &&
    store.getState().weeklySlots.picture === second.id
);

/* An empty select is saved as null, never as '': the column behind
   todays_pick_id is a uuid and Postgres rejects an empty string. */
await store.saveCuration({ todaysPickId: null });
report('an empty pick is stored as null', store.getState().todaysPickId === null);

/* The feed only repaints because a save notifies subscribers. If commit()
   ever stops notifying, the front page goes stale silently. */
let notified = 0;
const unsubscribe = store.subscribe(() => {
  notified += 1;
});
await store.saveCuration({ todaysPickId: first.id });
unsubscribe();
report(
  'a save notifies subscribers so the feed can re-render',
  notified > 0,
  `${notified} notification(s)`
);

section('store — the homepage band flag (showThisWeek)');

report('the band is visible by default', store.getState().showThisWeek === true);

const slotsSnapshot = JSON.stringify(store.getState().weeklySlots);
const pickSnapshot = store.getState().todaysPickId;

await store.saveCuration({ showThisWeek: false });
report(
  'switching the band off leaves the curation untouched',
  store.getState().showThisWeek === false &&
    JSON.stringify(store.getState().weeklySlots) === slotsSnapshot &&
    store.getState().todaysPickId === pickSnapshot
);

await store.saveCuration({ showThisWeek: true });
report(
  're-enabling restores the flag with slots and pick intact',
  store.getState().showThisWeek === true &&
    JSON.stringify(store.getState().weeklySlots) === slotsSnapshot &&
    store.getState().todaysPickId === pickSnapshot
);

await store.saveCuration({ todaysPickId: first.id });
report('a save that omits the flag leaves it alone', store.getState().showThisWeek === true);

await store.saveCuration({ showThisWeek: false });
await store.resetAllSettings();
report(
  'resetting settings restores the shipped default (visible)',
  store.getState().showThisWeek === true
);

/* ==========================================================================
   2. admin.js — the Save button and the form that feeds it
   ======================================================================== */

section('admin.js — the Save button actually routes');

report(
  'the delegated submit listener branches on #curation-form',
  /form\.id === 'curation-form'/.test(adminSrc)
);
report(
  'that branch prevents the default page reload',
  /form\.id === 'curation-form'\)[\s\S]{0,400}?event\.preventDefault\(\)/.test(adminSrc)
);
report('a saveCurationFromForm handler exists', /async function saveCurationFromForm\(/.test(adminSrc));
report(
  'the handler extracts the pick select out of the SUBMITTED form',
  /form\.querySelector\('#slot-todays-pick'\)/.test(adminSrc)
);
report(
  'the handler extracts every data-slot select into the payload',
  /form\.querySelectorAll\('select\[data-slot\]'\)/.test(adminSrc)
);
report(
  'the handler writes through store.saveCuration',
  /async function saveCurationFromForm[\s\S]{0,900}?store\.saveCuration\(/.test(adminSrc)
);

section('admin.js — the form shows and round-trips the saved state');

report('the pick select is rendered with its saved value', /optionsFor\(state\.todaysPickId\)/.test(adminSrc));
report(
  'the weekly selects are rendered with their saved values',
  /optionsFor\(state\.weeklySlots\[key\]\)/.test(adminSrc)
);
report('the option builder emits `selected`', /isSelected \? ' selected' : ''/.test(adminSrc));
report(
  'the Save button is a submit button inside #curation-form',
  /id="curation-form"[\s\S]{0,2500}?type="submit"/.test(adminSrc)
);

section('admin.js — change events route on data-slot, not dead ids');

report('the change handler routes curation selects on data-slot', /target\.dataset\.slot/.test(adminSrc));
report(
  'the dead curate-* id branches are gone from the handler',
  !/target\.id === 'curate-todays-pick'|target\.id\.startsWith\('curate-slot-'\)/.test(adminSrc)
);

section('admin.js — the homepage band switch');

report('the Curation form carries the band switch', /id="curation-show-week"/.test(adminSrc));
report(
  'the switch label matches the required wording',
  adminSrc.includes('Show &quot;This Week in the Wire&quot; on Homepage')
);
report(
  'toggling the switch autosaves through saveCuration',
  /target\.id === 'curation-show-week'\)[\s\S]{0,200}?saveCuration\(\{ showThisWeek: target\.checked \}\)/.test(
    adminSrc
  )
);
report('the Save button payload includes the switch', /showToggle\.checked/.test(adminSrc));
report(
  'the switch state is rendered back from the store on each paint',
  /type="checkbox" \$\{\s*state\.showThisWeek \? 'checked' : ''/.test(adminSrc)
);

/* ==========================================================================
   3. public.js / app.js — resolution + repaint chain
   ======================================================================== */

section('public.js — the feed resolves curation against published stories');

report(
  'renderPublication re-resolves pointers against the published list',
  /const curated = \(id\) => published\.find\(/.test(publicSrc)
);
report(
  'renderPublication no longer reads the status-blind getTodaysPick helper',
  !/store\.getTodaysPick\(\)/.test(publicSrc)
);
report(
  'renderPublication no longer reads the status-blind getWeeklySlot helper',
  !/store\.getWeeklySlot\(/.test(publicSrc)
);
report(
  'the pick is filtered out of the Latest Coverage grid',
  /published\.filter\(\(article\) => article\.id !== todaysPick\?\.id\)/.test(publicSrc)
);

section('the repaint chain after a save');

report(
  'closing the panel dispatches wire:settings-changed',
  /dispatchEvent\(new Event\('wire:settings-changed'\)\)/.test(adminSrc)
);
report(
  'app.js re-renders the public feed on that event',
  /window\.addEventListener\('wire:settings-changed'[\s\S]{0,300}?renderPublic\(\)/.test(appSrc)
);
report(
  'store commits repaint the feed whenever the panel is closed',
  /store\.subscribe\([\s\S]{0,800}?renderPublic\(\)/.test(appSrc)
);

section('public.js — the band is gated, not merely styled away');

report(
  'the weekly section only renders when the flag is not false',
  /showThisWeek !== false\s+\? `<section id="weekly"/.test(publicSrc)
);
report(
  'there is no unconditional #weekly section left in the template',
  (publicSrc.match(/<section id="weekly"/g) || []).length === 1
);
report(
  'the Weekly nav links are hidden together with the band',
  /querySelectorAll\('a\.nav-link\[href="#weekly"\]'\)/.test(publicSrc)
);

section('persistence — schema + migration 023');

report(
  'schema.sql declares show_this_week defaulted to true',
  /show_this_week\s+boolean not null default true/.test(schemaSrc)
);
report(
  'migration 023 adds the column idempotently, default true',
  /add column if not exists show_this_week boolean not null default true/.test(migrationSrc)
);
report(
  'migration 023 asks PostgREST to reload its schema cache',
  /notify pgrst, 'reload schema'/.test(migrationSrc)
);
report(
  'persistSettings writes show_this_week, treating undefined as enabled',
  /show_this_week: current\.showThisWeek !== false/.test(storeSrc)
);
report(
  'hydrate defaults a missing column to visible, not hidden',
  /settingsRow\.show_this_week \?\? true/.test(storeSrc)
);

/* ========================================================================== */
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  failures.forEach((label) => console.log(`  - ${label}`));
  process.exitCode = 1;
} else {
  console.log('RESULT: PASS — curation tab wiring and feed resolution are intact.');
}
