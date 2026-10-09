/* =============================================================================
   scripts/panel-check.mjs â€” THE OWNER CONTROL PANEL, BY ROLE
   -----------------------------------------------------------------------------
   Drives the real panel in a real browser as each of the three roles and
   asserts three things:

     1. ROLE MATRIX.  A Writer must not see a tab the Owner or a Board Manager
        can. The panel gates tabs in the browser AND the database gates the
        tables behind them, so this checks the half that is easy to get wrong:
        a tab that appears for the wrong role is a promise the database cannot
        keep, and it is how a Writer discovers what buttons exist.

     2. MEDIA APPROVAL.  The requirement is that a Writer cannot post media
        without a Board Manager or the Owner approving it. Asserted at the level
        the user actually experiences: the Writer sees a Pending badge and NO
        Approve button; the approvers see the button, and clicking it clears the
        badge.

        This is the UI half only. The database half -- a Writer self-approving
        and having the write refused -- is asserted in migration-apply-check.mjs
        against real Postgres. Neither file is sufficient alone: hiding a button
        proves nothing if the policy allows the write, and a correct policy is
        invisible to a person staring at the panel.

     3. NOTHING THROWS.  Every tab is opened for every role and any console
        error or unhandled rejection fails the run. A tab that renders an empty
        panel because of a TypeError looks identical to a tab that is correctly
        empty, and this is the only way to tell them apart.

   Demo mode, and it starts its own server on a private port so it cannot
   collide with a dev server someone already has open.

   Run:  npm run test:panel
   ========================================================================== */

import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const PORT = Number(process.env.PANEL_PORT || 5311);
const BASE = `http://localhost:${PORT}/`;
const PASSWORD = process.env.TEST_PASS || 'password123';
const OWNER = process.env.TEST_OWNER || 'chief.owner';
const MANAGER = process.env.TEST_MANAGER || 'reporter.jane';

const problems = [];
const ok = (m) => console.log('PASS  ' + m);
const bad = (m) => { problems.push(m); console.log('FAIL  ' + m); };

// --- a server of our own ---------------------------------------------------
const server = spawn(
  process.execPath,
  ['node_modules/vite/bin/vite.js', '--mode', 'demo', '--port', String(PORT), '--strictPort'],
  { stdio: ['ignore', 'pipe', 'pipe'] }
);
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });

const stop = () => { try { server.kill(); } catch {} };
process.on('exit', stop);

async function waitForServer(timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(BASE, { method: 'GET' });
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 400));
  }
  console.log('\nThe demo server never came up. Output:\n' + serverLog.slice(-1500));
  stop();
  process.exit(2);
}

/** Sign in through the real dialog. */
async function signIn(page, username) {
  await page
    .waitForFunction(() => Boolean(localStorage.getItem('wire.state.v1')), null, { timeout: 20000 })
    .catch(() => null);

  const trigger = await page
    .waitForSelector('#open-auth, [data-action="open-auth"], [data-action="sign-in"]', { timeout: 15000 })
    .catch(() => null);
  if (!trigger) throw new Error('could not find the sign-in trigger');
  await trigger.click();
  await page.waitForSelector('#auth-signin-login', { timeout: 8000 });

  // `#auth-signin-login` is the USERNAME field, despite the name -- same
  // selectors roles.mjs uses. The submit button lives in #auth-form-signin.
  await page.fill('#auth-signin-login', username);
  await page.fill('#auth-signin-password', PASSWORD);
  await page.click('#auth-form-signin button[type="submit"]');

  // Wait for the SESSION, not a sleep. Sign-in is asynchronous and a fixed
  // timeout made this flaky under load.
  await page
    .waitForFunction(() => Boolean(localStorage.getItem('wire.session') || localStorage.getItem('wire.sessionToken')), null, { timeout: 15000 })
    .catch(() => null);
  await page
    .waitForFunction(() => !document.querySelector('#auth-signin-login'), null, { timeout: 15000 })
    .catch(() => null);
  await page.waitForTimeout(800);
}

/** Open the panel and return the tab labels visible to this role. */
async function openPanel(page) {
  await page.waitForTimeout(400);
  const opener = await page
    .waitForSelector('[data-action="open-admin"], #open-admin, [data-action="open-panel"]', { timeout: 10000 })
    .catch(() => null);
  if (opener) {
    await opener.click();
    await page.waitForTimeout(900);
  }
  // The tab strip is [data-admin-tab="<id>"], not data-tab. paintActiveTab()
  // reads that attribute and toggles .is-active on it.
  return page.$$eval('[data-admin-tab]', (els) =>
    els
      .filter((el) => el.offsetParent !== null)
      .map((el) => ({
        id: el.dataset.adminTab,
        label: (el.textContent || '').trim()
      }))
  );
}

/** Click a tab by its id (or by its visible label). */
async function clickTab(page, key) {
  const clicked = await page.evaluate((want) => {
    const tabs = [...document.querySelectorAll('[data-admin-tab]')];
    const tab =
      tabs.find((el) => (el.dataset.adminTab || '').toLowerCase() === want.toLowerCase()) ||
      tabs.find((el) => (el.textContent || '').trim().toLowerCase() === want.trim().toLowerCase());
    if (!tab || tab.offsetParent === null) return false;
    tab.click();
    return true;
  }, key);
  await page.waitForTimeout(700);
  return clicked;
}

// ===========================================================================
console.log('\nStarting a demo server on ' + BASE);
await waitForServer();

const browser = await chromium.launch();

/** Run one role's session. Returns the tab labels and a console-error capture. */
async function session(username) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await signIn(page, username);
  const tabs = await openPanel(page);
  return { ctx, page, tabs, consoleErrors };
}

// ---------------------------------------------------------------------------
console.log('\n--- 1. role matrix ------------------------------------------------');

// demoSignIn() derives the demo role from VITE_ADMIN_USERNAMES: the first entry
// is the Owner, any other entry is a Board Manager, and everyone else is a
// Writer. So a username that appears in neither list gets a Writer seat.
const WRITER = process.env.TEST_WRITER || 'photog.reporter';

const ownerS = await session(OWNER);
const managerS = await session(MANAGER);
const writerS = await session(WRITER);

console.log('  Owner tabs   : ' + (ownerS.tabs.map((t) => t.id).join(', ') || '(none found)'));
console.log('  Manager tabs : ' + managerS.tabs.map((t) => t.id).join(', '));
console.log('  Writer tabs  : ' + writerS.tabs.map((t) => t.id).join(', '));

if (ownerS.tabs.length === 0) {
  bad('no panel tabs were found for the Owner -- the selectors or the panel markup changed');
} else {
  ok('the panel opens and exposes tabs');
}

const has = (tabs, label) =>
  tabs.some(
    (t) =>
      (t.id || '').toLowerCase() === label.toLowerCase() ||
      (t.label || '').toLowerCase().includes(label.toLowerCase())
  );
const OWNER_ONLY = ['accounts', 'credits', 'about', 'changelog'];
const MANAGER_PLUS = ['assignments', 'broadcasts', 'curation', 'staff', 'breaking'];

for (const label of OWNER_ONLY) {
  if (has(ownerS.tabs, label)) ok(`Owner sees "${label}"`);
  else bad(`Owner cannot see "${label}"`);
}
for (const label of MANAGER_PLUS) {
  if (!has(writerS.tabs, label)) ok(`Writer does NOT see "${label}"`);
  else bad(`Writer sees "${label}" -- a tab the database will refuse`);
}
for (const label of OWNER_ONLY) {
  if (!has(writerS.tabs, label)) ok(`Writer does NOT see "${label}"`);
  else bad(`Writer sees "${label}" -- an Owner-only tab`);
}

// ---------------------------------------------------------------------------
console.log('\n--- 2. every tab renders for every role -------------------------');

for (const [roleName, s] of [['Owner', ownerS], ['Board Manager', managerS], ['Writer', writerS]]) {
  const before = s.consoleErrors.length;
  for (const t of s.tabs) {
    await clickTab(s.page, t.id);
  }
  const added = s.consoleErrors.slice(before);
  if (added.length === 0) ok(`${roleName}: all ${s.tabs.length} tab(s) opened with no console errors`);
  else bad(`${roleName}: ${added.length} console error(s): ` + added.slice(0, 3).join(' | '));
}

// ---------------------------------------------------------------------------
console.log('\n--- 3. media needs approval -------------------------------------');

/** Add a media item through the real panel form. */
async function addMedia(s, url, caption) {
  await clickTab(s.page, 'media');
  await s.page.fill('#media-url', url);
  await s.page.fill('#media-caption', caption);
  await s.page.evaluate(() => {
    const form = document.querySelector('#media-form');
    if (form) form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
  });
  await s.page.waitForTimeout(900);
  return s.page.$$eval('[data-media-status]', (els) => els.map((e) => e.textContent.trim()));
}

const url = 'https://example.test/approval-probe.jpg';

{
  const badges = await addMedia(writerS, url, 'writer probe');
  if (badges.some((b) => /pending/i.test(b))) ok('a Writer\'s new image shows a Pending badge');
  else bad('a Writer\'s new image shows no Pending badge: ' + JSON.stringify(badges));
}

{
  const approveButtons = await writerS.page.$$eval('[data-action="media-approve"]', (e) => e.length);
  const rejectButtons = await writerS.page.$$eval('[data-action="media-reject"]', (e) => e.length);
  if (approveButtons === 0 && rejectButtons === 0) ok('a Writer sees NO Approve or Reject buttons');
  else bad(`a Writer sees ${approveButtons} approve and ${rejectButtons} reject buttons`);
}

for (const [roleName, s] of [['Owner', ownerS], ['Board Manager', managerS]]) {
  await clickTab(s.page, 'media');
  await s.page.waitForTimeout(300);
  const n = await s.page.$$eval('[data-action="media-approve"]', (e) => e.length);
  if (n > 0) ok(`${roleName} sees Approve buttons (${n})`);
  else bad(`${roleName} sees no Approve buttons`);
}

// The Manager approves the Writer's pending image.
{
  await clickTab(managerS.page, 'media');
  await managerS.page.waitForTimeout(400);
  const clicked = await managerS.page.evaluate(() => {
    const item = [...document.querySelectorAll('[data-media-status="pending"]')][0]?.closest('figure, li, div');
    const btn = item ? item.querySelector('[data-action="media-approve"]') : document.querySelector('[data-action="media-approve"]');
    if (!btn) return false;
    btn.click();
    return true;
  });
  await managerS.page.waitForTimeout(1000);
  const left = await managerS.page.$$eval('[data-media-status="pending"]', (e) => e.length);
  if (clicked && left === 0) ok('a Board Manager approving clears the Pending badge');
  else bad(`after approval, ${left} item(s) still pending (clicked=${clicked})`);
}

// ---------------------------------------------------------------------------
console.log('\n--- 4. reader features still render ------------------------------');

for (const [roleName, s] of [['Owner', ownerS], ['Writer', writerS]]) {
  const before = s.consoleErrors.length;
  for (const view of ['gallery', 'credits', 'about', 'podcasts']) {
    await s.page.evaluate((v) => { window.location.hash = '#' + v; }, view);
    await s.page.waitForTimeout(700);
  }
  const added = s.consoleErrors.slice(before);
  if (added.length === 0) ok(`${roleName}: gallery, credits, about and podcasts all render clean`);
  else bad(`${roleName}: reader views threw: ` + added.slice(0, 3).join(' | '));
}

// ---------------------------------------------------------------------------
for (const s of [ownerS, managerS, writerS]) await s.ctx.close();
await browser.close();
stop();

console.log('\n------------------------------------------------------------------');
if (problems.length) {
  console.log(problems.length + ' problem(s):');
  for (const p of problems) console.log('  - ' + p);
  process.exit(1);
}
console.log('RESULT: PASS â€” the panel behaves for all three roles.');
