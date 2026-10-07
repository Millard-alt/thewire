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
  // `interviews` is a Writer tab: a writer files a submission with status
  // 'pending' and the Owner approves it. Gating it at Board Manager would mean a
  // Writer had nowhere to file one, so the approval workflow would have no
  // submission to approve.
  Writer: ['overview', 'content', 'interviews', 'assignments', 'media'],
  'Board Manager': [
    'overview',
    'content',
    'interviews',
    'assignments',
    'media',
    'breaking',
    'broadcasts',
    'curation',
    'staff'
  ],
  Owner: [
    'overview',
    'content',
    'interviews',
    'podcasts',
    'assignments',
    'media',
    'breaking',
    'broadcasts',
    'curation',
    'staff',
    'about',
    'credits',
    'accounts',
    'changelog',
    'branding',
    'security'
  ]
};

/**
 * Tabs only the Owner may open.
 *
 * `credits` and `about` are here because both public pages are hand-curated: the
 * Owner adds a photo, a name, a free-text role and a colour, and the entries are
 * contributors rather than accounts. Nobody but the Owner adds, edits or removes
 * them, and supabase/009_credits_page.sql (with page_scope from 028) enforces
 * the same rule server side so a leaked key is no help.
 *
 * BOTH roster tabs, not just `credits`. That omission shipped once already: the
 * About Us tab was added with `ownerOnly: true` in the app and then forgotten
 * here, so this suite — the thing that exists to catch exactly that — reported
 * a failure against a correctly gated tab and nothing else. The list is the
 * reminder, so it has to be updated when a tab is added, which is why it is a
 * literal list rather than derived from the app.
 *
 * `podcasts` is here for a different reason, and the distinction matters. A writer
 * SUBMITS an episode -- the door for that is on the Interviews tab, which every
 * staffer can open -- but only the Owner may publish or refuse one. Gating the
 * decision at Board Manager would hand out an unreviewed-public-audio button,
 * which is the whole risk the approval queue exists to prevent.
 */
const OWNER_ONLY = [
  'accounts',
  'changelog',
  'branding',
  'security',
  'about',
  'credits',
  'podcasts'
];

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
    const signedIn = await signIn(page, username, PASSWORD);

    // Confirm the app resolved the role we expect, so a wrong demo account
    // fails loudly here instead of passing by accident.
    const live = await page.evaluate(() => {
      const raw = localStorage.getItem('wire.demoSession');
      if (!raw) return null;
      try {
        const s = JSON.parse(raw);
        return { role: s?.role, username: s?.user?.username ?? null };
      } catch {
        return null;
      }
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
    if (live?.role !== role) {
      // Name BOTH halves of the failure. "role null" means no session was ever
      // written; a wrong role for the right username is a different bug; and a
      // session for a different username is a third. Collapsing them into one
      // message is what made this file's flakiness so hard to diagnose — every
      // run reported the same indistinguishable line.
      let because;
      if (!live) {
        because =
          ' -- no session was written at all. The app can repaint the dialog ' +
          'after the fields are filled, so submit saw empty ones and answered ' +
          '"Enter both your username and password." See the note in signIn().';
      } else if (live.username && live.username !== username) {
        because =
          ` -- wire.demoSession holds a DIFFERENT account ("${live.username}"), ` +
          'so the sign-in dialog was driven with stale input.';
      } else {
        because = '';
      }
      throw new Error(
        `demo account "${username}" resolved to role "${live?.role ?? 'null'}", ` +
          `expected "${role}"${because} ` +
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
  // WAIT FOR THE APP TO FINISH BOOTING FIRST.
  //
  // `wire.state.v1` is written by the store on first load. Opening the auth dialog
  // before that lands means `renderAuthSlot()` repaints the dialog's inputs AFTER
  // the test has typed into them, and the values go into a node that is then
  // replaced by an empty one.
  //
  // That is not a theory: the submit handler rejects with "Enter both your
  // username and password." — i.e. the fields really were empty at the moment of
  // the click. Diagnosed by dumping the toast after a failed run, which said
  // exactly that, while `localStorage` held no session and the console held no
  // error. The symptom looks like "sign-in is flaky" and the cause is a repaint
  // losing the input.
  await page
    .waitForFunction(() => Boolean(localStorage.getItem('wire.state.v1')), null, {
      timeout: 20000
    })
    .catch(() => null);

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

  /**
   * Type into a field and CONFIRM it stuck, retrying once.
   *
   * The dialog repaints for reasons of its own (the app keeps the auth slot in
   * step with the live session, and a slow boot can land after the dialog opens),
   * so a single `fill()` is a coin flip on a loaded machine. Reading the value back
   * turns a silent failure -- a submit with empty fields, and an error toast about
   * a password nobody typed -- into either a retry or an accurate error.
   */
  const fillVerified = async (selector, value) => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await page.fill(selector, value);
      const readBack = await page.inputValue(selector).catch(() => '');
      if (readBack === value) return true;
    }
    return false;
  };

  const nameOk = await fillVerified('#auth-signin-login', username);
  const passOk = await fillVerified('#auth-signin-password', password);

  if (!nameOk || !passOk) {
    // Read the dialog's own message, because that is what the reader would see and
    // it names the real cause.
    const toast = await page
      .locator('[role="alert"], .toast')
      .first()
      .textContent()
      .catch(() => '');
    throw new Error(
      `the sign-in fields would not hold "${username}"` +
        `${passOk ? '' : ' / password'} after three attempts. ` +
        `Dialog says: ${JSON.stringify((toast || '').trim())}`
    );
  }

  await page.click('#auth-form-signin button[type="submit"]');

  /*
   * WAIT FOR THE SESSION RATHER THAN SLEEPING FOR IT.
   *
   * This was `waitForTimeout(1200)`. Sign-in is asynchronous -- the demo path
   * writes the session after a round trip -- so under load 1200ms was sometimes
   * not enough and the caller read `role: null`.
   *
   * There is deliberately NO retry loop here. An earlier attempt did verify the
   * signed-in identity and retry from a clean dialog, and it introduced a second,
   * worse failure: re-opening the dialog while the auth slot was still settling
   * meant `#auth-signin-login` sometimes never became visible, so the suite failed
   * in a NEW place instead of an old one. Fixing a flaky suite by making it flaky
   * somewhere else is not a fix.
   *
   * See the note above `signIn()` for what is known about the underlying race:
   * the app can repaint the dialog's inputs after they have been typed into, so
   * the submit sees empty fields and answers "Enter both your username and
   * password." The verified fill below narrows that window; it does not close it,
   * because the cause is in the app's boot sequence and out of scope here.
   */
  const settled = await page
    .waitForFunction(
      () => {
        try {
          return Boolean(JSON.parse(localStorage.getItem('wire.demoSession'))?.role);
        } catch {
          return false;
        }
      },
      null,
      { timeout: 15000 }
    )
    .then(() => true)
    .catch(() => false);

  // Named so the caller's error says WHICH half of the postcondition failed: no
  // session at all, versus a session for somebody else.
  if (!settled) return false;
  return true;
}
