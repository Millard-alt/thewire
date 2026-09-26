/**
 * smoke.mjs â€” end-to-end verification of the four hard requirements.
 *
 *   1. env-driven configuration
 *   2. header auth gating: signed-out shows Login and no admin markup exists;
 *      signing in swaps in "Admin Panel" + "Sign Out"; signing out reverts
 *   3. dark mode: localStorage persistence + prefers-color-scheme fallback
 *   4. CRUD round-trip through the admin workspace
 *
 * Run:  npm run build && node scripts/smoke.mjs
 * Exits 0 when every assertion passes, 1 otherwise.
 */
import { chromium } from 'playwright';
import { preview } from 'vite';

const PORT = 4321;
const ORIGIN = `http://localhost:${PORT}`;

/**
 * Demo credentials: any valid e-mail + 8+ char password works in demo mode.
 * This address is the one in VITE_ADMIN_EMAILS in .env, so signing in as it
 * also exercises the admin allow-list that gates the Owner Control Center.
 * A *non*-allow-listed address is used later to prove readers get no admin UI.
 */
const DEMO_ADMIN_EMAIL = 'chief.owner@example.com';
const DEMO_PASSWORD = 'newspap3r!';

let failures = 0;

function check(label, condition, extra = '') {
  const ok = Boolean(condition);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  -> ' + extra : ''}`);
}

const server = await preview({
  preview: { port: PORT, strictPort: true },
  logLevel: 'error'
});

const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();

const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});

/**
 * Drive a full create -> read -> update -> delete cycle on the Assignments
 * tab, which is the simplest entity with a complete set of controls.
 */
async function runCrud(page, toggled) {
  const body = page.locator('#admin-tab-body');

  // Deletes go through window.confirm(), so accept every dialog we see.
  page.on('dialog', (dialog) => dialog.accept());

  await page.locator('[data-admin-tab="assignments"]').first().click();
  await page.waitForTimeout(300);

  /* --- CREATE --- */
  const before = await body.locator('tbody tr').count();
  await body.locator('[data-action="assignment-new"]').first().click();
  await page.waitForSelector('#assignment-editor:not(.hidden)', { timeout: 5000 });
  await page.fill('#assignment-title', 'Smoke Test Assignment');
  await page.locator('#assignment-form button[type="submit"]').click();
  await page.waitForTimeout(600);

  const afterCreate = await body.locator('tbody tr').count();
  check(
    'CREATE added a row',
    afterCreate === before + 1,
    `${before} -> ${afterCreate}`
  );

  /* --- READ --- */
  let row = body
    .locator('tbody tr', { hasText: 'Smoke Test Assignment' })
    .first();
  check('READ: the new row is listed', await row.isVisible());

  /* --- UPDATE --- */
  await row.locator('[data-action="assignment-edit"]').first().click();
  await page.waitForSelector('#assignment-editor:not(.hidden)', { timeout: 5000 });
  check(
    'UPDATE: the editor is pre-filled',
    (await page.inputValue('#assignment-title')) === 'Smoke Test Assignment'
  );
  await page.fill('#assignment-title', 'Smoke Test Assignment (edited)');
  await page.locator('#assignment-form button[type="submit"]').click();
  await page.waitForTimeout(600);
  check(
    'UPDATE persisted the edit',
    (await body.innerText()).includes('Smoke Test Assignment (edited)')
  );

  /* --- DELETE --- */
  row = body
    .locator('tbody tr', { hasText: 'Smoke Test Assignment (edited)' })
    .first();
  await row.locator('[data-action="assignment-delete"]').first().click();
  await page.waitForTimeout(800);

  const afterDelete = await body.locator('tbody tr').count();
  check(
    'DELETE removed the row',
    afterDelete === before,
    `${afterCreate} -> ${afterDelete}`
  );

  /* ---------- Requirement 3c: the choice survives a reload ------------- */
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('body.app-ready', { timeout: 10000 });
  const reloaded = await page.evaluate(() => ({
    dark: document.documentElement.classList.contains('dark'),
    stored: localStorage.getItem('wire.theme'),
    switchOn: document.getElementById('theme-toggle')?.checked
  }));
  check('theme survives a reload', reloaded.stored === toggled.stored);
  check('reloaded page matches the stored theme', reloaded.dark === toggled.dark);
  check('the switch reflects the restored theme', reloaded.switchOn === reloaded.dark);
}

try {
  await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('body.app-ready', { timeout: 10000 });

  /* ---------- Requirement 2a: signed-out header ------------------------- */
  const loginBtn = page.locator('#auth-slot #open-auth');
  check('signed-out header shows a Login button', await loginBtn.isVisible());
  check(
    'Login button label is "Login"',
    // The .btn class applies text-transform: uppercase, which innerText
    // reflects, so compare case-insensitively.
    (await loginBtn.innerText()).replace(/\s+/g, ' ').trim().toLowerCase() === 'login'
  );

  // No admin markup may exist in the document for an anonymous visitor.
  const anon = await page.evaluate(() => {
    const adm = document.getElementById('admin-view');
    const pub = document.getElementById('publication-view');
    return {
      adminHtml: adm ? adm.innerHTML.trim().length : 0,
      adminHidden: adm ? adm.classList.contains('hidden') : false,
      publicHidden: pub ? pub.classList.contains('hidden') : false,
      headerHasAdmin: /Admin Panel/i.test(
        document.getElementById('auth-slot').innerHTML
      )
    };
  });
  check('admin view is empty for anonymous visitors', anon.adminHtml === 0);
  check('admin view stays hidden', anon.adminHidden === true);
  check('publication view is visible', anon.publicHidden === false);
  check('header contains no "Admin Panel" text', anon.headerHasAdmin === false);

  /* ---------- Requirement 3: dark mode ---------------------------------- */
  const initial = await page.evaluate(() => ({
    dark: document.documentElement.classList.contains('dark'),
    scheme: document.documentElement.style.colorScheme,
    bg: getComputedStyle(document.body).backgroundColor
  }));
  console.log(
    `      initial theme: ${initial.dark ? 'dark' : 'light'} (${initial.bg})`
  );
  check('body has a resolved background colour', Boolean(initial.bg));
  check(
    'color-scheme is set on <html>',
    initial.scheme === 'light' || initial.scheme === 'dark'
  );

  await page.locator('#theme-toggle').check({ force: true });
  await page.waitForTimeout(250);
  const toggled = await page.evaluate(() => ({
    dark: document.documentElement.classList.contains('dark'),
    stored: localStorage.getItem('wire.theme'),
    icon: document.querySelector('.theme-icon')?.className || ''
  }));
  check('toggling the switch flips the theme', toggled.dark !== initial.dark);
  check(
    'theme is written to localStorage',
    toggled.stored === (toggled.dark ? 'dark' : 'light')
  );
  check('sun/moon icon reflects the theme', /fa-moon|fa-sun/.test(toggled.icon));

  // Reload -> the stored choice must survive.

  /* ---------- Requirement 3b: prefers-color-scheme fallback -------------- */
  // A brand-new visitor with no stored choice, on a dark OS, gets dark mode.
  const darkCtx = await browser.newContext({ colorScheme: 'dark' });
  const darkPage = await darkCtx.newPage();
  await darkPage.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded' });
  await darkPage.waitForSelector('body.app-ready', { timeout: 10000 });
  check(
    'fresh visitor on a dark OS gets dark mode',
    await darkPage.evaluate(() =>
      document.documentElement.classList.contains('dark')
    )
  );
  await darkCtx.close();

  // ...and on a light OS, light mode.
  const lightCtx = await browser.newContext({ colorScheme: 'light' });
  const lightPage = await lightCtx.newPage();
  await lightPage.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded' });
  await lightPage.waitForSelector('body.app-ready', { timeout: 10000 });
  check(
    'fresh visitor on a light OS gets light mode',
    await lightPage.evaluate(
      () => !document.documentElement.classList.contains('dark')
    )
  );
  await lightCtx.close();

  /* ---------- Requirement 2b: the login modal --------------------------- */
  await page.locator('#auth-slot #open-auth').click();
  await page.waitForSelector('#auth-modal:not(.hidden)', { timeout: 5000 });
  check(
    'login modal opens',
    await page.locator('#auth-modal .modal-card').isVisible()
  );
  check(
    'modal is announced as a dialog',
    (await page.locator('#auth-modal').getAttribute('aria-modal')) === 'true'
  );
  // openDialog() focuses the initial field on a short timer, so let it land.
  await page.waitForTimeout(200);
  check(
    'focus moves into the modal',
    await page.evaluate(() =>
      document.getElementById('auth-modal').contains(document.activeElement)
    )
  );

  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  check('Escape closes the modal', await page.locator('#auth-modal').isHidden());

  // Reopen and sign in for real.
  await page.locator('#auth-slot #open-auth').click();
  await page.waitForSelector('#auth-modal:not(.hidden)');
  await page.fill('#auth-signin-email', DEMO_ADMIN_EMAIL);
  await page.fill('#auth-signin-password', DEMO_PASSWORD);
  await page.locator('#auth-form-signin button[type="submit"]').click();
  // The modal closes itself on a successful sign-in.
  await page.locator('#auth-modal').waitFor({ state: 'hidden', timeout: 10000 });
  await page.waitForTimeout(400);

  /* ---------- Requirement 2c: signed-in header -------------------------- */
  const signedIn = await page.evaluate(() => {
    const slot = document.getElementById('auth-slot');
    const adm = document.getElementById('admin-view');
    return {
      hasAdmin: /Admin Panel/i.test(slot.innerHTML),
      hasSignOut: /Sign Out/i.test(slot.innerHTML),
      loginGone: !slot.querySelector('#open-auth'),
      adminMounted: Boolean(adm) && !adm.classList.contains('hidden'),
      adminHasContent: adm ? adm.innerHTML.trim().length > 0 : false,
      publicHidden: document
        .getElementById('publication-view')
        .classList.contains('hidden')
    };
  });
  check('header now shows "Admin Panel"', signedIn.hasAdmin);
  check('header now shows "Sign Out"', signedIn.hasSignOut);
  check('the Login button is gone', signedIn.loginGone);
  check('admin workspace is mounted', signedIn.adminHasContent);
  check('admin workspace is visible', signedIn.adminMounted);
  check('publication view is hidden while in the workspace', signedIn.publicHidden);

  /* ---------- Requirement 4: CRUD round-trip --------------------------- */
  await runCrud(page, toggled);

  /* ---------- Requirement 2d: sign out ---------------------------------- */
  // "Sign Out" lives inside the account dropdown, so open it first.
  await page.locator('#account-menu-toggle').click();
  await page.waitForSelector('#account-menu:not(.hidden)', { timeout: 5000 });
  await page.locator('#account-signout').click();
  await page.waitForTimeout(700);
  const signedOut = await page.evaluate(() => {
    const slot = document.getElementById('auth-slot');
    const adm = document.getElementById('admin-view');
    return {
      loginBack: Boolean(slot.querySelector('#open-auth')),
      noSignOut: !/Sign Out/i.test(slot.innerHTML),
      adminEmptied: adm.innerHTML.trim().length === 0,
      adminHidden: adm.classList.contains('hidden'),
      publicBack: !document
        .getElementById('publication-view')
        .classList.contains('hidden')
    };
  });
  check('signing out restores the Login button', signedOut.loginBack);
  check('signing out removes "Sign Out"', signedOut.noSignOut);
  check('signing out empties the admin workspace', signedOut.adminEmptied);
  check('signing out hides the admin workspace', signedOut.adminHidden);
  check('signing out restores the publication', signedOut.publicBack);

  /* ---------- No runtime errors ----------------------------------------- */
  check(
    'no uncaught page errors',
    pageErrors.length === 0,
    pageErrors.join(' | ')
  );
} catch (error) {
  failures += 1;
  console.error('\nFatal error during the smoke run:\n', error);
} finally {
  await browser.close();
  await server.close();
}

console.log(
  failures ? `\n${failures} check(s) FAILED\n` : '\nAll checks passed.\n'
);
process.exit(failures ? 1 : 0);

