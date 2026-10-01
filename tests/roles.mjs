/**
 * Role-access regression test.
 *
 * Guards the bug where `toSession()` granted every signed-in account
 * `isAdmin: true`, which put the Owner's Control Center — Accounts, Branding,
 * Security and Changelog included — in front of plain Editors.
 *
 * For each role we sign in, read the tabs the workspace actually offers, and
 * assert three things: nothing the role should not see leaked in, nothing it
 * should see is missing, and every tab it can reach renders real content.
 *
 * Run against a demo-mode dev server so no live account is touched:
 *   node node_modules/vite/bin/vite.js --mode demo --port 5201
 *   BASE_URL=http://localhost:5201/ npm test
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:5201/';
const PASSWORD = process.env.TEST_PASS || 'password123';

/**
 * Which demo username plays which role.
 *
 * Demo mode does not read a role off the sign-in form: `demoSignIn()` derives it
 * from `VITE_ADMIN_USERNAMES` in `.env.demo`. The first entry holds the Owner
 * seat, any other entry is a Board Manager, and everyone else is an Editor.
 */
const ACCOUNTS = {
  Owner: process.env.TEST_OWNER || 'chief.owner',
  'Board Manager': process.env.TEST_MANAGER || 'reporter.jane',
  Editor: process.env.TEST_EDITOR || 'some.newcomer'
};

/** Tabs each role is entitled to, weakest first. */
const EXPECTED = {
  Editor: ['overview', 'content', 'assignments', 'media'],
  'Board Manager': [
    'overview',
    'content',
    'assignments',
    'media',
    'breaking',
    'broadcasts',
    'curation',
    'staff',
    'credits'
  ],
  Owner: [
    'overview',
    'content',
    'assignments',
    'media',
    'breaking',
    'broadcasts',
    'curation',
    'staff',
    'credits',
    'accounts',
    'changelog',
    'branding',
    'security'
  ]
};

const OWNER_ONLY = ['accounts', 'changelog', 'branding', 'security'];

const browser = await chromium.launch();
const results = [];
const consoleProblems = [];

try {
  for (const [role, expected] of Object.entries(EXPECTED)) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

    page.on('console', (m) => {
      if (m.type() === 'error') consoleProblems.push(`[${role}] ${m.text()}`);
    });
    page.on('pageerror', (e) => consoleProblems.push(`[${role}] ${e.message}`));

    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(700);

    const username = ACCOUNTS[role];
    await signIn(page, username, PASSWORD);
    await page.waitForTimeout(1200);

    // Confirm the app resolved the role we expect, so a wrong demo account
    // fails loudly here instead of passing by accident.
    const liveRole = await page.evaluate(() => {
      const raw = localStorage.getItem('wire.demoSession');
      return raw ? JSON.parse(raw)?.role : null;
    });
    if (liveRole !== role) {
      throw new Error(
        `demo account "${username}" resolved to role "${liveRole}", expected "${role}". ` +
          'Check VITE_ADMIN_USERNAMES in .env.demo, or set TEST_OWNER/TEST_MANAGER/TEST_EDITOR.'
      );
    }

    await page.evaluate(() => {
      document
        .querySelector('[data-action="open-admin"], #open-admin')
        ?.click();
    });
    await page.waitForTimeout(900);

    const tabs = await page.$$eval('[data-admin-tab]', (els) =>
      els.map((e) => e.dataset.adminTab)
    );

    const missing = expected.filter((t) => !tabs.includes(t));
    const leaked = tabs.filter((t) => !expected.includes(t));
    const ownerOnlyLeak = leaked.filter((t) => OWNER_ONLY.includes(t));

    const renderIssues = [];
    for (const tab of tabs) {
      await page.click(`[data-admin-tab="${tab}"]`);
      await page.waitForTimeout(320);
      const info = await page.evaluate(() => {
        const text = document.querySelector('#admin-tab-body')?.innerText || '';
        return { len: text.length, undefined: /\bundefined\b/.test(text) };
      });
      // CHANGELOG.md quotes the word "undefined" when describing the historical
      // rendering bug, so only flag it on tabs that are not the changelog.
      if (!info.len) renderIssues.push(`${tab}: rendered empty`);
      if (info.undefined && tab !== 'changelog') {
        renderIssues.push(`${tab}: contains "undefined"`);
      }
    }

    const pass =
      !missing.length && !leaked.length && !renderIssues.length && tabs.length > 0;

    results.push({ role, expected, tabs, missing, leaked, ownerOnlyLeak, renderIssues, pass });
    await page.close();
  }
} finally {
  await browser.close();
}

/* --- report ----------------------------------------------------------------- */
for (const r of results) {
  console.log(`\n=== ${r.role} ===`);
  console.log('  expected  :', r.expected.join(', '));
  console.log('  actually  :', r.tabs.join(', '));
  console.log('  missing   :', r.missing.length ? r.missing.join(', ') : 'none');
  console.log('  LEAKED    :', r.leaked.length ? r.leaked.join(', ') : 'none');
  if (r.ownerOnlyLeak.length) {
    console.log('  *** OWNER-ONLY TABS EXPOSED:', r.ownerOnlyLeak.join(', '));
  }
  console.log('  render    :', r.renderIssues.length ? r.renderIssues.join(' | ') : 'all tabs ok');
  console.log('  RESULT    :', r.pass ? 'PASS' : 'FAIL');
}

console.log('\n=== console / page errors ===');
if (!consoleProblems.length) console.log('  none');
for (const p of [...new Set(consoleProblems)]) console.log('  ' + p);

const failed = results.filter((r) => !r.pass);
console.log(
  '\n' +
    results.map((r) => `${r.role}: ${r.pass ? 'PASS' : 'FAIL'}`).join(' | ')
);
console.log(
  failed.length || consoleProblems.length
    ? '\nRESULT: FAIL — do not deploy.'
    : '\nRESULT: PASS — role gating is correct.'
);
process.exit(failed.length || consoleProblems.length ? 1 : 0);

/* --- helpers ---------------------------------------------------------------- */

/**
 * Drive the real sign-in form. Demo mode accepts any of the seeded usernames;
 * production mode would need a live account, so BASE_URL must point at a demo
 * server when running this against real credentials.
 */
async function signIn(page, username, password) {
  // The Login button is rendered by renderAuthSlot() after the app boots, so it
  // is not in the static HTML. Wait for it rather than assuming it already exists.
  const trigger = await page
    .waitForSelector('#open-auth, [data-action="open-auth"], [data-action="sign-in"]', {
      timeout: 15000,
    })
    .catch(() => null);
  if (!trigger) throw new Error('could not find the sign-in trigger (#open-auth)');
  await trigger.click();

  await page.waitForSelector('#auth-signin-login', { timeout: 5000 });
  await page.fill('#auth-signin-login', username);
  await page.fill('#auth-signin-password', password);
  await page.click('#auth-form-signin button[type="submit"]');
}
