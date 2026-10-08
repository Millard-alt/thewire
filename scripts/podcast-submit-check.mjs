/**
 * The Writer's podcast submission path, driven through the real UI.
 *
 *   node scripts/podcast-submit-check.mjs
 *
 * WHY THIS EXISTS AND WHY IT IS A BROWSER CHECK
 * ---------------------------------------------
 * `src/lib/podcasts.js` called `safeUrl()` without importing it, so
 * `submitPodcast()` threw `ReferenceError: safeUrl is not defined` on the first
 * line that touched the audio link -- and BOTH writer submission paths died with
 * it. The feature was 100% broken and the whole suite was green, because
 * `tests/features.mjs` asserts the CALL SITE with a source regex:
 *
 *     /const cleanAudioUrl = safeUrl\(audioUrl\)/.test(podcastsSrc)
 *
 * A regex cannot tell whether a name was ever bound. The mock functions at the top
 * of podcasts.js do not exercise the real path either -- demo mode short-circuits
 * before `getSupabase()` is ever called. So nothing in the project ever RAN this
 * function.
 *
 * This check submits the actual form in demo mode and asserts the episode comes
 * back out of the store. That is the smallest thing that would have caught it.
 *
 * It is also the only check that proves a WRITER is confined to submit-only,
 * because the assertion is about what a Writer cannot SEE:
 *
 *     - no Approve, no Reject, no Delete, no review queue
 *     - no Coverage Order panel (the front page layout is the Owner's)
 *     - no Assignments tab
 *
 * and the last block signs in as a Board Manager and confirms the approve tier is
 * reachable there, so the check cannot be passed by simply hiding the queue from
 * everybody.
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:5201/';
const PASS = process.env.TEST_PASS || 'password123';

// Demo roles come from VITE_ADMIN_USERNAMES (see .env.demo): the first entry is
// the Owner seat, any other listed entry is a Board Manager, and anybody NOT in
// the allow-list is a Writer. `click-check.mjs` documents the same arrangement.
const OWNER = process.env.TEST_OWNER || 'chief.owner';
const MANAGER = process.env.TEST_MANAGER || 'reporter.jane';
// Deliberately not in the allow-list: this is how the check obtains a Writer.
const WRITER = process.env.TEST_WRITER || 'staff.writer';

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) {
    pass += 1;
    console.log(`PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`FAIL  ${name}${detail ? `  -- ${detail}` : ''}`);
  }
};

async function signIn(page, username) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(900);
  await page.evaluate(() => {
    document.querySelector('[data-action="open-auth"], #open-auth')?.click();
  });
  await page.waitForTimeout(400);
  await page.fill('#auth-signin-login', username);
  await page.fill('#auth-signin-password', PASS);
  await page.locator('#auth-form-signin button[type="submit"]').click();
  await page.waitForTimeout(1600);
}

async function openPanel(page, tab) {
  await page.evaluate(() => {
    document.querySelector('[data-action="open-admin"], #open-admin')?.click();
  });
  await page.waitForTimeout(900);
  if (tab) {
    await page.click(`[data-admin-tab="${tab}"]`);
    await page.waitForTimeout(1200);
  }
}

const browser = await chromium.launch();

/* ====================== A WRITER SUBMITS, AND IT WORKS ====================== */
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await signIn(page, WRITER);
  await openPanel(page);

  const desk = await page.evaluate(() => ({
    tabs: [...document.querySelectorAll('[data-admin-tab]')].map((b) => b.dataset.adminTab),
    title: document.querySelector('#admin-title, [data-workspace-title]')?.textContent?.trim() || null
  }));
  console.log('--- a Writer at the desk ---');
  console.log(`    tabs: ${desk.tabs.join(', ')}`);
  check('a Writer gets a panel at all', desk.tabs.length > 0);
  check(
    'a Writer has no Assignments tab',
    !desk.tabs.includes('assignments'),
    `assignments present: ${desk.tabs.includes('assignments')}`
  );
  check(
    'a Writer has no Accounts, Security or Credits tab',
    !desk.tabs.some((t) => ['accounts', 'security', 'credits', 'about'].includes(t)),
    desk.tabs.join(', ')
  );

  // THE OVERVIEW IS WHERE THE REVIEW QUEUE LIVES. A Writer must not see it, and
  // must not be able to find an approve control anywhere on the tab.
  await page.click('[data-admin-tab="overview"]');
  await page.waitForTimeout(900);
  const overview = await page.evaluate(() => {
    const body = document.querySelector('#admin-tab-body');
    const html = body?.innerHTML || '';
    return {
      // The metric tiles label themselves with a <span>, NOT an <h3>, so this
      // reads the label text out of the whole document rather than a heading
      // list. An earlier version of this assertion counted <h3>s and passed for
      // the wrong reason: a Writer's Overview has none, because both sections
      // are gated off, so "no Review queue heading" was true by emptiness.
      hasQueueHeading: /review queue/i.test(html),
      approveButtons: document.querySelectorAll('[data-action="article-publish"]').length,
      // "Awaiting review" is a COUNT of the reader's own filings and is
      // deliberately KEPT for a Writer: hiding it would leave them with no
      // indication that something they sent is still sitting there.
      hasAwaitingTile: /awaiting review/i.test(html),
      // The container must not survive as an empty grid once both of its
      // sections are gated off.
      emptyGrid: Boolean(body?.querySelector('.grid.gap-6:empty')),
      audit: /audit trail/i.test(html),
      subscribers: /active subscribers/i.test(html)
    };
  });
  console.log('--- the Overview as a Writer sees it ---');
  check(
    'a Writer sees no Review queue section on Overview',
    !overview.hasQueueHeading,
    overview.hasQueueHeading ? 'the section is in the document' : ''
  );
  check('a Writer gets no Approve button on Overview', overview.approveButtons === 0, `${overview.approveButtons} found`);
  check('a Writer sees no Audit trail', !overview.audit);
  check('a Writer sees no Active subscribers tile', !overview.subscribers);
  check(
    'a Writer still sees their own awaiting-review COUNT',
    overview.hasAwaitingTile,
    'the tile is a metric, not a section, and should survive the lockdown'
  );
  check(
    'the two-column grid is not left behind empty',
    !overview.emptyGrid,
    'both of its sections are gated off for a Writer, so the container should go too'
  );

  /* ---- the submit form itself, and the submission that used to throw ---- */
  await page.click('[data-admin-tab="podcasts"]');
  await page.waitForTimeout(1100);

  const form = await page.evaluate(() => {
    const ids = ['podcast-sub-title', 'podcast-sub-host', 'podcast-sub-description',
      'podcast-sub-file', 'podcast-sub-audio-url', 'podcast-sub-cover'];
    return {
      present: ids.filter((id) => document.getElementById(id)),
      // A Writer's tab is submit-ONLY: no queue, no controls.
      approveButtons: document.querySelectorAll('[data-action="podcast-approve"]').length,
      deleteButtons: document.querySelectorAll('[data-action="podcast-delete"]').length,
      rejectButtons: document.querySelectorAll('[data-action="podcast-reject"]').length,
      queueText: /waiting for approval|published episodes/i.test(
        document.querySelector('#admin-tab-body')?.innerHTML || ''
      )
    };
  });
  console.log('--- the Writer submission form ---');
  check(
    'the Writer form offers every field the brief names',
    form.present.length === 6,
    `present: ${form.present.join(', ')}`
  );
  check('a Writer sees no Approve control', form.approveButtons === 0);
  check('a Writer sees no Reject control', form.rejectButtons === 0);
  check('a Writer sees no Delete control', form.deleteButtons === 0);
  check("a Writer sees no review queue at all", !form.queueText);

  // Submit it for real. A pasted audio URL avoids the Storage preflight, which is
  // unreachable in demo mode and would otherwise be a second reason for this to
  // fail that has nothing to do with the code under test.
  const TITLE = 'Probe: the athletics funding gap';
  const GUEST = 'Mercy Kamande';
  const COVER = 'https://example.com/cover.png';

  await page.fill('#podcast-sub-title', TITLE);
  await page.fill('#podcast-sub-host', GUEST);
  await page.fill('#podcast-sub-description', 'Filed by podcast-submit-check.mjs.');
  await page.fill('#podcast-sub-audio-url', 'https://example.com/episode.mp3');
  await page.fill('#podcast-sub-cover', COVER);
  await page.click('#podcast-submit-form button[type=submit]');
  await page.waitForTimeout(1800);

  const stored = await page.evaluate((keys) => {
    const raw = JSON.parse(localStorage.getItem('pulse.podcasts') || '[]');
    const row = raw.find((r) => r.title === keys.title);
    return {
      found: Boolean(row),
      status: row?.status ?? null,
      author: row?.author_name ?? null,
      cover: row?.cover_url ?? null,
      toast: document.querySelector('.toast')?.textContent?.trim() || null
    };
  }, { title: TITLE });

  check(
    'the submission is STORED -- this is the assertion that would have caught the missing safeUrl import',
    stored.found,
    stored.toast || 'nothing in the demo store'
  );
  check(
    "a Writer's submission is saved PENDING, never pre-approved",
    stored.status === 'pending',
    `status=${stored.status}`
  );
  check(
    'the Speaker / host field is no longer dead: it is the public byline',
    stored.author === GUEST,
    `author_name=${stored.author}`
  );
  check('the cover image is stored', stored.cover === COVER, `cover_url=${stored.cover}`);
  check(
    'the panel says it is awaiting approval',
    /awaiting/i.test(stored.toast || ''),
    `toast="${stored.toast}"`
  );

  // A Writer must not be able to approve their own submission, however they get
  // to the row. Their tab has no control for it, so this asserts the absence of
  // the whole path rather than clicking a button that does not exist.
  const cannotApprove = await page.evaluate(() => ({
    controls: document.querySelectorAll(
      '[data-action="podcast-approve"], [data-action="podcast-reject"]'
    ).length
  }));
  check('a Writer has no way to approve what they just filed', cannotApprove.controls === 0);

  /* ---- and it survives a reload, which is the difference between stored and typed ---- */
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1600);
  await openPanel(page, 'podcasts');
  const afterReload = await page.evaluate(
    (title) =>
      JSON.parse(localStorage.getItem('pulse.podcasts') || '[]').some((r) => r.title === title),
    TITLE
  );
  check('the submission survives a reload', afterReload);

  check('no console or page errors during the whole flow', errors.length === 0, errors.slice(0, 3).join(' | '));
  await page.close();
}

/* ============ A BOARD MANAGER CAN APPROVE, WHICH IS THE POINT OF THE TIER ============ */
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  // Seed one pending episode straight into the demo store, so this block measures
  // the TIER and not the submission path the block above already proved.
  await signIn(page, MANAGER);
  await page.evaluate(() => {
    const KEY = 'pulse.podcasts';
    const rows = JSON.parse(localStorage.getItem(KEY) || '[]');
    rows.unshift({
      id: 'probe-approver',
      title: 'Probe: awaiting the Board Manager',
      description: 'Seeded by podcast-submit-check.mjs.',
      author_name: 'A Writer',
      duration_seconds: 120,
      status: 'pending',
      audio_url: 'https://example.com/probe.mp3',
      storage_path: null,
      cover_url: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
    localStorage.setItem(KEY, JSON.stringify(rows));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  await openPanel(page, 'podcasts');

  const asManager = await page.evaluate(() => ({
    approve: document.querySelectorAll('[data-action="podcast-approve"]').length,
    reject: document.querySelectorAll('[data-action="podcast-reject"]').length,
    // Deleting something readers can currently hear is the OWNER's act; a Board
    // Manager may refuse a pending episode but may not delete a published one.
    del: document.querySelectorAll('[data-action="podcast-delete"]').length,
    queue: /waiting for approval/i.test(document.querySelector('#admin-tab-body')?.innerHTML || ''),
    title: document.querySelector('#admin-title, [data-workspace-title]')?.textContent?.trim() || null
  }));
  console.log('\n--- a Board Manager at the podcasts desk ---');
  check('a Board Manager SEES the review queue', asManager.queue, `title=${asManager.title}`);
  check('a Board Manager gets Approve', asManager.approve > 0, `${asManager.approve} found`);
  check('a Board Manager gets Reject', asManager.reject > 0, `${asManager.reject} found`);
  check(
    'a Board Manager gets NO Delete on a pending episode',
    asManager.del === 0,
    `${asManager.del} found -- the button is rendered per published row`
  );

  // Approve it for real, and confirm it moved.
  await page.evaluate(() => {
    document.querySelector('[data-action="podcast-approve"]')?.click();
  });
  await page.waitForTimeout(1800);
  const decided = await page.evaluate(() => {
    const rows = JSON.parse(localStorage.getItem('pulse.podcasts') || '[]');
    return rows.find((r) => r.id === 'probe-approver')?.status ?? null;
  });
  check("a Board Manager's approval sets status = 'approved'", decided === 'approved', `status=${decided}`);

  check('no page errors in the approver flow', errors.length === 0, errors.slice(0, 3).join(' | '));
  await page.close();
}

/* ================== A BOARD MANAGER CANNOT SET THE FRONT PAGE ORDER ================== */
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await signIn(page, MANAGER);
  await openPanel(page, 'content');
  const layout = await page.evaluate(() => ({
    panel: Boolean(document.querySelector('.layout-panel')),
    save: document.querySelectorAll('[data-action="layout-save"]').length,
    arrows: document.querySelectorAll('[data-action="layout-up"], [data-action="layout-down"]').length
  }));
  console.log('\n--- a Board Manager on the Content desk ---');
  check('no Coverage Order panel for a non-Owner', !layout.panel);
  check('no Save Layout Order button', layout.save === 0);
  check('no reorder arrows', layout.arrows === 0);
  await page.close();
}

/* ================== THE OWNER KEEPS EVERYTHING ================== */
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await signIn(page, OWNER);
  await openPanel(page, 'content');
  const layout = await page.evaluate(() => ({
    panel: Boolean(document.querySelector('.layout-panel')),
    save: document.querySelectorAll('[data-action="layout-save"]').length
  }));
  console.log('\n--- the Owner on the Content desk ---');
  check('the Owner still has the Coverage Order panel', layout.panel);
  check('the Owner still has Save Layout Order', layout.save > 0);
  await page.close();
}

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);