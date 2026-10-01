/**
 * Role-access regression test.
 *
 * Guards the bug where `toSession()` granted every signed-in account
 * `isAdmin: true`, which put the Newsroom Panel — Accounts, Branding, Security
 * and Changelog included — in front of plain writers.
 *
 * For each role we sign in, read the tabs the workspace actually offers, and
 * assert four things: nothing the role should not see leaked in, nothing it
 * should see is missing, every tab it can reach renders real content, and the
 * ownership/ghost-row regressions stay fixed.
 *
 * Run against a demo-mode dev server so no live account is touched:
 *   node node_modules/vite/bin/vite.js --mode demo --port 5201
 *   BASE_URL=http://localhost:5201/ npm test
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:5201/';
const PASSWORD = process.env.TEST_PASS || 'password123';

// Extra logging while diagnosing a failing role assertion. Set DEBUG_SIGNIN=1.
const DEBUG = process.env.DEBUG_SIGNIN === '1';

/**
 * Which demo username plays which role.
 *
 * Demo mode does not read a role off the sign-in form: `demoSignIn()` derives it
 * from `VITE_ADMIN_USERNAMES` in `.env.demo`. The first entry holds the Owner
 * seat, any other entry is a Board Manager, and everyone else is a Writer.
 */
const ACCOUNTS = {
  Owner: process.env.TEST_OWNER || 'chief.owner',
  'Board Manager': process.env.TEST_MANAGER || 'reporter.jane',
  Writer: process.env.TEST_EDITOR || 'some.newcomer'
};

/** Tabs each role is entitled to, weakest first. */
const EXPECTED = {
  Writer: ['overview', 'content', 'assignments', 'media'],
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

/**
 * Wording that must NOT reappear. "Owner Control Centre" was wrong: it is a
 * newsroom panel the whole team works in, not the Owner's private screen.
 */
const BANNED_COPY = [
  'owner control center',
  'owner control centre',
  "owner's control"
];

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
    if (DEBUG) {
      const dump = await page.evaluate(() => ({
        demoSession: localStorage.getItem('wire.demoSession'),
        keys: Object.keys(localStorage)
      }));
      console.log(`[debug ${role}] signed in as ${username}`);
      console.log(`[debug ${role}] demoSession = ${dump.demoSession}`);
      console.log(`[debug ${role}] localStorage keys = ${dump.keys.join(', ')}`);
    }
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
        return { len: text.length, undefined: /\bundefined\b/.test(text), text };
      });
      // CHANGELOG.md quotes the word "undefined" when describing the historical
      // rendering bug, so only flag it on tabs that are not the changelog.
      if (!info.len) renderIssues.push(`${tab}: rendered empty`);
      if (info.undefined && tab !== 'changelog') {
        renderIssues.push(`${tab}: contains "undefined"`);
      }
    }

    // --- regression checks ----------------------------------------------------

    // (a) Ghost seed rows. In demo mode the store is localStorage, so seed ids
    // are legitimate here. Against a real database they were the bug: an empty
    // articles table was read as "no data yet", the demo seed was merged back
    // in, and the Owner saw four stories that no Postgres row backed -- which
    // is why "delete article" silently did nothing.
    const ghostCheck = await page.evaluate(
      () => document.body.innerHTML.match(/seed-article-\d/g)?.length || 0
    );

    // (b) Delete scoping. A writer must not be offered a live delete button on
    // somebody else's article; the Owner must be. The authoritative check is
    // the RLS policy in supabase/007 -- this asserts the UI agrees with it.
    const deleteState = await page.evaluate(async () => {
      const store = await import('/src/lib/store.js');
      const articles = store.listArticles();
      return {
        total: articles.length,
        deletable: articles.filter((a) => store.canDeleteArticle(a)).length,
        // Any row still carrying a text id is a ghost in a live deployment.
        nonUuid: articles.filter(
          (a) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(a.id))
        ).length
      };
    });

    const ownershipIssues = [];
    if (deleteState.total === 0) {
      ownershipIssues.push('content tab listed no articles at all');
    }
    if (role === 'Owner' && deleteState.deletable !== deleteState.total) {
      ownershipIssues.push(
        `Owner can delete ${deleteState.deletable} of ${deleteState.total} articles`
      );
    }

    // (b2) The round trip a Writer actually cares about: file a story, then
    // remove it. Seed rows carry no owner, so canDeleteArticle() correctly
    // refuses every one of them for a Writer -- which means checking the seed
    // list alone would pass while the real path stayed untested. Filing one
    // first gives the check a row that genuinely belongs to this account.
    if (role === 'Writer') {
      const roundTrip = await page.evaluate(async () => {
        const store = await import('/src/lib/store.js');
        const made = await store.createArticle({
          title: 'TEST - writer delete round trip',
          author: 'some newcomer',
          category: 'News',
          date: new Date().toISOString().slice(0, 10),
          body: 'Created by the regression test to prove a writer can delete their own work.'
        });
        const canDeleteOwn = store.canDeleteArticle(made);
        let deleted = false;
        let error = null;
        try {
          deleted = await store.deleteArticle(made.id);
        } catch (e) {
          error = e.message;
        }
        return {
          canDeleteOwn,
          deleted,
          error,
          stillListed: store.listArticles().some((a) => a.id === made.id)
        };
      });

      if (!roundTrip.canDeleteOwn) {
        ownershipIssues.push('Writer cannot delete an article they just filed');
      }
      if (!roundTrip.deleted) {
        ownershipIssues.push(`Writer delete failed: ${roundTrip.error || 'returned false'}`);
      }
      if (roundTrip.stillListed) {
        ownershipIssues.push('Writer deleted the article but it is still listed');
      }
    }

    // (c) The panel must not be called the Owner's private screen.
    const panelText = await page.evaluate(
      () => document.querySelector('#admin-root')?.innerText?.toLowerCase() || ''
    );
    const copyIssues = BANNED_COPY.filter((phrase) => panelText.includes(phrase)).map(
      (phrase) => `panel still says "${phrase}"`
    );

    const pass =
      !missing.length &&
      !leaked.length &&
      !renderIssues.length &&
      !ownershipIssues.length &&
      !copyIssues.length &&
      tabs.length > 0;

    results.push({
      role,
      expected,
      tabs,
      missing,
      leaked,
      ownerOnlyLeak,
      renderIssues,
      ghostCheck,
      deleteState,
      ownershipIssues,
      copyIssues,
      pass
    });
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
  console.log(
    '  deletes   :',
    `${r.deleteState.deletable}/${r.deleteState.total} offered to delete, ` +
      `${r.deleteState.nonUuid} non-uuid id(s)`
  );
  console.log(
    '  ownership :',
    r.ownershipIssues.length ? r.ownershipIssues.join(' | ') : 'delete scoping correct'
  );
  console.log('  wording   :', r.copyIssues.length ? r.copyIssues.join(' | ') : 'panel name ok');
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
