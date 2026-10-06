/**
 * Curation tab → front page, end to end.
 *
 * The Save button on `#curation-form` is the only path from the Owner's
 * arrangement of Today's Pick and the weekly slots to the public feed, and it
 * failed silently: no branch in the delegated submit listener meant the click
 * fell through to a native GET submit, reloaded the page, and discarded the
 * save before its promise resolved. `tests/curation.mjs` pins the wiring in
 * source; this walks the real button on a live demo server, because the bug
 * that shipped was behavioural, not textual:
 *
 *   1. the pick select shows the SAVED story (not the first option);
 *   2. clicking Save does NOT reload the page;
 *   3. Save confirms with its toast and the new pick survives the repaint;
 *   4. closing the panel re-sorts the front page — the chosen story leads;
 *   5. the "This Week In The Pulse" band switch hides the whole section (plus
 *      its nav links) and brings it back with the curation untouched.
 *
 * Demo mode only — this never touches the live database.
 *   node node_modules/vite/bin/vite.js --mode demo --port 5201
 *   BASE_URL=http://localhost:5201/ node scripts/curation-check.mjs
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:5201/';
const PASS = process.env.TEST_PASS || 'password123';
const OWNER = process.env.TEST_OWNER || 'chief.owner';

/**
 * The store module URL THE APP ACTUALLY LOADED.
 *
 * `await import('/src/lib/store.js')` looks like it reaches the running app's
 * store, and it does not. Vite serves each module with a cache-busting query --
 * `/src/lib/store.js?t=1791309669512`, derived from a browser hash it persists
 * to disk -- so the app's copy and a bare `/src/lib/store.js` are two different
 * URLs and therefore two different module instances, each with its own private
 * `state`.
 *
 * The symptom is brutal to diagnose from the assertion alone: the test reads a
 * store the app has never touched, sees stale curation data, and reports that the
 * save did not work, while the DOM and the rendered front page both show the
 * save DID work. Every assertion below that reads store state went green the
 * moment the dev server was freshly started -- the hash then matched the plain
 * path -- and red again after any edit invalidated it. A harness that passes or
 * fails on when the server was started is not testing anything.
 *
 * So resolve the URL from the page's own resource log and import THAT. One
 * module instance, whichever query Vite happens to be serving today.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<string>}
 */
async function appStoreUrl(page) {
  return page.evaluate(() => {
    const loaded = performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .find((name) => /\/src\/lib\/store\.js(\?|$)/.test(name));
    return loaded || '/src/lib/store.js';
  });
}

const results = [];
const problems = [];
function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`);
}

async function signIn(page, username) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(700);
  await page.evaluate(() => {
    document.querySelector('[data-action="open-auth"], #open-auth')?.click();
  });
  await page.waitForTimeout(400);
  await page.fill('#auth-signin-login', username);
  await page.fill('#auth-signin-password', PASS);
  await page.locator('#auth-form-signin button[type="submit"]').click();
  await page.waitForTimeout(1400);
}

/** Open the newsroom panel and switch to one tab. */
async function openAdmin(page, tab) {
  await page.evaluate(() => {
    document.querySelector('[data-action="open-admin"], #open-admin')?.click();
  });
  await page.waitForTimeout(900);
  await page.click(`[data-admin-tab="${tab}"]`);
  await page.waitForTimeout(700);
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (e) => problems.push(`[curation] ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`[curation] ${m.text()}`);
  });

await signIn(page, OWNER);
await openAdmin(page, 'curation');

// Resolved AFTER the app has booted, because it is read from the resource log
// the app itself produced. See appStoreUrl() for why this cannot be a constant.
const storeUrl = await appStoreUrl(page);


  /* --- 1. the tab renders the form and its four selects ------------------ */
  check('the Curation tab renders #curation-form', Boolean(await page.$('#curation-form')));
  const slotCount = await page.$$eval('#curation-form select[data-slot]', (els) => els.length);
  check(
    'the form offers the pick select plus three weekly slots',
    slotCount === 4,
    `${slotCount} select(s)`
  );

  const before = await page.evaluate(async (url) => {
    const store = await import(url);
    return {
      storedPick: store.getState().todaysPickId,
      shownPick: document.querySelector('#slot-todays-pick')?.value
    };
  }, storeUrl);
  check(
    'the pick select shows the SAVED story, not the first option',
    Boolean(before.storedPick) && before.storedPick === before.shownPick,
    `saved ${before.storedPick}, shown ${before.shownPick}`
  );

  /* --- 2. curate a different pick and weekly slot ------------------------ */
  const choice = await page.$eval('#slot-todays-pick', (sel) => {
    const other = [...sel.options].find((o) => o.value !== sel.value);
    return other ? { value: other.value, text: other.textContent.trim() } : null;
  });
  const slotChoice = await page.$eval('#slot-article', (sel) => {
    const other = [...sel.options].find((o) => o.value !== sel.value);
    return other ? { value: other.value, text: other.textContent.trim() } : null;
  });
  check('a second story is available to curate', Boolean(choice));

  if (choice) {
    await page.selectOption('#slot-todays-pick', choice.value);
    if (slotChoice) await page.selectOption('#slot-article', slotChoice.value);
    await page.waitForTimeout(500);

    /* --- 3. the Save button must persist WITHOUT reloading the page ------- */
    // A marker on window survives a repaint and dies on a navigation: it is the
    // difference between "the save promise resolved" and "the page reloaded".
    await page.evaluate(() => {
      window.__curationSaveMarker = 'alive';
    });
    await page.click('#curation-form button[type="submit"]');
    await page.waitForTimeout(1500);

    const marker = await page.evaluate(() => window.__curationSaveMarker);
    check('Save does not trigger a native page reload', marker === 'alive', `marker=${marker}`);

    const toasts = await page.$$eval('.toast-stack .toast', (els) =>
      els.map((e) => e.textContent).join(' | ')
    );
    check(
      'Save confirms with the curation toast',
      toasts.includes('Front-page curation saved'),
      toasts.slice(0, 100)
    );

    const afterValue = await page.$eval('#slot-todays-pick', (el) => el.value);
    check('the new pick survives the repaint as the selected option', afterValue === choice.value);

    const stored = await page.evaluate(async (url) => {
      const store = await import(url);
      return store.getState().todaysPickId;
    }, storeUrl);
    check('the store holds the new pick', stored === choice.value, stored);

    /* --- 4. closing the panel re-sorts the front page --------------------- */
    await page.click('[data-action="close-admin"]');
    await page.waitForTimeout(1200);

    const lead = await page.$eval('#today h3 a', (el) => el.textContent.trim()).catch(() => '');
    check(
      'the front page leads with the chosen story',
      lead === choice.text,
      `lead "${lead}", wanted "${choice.text}"`
    );
  }

  /* --- 5. the "This Week In The Pulse" band toggle ------------------------- */
  // The panel was closed in step 4, so the homepage is on screen and the band
  // must be visible: the flag ships enabled and a fresh browser context starts
  // from the seed.
  check('the band is on the homepage by default', Boolean(await page.$('#weekly')));

  const snapshot = await page.evaluate(async (url) => {
    const state = (await import(url)).getState();
    return {
      slots: JSON.stringify(state.weeklySlots),
      pick: state.todaysPickId,
      flag: state.showThisWeek
    };
  }, storeUrl);
  check('the store starts with the band enabled', snapshot.flag !== false);

  // Disable through the switch, then click Save — the payload path.
  await openAdmin(page, 'curation');
  check('the Curation tab carries the band switch', Boolean(await page.$('#curation-show-week')));
  await page.uncheck('#curation-show-week');
  await page.waitForTimeout(600); // autosave + repaint
  await page.click('#curation-form button[type="submit"]');
  await page.waitForTimeout(1000);
  await page.click('[data-action="close-admin"]');
  await page.waitForTimeout(1200);

  check('disabling omits the #weekly container entirely', (await page.$('#weekly')) === null);

  const navOff = await page.$$eval('a.nav-link[href="#weekly"]', (els) => els.map((l) => l.hidden));
  check(
    'the Weekly nav links hide with the band',
    navOff.length > 0 && navOff.every(Boolean),
    `${navOff.length} link(s)`
  );

  const afterOff = await page.evaluate(async (url) => {
    const state = (await import(url)).getState();
    return {
      slots: JSON.stringify(state.weeklySlots),
      pick: state.todaysPickId,
      flag: state.showThisWeek
    };
  }, storeUrl);
  check(
    'switching it off keeps the curation data intact',
    afterOff.flag === false && afterOff.slots === snapshot.slots && afterOff.pick === snapshot.pick
  );

  // Re-enable: the same curated articles, layout and organization must return.
  await openAdmin(page, 'curation');
  const persistedOff = await page.$eval('#curation-show-week', (el) => el.checked);
  check('the switch persisted its off state through the repaint', persistedOff === false);
  await page.check('#curation-show-week');
  await page.waitForTimeout(600);
  await page.click('#curation-form button[type="submit"]');
  await page.waitForTimeout(1000);
  await page.click('[data-action="close-admin"]');
  await page.waitForTimeout(1200);

  const bandBack = await page.$('#weekly');
  check('re-enabling restores the section', Boolean(bandBack));

  if (bandBack) {
    const cards = await page.$$eval('#weekly .grid > *', (els) => els.length);
    check('all three curated cards are back', cards === 3, `${cards} card(s)`);

    const heading = await page.$eval('#weekly-heading', (el) => el.textContent.trim());
    check('the band heading is intact', heading.toLowerCase() === 'this week in the pulse', heading);

    const kicker = await page
      .$eval('#weekly .accent-text', (el) => el.textContent.trim())
      .catch(() => '');
    check(
      'the "curated by the owner" sub-header is intact',
      kicker.toLowerCase() === 'curated by the owner',
      kicker
    );
  }

  const navBack = await page.$$eval('a.nav-link[href="#weekly"]', (els) => els.map((l) => l.hidden));
  check(
    'the Weekly nav links come back too',
    navBack.length > 0 && navBack.every((h) => h === false),
    `${navBack.length} link(s)`
  );

  const afterOn = await page.evaluate(async (url) => {
    const state = (await import(url)).getState();
    return {
      slots: JSON.stringify(state.weeklySlots),
      pick: state.todaysPickId,
      flag: state.showThisWeek
    };
  }, storeUrl);
  check(
    're-enabling changes nothing but the flag',
    afterOn.flag === true && afterOn.slots === snapshot.slots && afterOn.pick === snapshot.pick
  );

  await page.close();
} finally {
  await browser.close();
}

if (problems.length) {
  console.log('\n=== console / page errors ===');
  problems.forEach((p) => console.log(`  ${p}`));
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} curation checks passed`);

if (failed.length || problems.length) {
  console.log('\nFAILED:');
  failed.forEach((f) => console.log(`  - ${f.name}  ${f.detail}`));
  process.exit(1);
}
console.log('RESULT: PASS');
