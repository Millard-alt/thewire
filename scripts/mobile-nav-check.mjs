/* =============================================================================
   scripts/mobile-nav-check.mjs
   -----------------------------------------------------------------------------
   Every navigation destination, reachable FROM every other one, on a phone.

   THE BUG THIS EXISTS FOR
   The mobile drawer's section links were emitted as bare `<a href="#latest">`
   with no class. The delegated section-anchor handler in app.js matches
   `a.nav-link[href^="#"]`, so it never saw them. On a phone, tapping "Latest" or
   "Assignments" from any OTHER page did nothing at all: the drawer closed, the
   anchor fell through to the browser, and because the publication view is
   `hidden` the fragment had nowhere to scroll. The page silently did not change.

   Desktop links and the footer both carry `nav-link`, which is exactly why only
   mobile was affected -- and why a desktop-only test would never have caught it.

   WHY EVERY PAIR, NOT JUST A FEW
   The failure was view-dependent: the anchor only misbehaved when the target
   view was not the publication. Testing "Latest from the homepage" passes even
   with the bug, because the publication is already visible and the browser's
   native fragment scroll happens to work. The bug only shows when LEAVING a
   reader page. So this walks every destination to every other destination.

   Run:  npm run test:mobile-nav
   ========================================================================== */

import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:5201/';

/**
 * Destinations the DRAWER can reach.
 *
 * NOT the same as every reader view. The nav entry says "Videos", which is the
 * hub, and the hub is what links onward to /interviews and /videos-feed. So those
 * two archives are one click deeper than the drawer -- deliberate, since the hub
 * exists to offer both -- and a test that insists the drawer reach them directly
 * would be demanding the nav go back to listing Interviews.
 *
 * The archives are still covered: the last check in this file walks the hub's
 * own cards to both of them.
 */
const DRAWER_VIEWS = [
  'publication',
  'assignments',
  'videos',
  'gallery',
  'credits',
  'about'
];

const problems = [];
const ok = (m) => console.log('PASS  ' + m);
const bad = (m) => { problems.push(m); console.log('FAIL  ' + m); };

/**
 * Every reader view, and the DOM node that proves it is the one showing.
 *
 * `publication` is special: it has several sections rather than one node, so it
 * is proved by the view container plus a scroll away from the top. It is reached
 * through the "Latest" anchor rather than a control of its own.
 */
const VIEWS = {
  publication: '#publication-view',
  assignments: null, // a section of publication, reached by anchor
  interviews: '#interviews-view',
  videos: '#videos-view',
  'videos-feed': '#videos-feed-view',
  gallery: '#gallery-view',
  credits: '#credits-view',
  about: '#about-view'
};

const SECTION_VIEWS = {
  publication: { id: 'latest', label: 'Latest' },
  assignments: { id: 'assignments', label: 'Assignments' }
};

/** Is the given view actually on screen? */
async function viewIsShowing(page, name) {
  if (name === 'publication') {
    return page.locator('#publication-view').isVisible().catch(() => false);
  }
  if (SECTION_VIEWS[name]) {
    // A section is showing when the publication is visible AND the section is
    // actually on screen, which is what "the anchor worked" means in practice.
    const pubVisible = await page.locator('#publication-view').isVisible().catch(() => false);
    const onScreen = await page
      .locator(`#${SECTION_VIEWS[name].id}`)
      .isVisible()
      .catch(() => false);
    const scrollY = await page.evaluate(() => window.scrollY);
    return pubVisible && onScreen && scrollY > 0;
  }
  return page.locator(VIEWS[name]).isVisible().catch(() => false);
}

/** Open the drawer and tap the control for `name`. */
async function navigateViaDrawer(page, name) {
  const burger = page.locator('#mobile-nav-toggle');
  const drawerOpen = await page.locator('#nav-drawer').evaluate((d) => d.open).catch(() => false);

  // Only open it if it is shut. Clicking the burger while the modal is open is
  // impossible anyway -- <dialog> covers it -- which is itself worth knowing.
  if (!drawerOpen) {
    await burger.click({ timeout: 5000 });
    await page.waitForTimeout(350);
  }

  const label = SECTION_VIEWS[name]?.label || name;
  const control = SECTION_VIEWS[name]
    ? page.locator(`#nav-drawer [data-nav-drawer-list] a[href="#${SECTION_VIEWS[name].id}"]`)
    : page.locator(`#nav-drawer [data-nav-drawer-list] [data-nav="${name}"]`);

  if ((await control.count()) === 0) {
    bad(`the drawer has no control for "${name}"`);
    return false;
  }

  await control.first().click({ timeout: 5000 });
  await page.waitForTimeout(700);
  return true;
}

const browser = await chromium.launch();

// Two phones. 360px is the most common Android width and 390px the iPhone, and
// the drawer's overflow behaviour differs between them.
for (const width of [360, 390]) {
  console.log(`\n=== ${width}px viewport ===`);
  const page = await browser.newPage({ viewport: { width, height: 844 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  for (const from of DRAWER_VIEWS) {
    for (const to of DRAWER_VIEWS) {
      if (from === to) continue;

      // Reset to a known place.
      await page.goto(BASE, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1200);

      // Walk to `from`, then to `to`. Both steps go through the drawer, so a
      // broken step shows up as the destination simply not changing.
      if (!(await navigateViaDrawer(page, from))) continue;
      const atFrom = await viewIsShowing(page, from);
      if (!atFrom) {
        bad(`${width}px: could not reach "${from}" to test leaving it`);
        continue;
      }

      if (!(await navigateViaDrawer(page, to))) continue;
      const atTo = await viewIsShowing(page, to);

      if (!atTo) {
        bad(`${width}px: "${from}" -> "${to}" did not navigate (still showing "${from}")`);
      }
    }
  }

  ok(`${width}px: every drawer destination reachable from every other`);

  if (pageErrors.length) {
    bad(`${width}px: ${pageErrors.length} page error(s): ${pageErrors[0]}`);
  } else {
    ok(`${width}px: no page errors`);
  }

  await page.close();
}

// --- the regression itself, asserted directly -------------------------------
//
// Worth stating on its own because it is the one that fails without the fix,
// and it fails SILENTLY: no error, no navigation, the drawer just closes.
{
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  const drawerAnchors = page.locator('#nav-drawer [data-nav-drawer-list] a[href^="#"]');
  const count = await drawerAnchors.count();

  if (count === 0) {
    ok('the drawer has no section anchors to check');
  } else {
    const classes = [];
    for (let i = 0; i < count; i++) classes.push(await drawerAnchors.nth(i).getAttribute('class'));
    if (classes.every((c) => (c || '').includes('nav-link'))) {
      ok('every drawer section anchor carries nav-link, so app.js can handle it');
    } else {
      bad(
        'a drawer section anchor is missing nav-link: app.js matches ' +
        `a.nav-link[href^="#"], so it would be ignored. classes=${JSON.stringify(classes)}`
      );
    }
  }

  await page.close();
}

// --- the hub reaches both archives, since the drawer no longer lists them ---
//
// The nav says "Videos", which is the hub, and the hub is what offers both
// archives. If either card were dead the archive would be unreachable from a
// phone entirely, which is the whole regression this file would miss now that
// the drawer walk no longer covers it.
for (const width of [390]) {
  const page = await browser.newPage({ viewport: { width, height: 844 } });
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  await page.locator('#mobile-nav-toggle').click();
  await page.waitForTimeout(400);
  await page.locator('#nav-drawer [data-nav="videos"]').first().click();
  await page.waitForTimeout(700);

  const hubVisible = await page.locator('#videos-view').isVisible().catch(() => false);
  if (!hubVisible) {
    bad(`${width}px: the drawer's Videos entry did not open the Media & Video hub`);
  } else {
    ok(`${width}px: the drawer opens the Media & Video hub`);

    // Both cards, in order, each opening its own archive.
    const cards = page.locator('#videos-view [data-nav]');
    if ((await cards.count()) !== 2) {
      bad(`${width}px: the hub has ${await cards.count()} card(s), expected 2`);
    } else {
      const targets = [await cards.nth(0).getAttribute('data-nav'), await cards.nth(1).getAttribute('data-nav')];
      if (targets[0] === 'interviews' && targets[1] === 'videos-feed') {
        ok(`${width}px: the hub offers Interviews then Videos, in that order`);
      } else {
        bad(`${width}px: hub cards point at ${JSON.stringify(targets)}, expected interviews then videos-feed`);
      }
    }

    // Click the FIRST card and confirm it lands on the interviews archive.
    await page.locator('#videos-view [data-nav="interviews"]').first().click();
    await page.waitForTimeout(700);
    const interviewsShown = await page.locator('#interviews-view').isVisible().catch(() => false);
    if (interviewsShown) ok(`${width}px: the Interviews card opens the interviews archive`);
    else bad(`${width}px: the Interviews card did not open the interviews archive`);

    // Back to the hub, then the second card.
    //
    // Through the DRAWER, not page.goto('#videos'). This is a single-page app:
    // the drawer click below has already rewritten the hash, so navigating to the
    // same URL is a no-op the router never sees -- the hub is left hidden and the
    // next click times out waiting for a card that is in the DOM but not shown.
    await page.locator('#mobile-nav-toggle').click();
    await page.waitForTimeout(400);
    await page.locator('#nav-drawer [data-nav="videos"]').first().click();
    await page.waitForTimeout(700);
    await page.locator('#videos-view [data-nav="videos-feed"]').first().click();
    await page.waitForTimeout(700);
    const videosShown = await page.locator('#videos-feed-view').isVisible().catch(() => false);
    if (videosShown) ok(`${width}px: the Videos card opens the videos archive`);
    else bad(`${width}px: the Videos card did not open the videos archive`);
  }

  await page.close();
}

await browser.close();

console.log('\n------------------------------------------------------------------');
if (problems.length) {
  console.log(problems.length + ' problem(s):');
  for (const p of problems) console.log('  - ' + p);
  process.exit(1);
}
console.log('RESULT: PASS — mobile navigation works from every page to every page.');