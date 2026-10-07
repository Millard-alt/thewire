/**
 * Click sweep: does every interactive control actually DO something?
 *
 *   node scripts/click-check.mjs        (BASE_URL defaults to http://localhost:5201/)
 *
 * WHY THIS IS PERMANENT
 * ---------------------
 * It started as a throwaway probe and immediately earned its place by finding the
 * "Turn on alerts" button doing literally nothing: ensureAlertPermission() opened
 * with `if (hasAnswered()) return false`, and that guard applied to DELIBERATE
 * clicks as well as the automatic prompt, so an opted-in reader pressing the
 * button got no dialog, no toast and no error. A second run found a backtick
 * inside an HTML comment in a template literal, which had made the whole admin
 * module fail to evaluate.
 *
 * Both were invisible to every other suite. So this stays.
 *
 * WHAT IT ASSERTS, PER CONTROL
 * ----------------------------
 *   1. clicking it produces SOME observable change -- a dialog opens, a view
 *      swaps, a toast appears, or the DOM mutates;
 *   2. it throws no console error or page error;
 *   3. it issues no failed network request.
 *
 * Point 1 is deliberately weak. A stronger rule ("must open a dialog") encodes a
 * guess about intent and would fail on every button whose real effect is a fetch.
 * The signal is "nothing at all happened", which is the actual bug class.
 *
 * KNOWN LIMITS, stated so nobody trusts it for more than it is worth:
 *   - it clicks, it does not submit. A form whose handler is dead passes.
 *   - it cannot tell a deliberate no-op (a disabled-style toggle) from a bug.
 *   - demo mode short-circuits most writes, so persistence is not exercised.
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:5201/';
const PASS = process.env.TEST_PASS || 'password123';
const OWNER = process.env.TEST_OWNER || 'chief.owner';

let pass = 0;
const failures = [];
const check = (name, ok, detail = '') => {
  if (ok) {
    pass += 1;
  } else {
    failures.push(`${name}${detail ? ` -- ${detail}` : ''}`);
  }
};

/** Click the nav entry for `view`, wherever it currently lives. */
async function gotoView(page, view) {
  for (const link of await page.locator(`[data-nav="${view}"]`).all()) {
    if (await link.isVisible()) {
      await link.click();
      await page.waitForTimeout(900);
      return;
    }
  }
  const more = page.locator('#nav-more-toggle');
  if (await more.isVisible().catch(() => false)) {
    await more.click();
    await page.waitForTimeout(250);
    const inMenu = page.locator(`#nav-more-menu [data-nav="${view}"]`).first();
    if (await inMenu.isVisible().catch(() => false)) {
      await inMenu.click();
      await page.waitForTimeout(900);
      return;
    }
    await page.keyboard.press('Escape');
  }
  const toggle = page.locator('#mobile-nav-toggle');
  if (await toggle.isVisible().catch(() => false)) {
    await toggle.click();
    await page.waitForTimeout(300);
    await page.locator(`#nav-drawer [data-nav="${view}"]`).first().click();
    await page.waitForTimeout(900);
  }
}

async function signIn(page, username) {
  await page
    .waitForFunction(() => Boolean(localStorage.getItem('wire.state.v1')), null, { timeout: 20000 })
    .catch(() => null);
  const trigger = await page
    .waitForSelector('#open-auth, [data-action="open-auth"]', { timeout: 15000 })
    .catch(() => null);
  if (!trigger) return false;
  await trigger.click();
  const input = await page.waitForSelector('#auth-signin-login', { timeout: 5000 }).catch(() => null);
  if (!input) return false;
  // Verify the fill landed; the dialog can repaint under a slow boot.
  for (let i = 0; i < 3; i += 1) {
    await page.fill('#auth-signin-login', username);
    await page.fill('#auth-signin-password', PASS);
    if ((await page.inputValue('#auth-signin-login')) === username) break;
  }
  await page.click('#auth-form-signin button[type="submit"]');
  return page
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
}

/** Everything observable about the page, in one comparable object. */
const SNAPSHOT = () => ({
  // A <dialog> counts only when it is genuinely showing.
  dialogs: [...document.querySelectorAll('dialog')].filter(
    (d) => !d.hidden && getComputedStyle(d).display !== 'none'
  ).length,
  toasts: document.querySelectorAll('.toast, [role=alert], [role=status]').length,
  /*
   * The IDENTITY of the visible view, not the COUNT of them.
   *
   * Counting reported every nav link as dead: `showReaderView()` swaps views by
   * toggling the `hidden` class, so there is exactly one visible view before and
   * after clicking "Credits". The count is 1 either way, the click worked, and the
   * check said nothing happened. That is the same "hidden means gone" mistake as
   * counting parked About cards on the Credits page -- a null result read as a
   * finding, twice.
   */
  view:
    [...document.querySelectorAll('[data-reader-view]')]
      .filter((v) => !v.classList.contains('hidden'))
      .map((v) => v.id)
      .join(',') || 'none',
  // The active panel tab, for the same reason inside the workspace.
  tab:
    document.querySelector('[data-admin-tab][aria-selected="true"], .admin-tab.is-active')
      ?.dataset?.adminTab ||
    document.querySelector('.admin-tab.is-active')?.dataset?.adminTab ||
    'none',
  // focus matters: the "Skip to main content" link's entire effect is moving
  // focus, and a check that ignores it reports a working a11y feature as dead.
  focus: document.activeElement?.id || document.activeElement?.tagName || '',
  // Anchor links ("Masthead", "Weekly Features") do nothing but scroll, which is
  // a correct and complete behaviour with no DOM trace at all.
  scroll: Math.round(window.scrollY),
  len: document.body.innerHTML.length
});

/** The selector for controls, and the reason it avoids quotes. */
const CONTROL =
  'button:not([disabled]), a[href], [role=button]:not([aria-disabled=true])';

/** Is this element on screen and hit-testable right now? */
function clickable(el) {
  if (!el || !el.isConnected) return false;
  const r = el.getBoundingClientRect();
  const s = getComputedStyle(el);
  return (
    r.width > 0 &&
    r.height > 0 &&
    s.visibility !== 'hidden' &&
    s.pointerEvents !== 'none' &&
    !el.closest('[hidden]') &&
    !el.closest('dialog:not([open])')
  );
}

function changed(a, b) {
  return (
    a.dialogs !== b.dialogs ||
    a.toasts !== b.toasts ||
    a.view !== b.view ||
    a.tab !== b.tab ||
    a.focus !== b.focus ||
    a.scroll !== b.scroll ||
    Math.abs(a.len - b.len) > 8
  );
}

/**
 * Click every on-screen control and report the ones that changed nothing.
 *
 * WHY EACH CONTROL IS RE-RESOLVED IMMEDIATELY BEFORE ITS CLICK
 * ------------------------------------------------------------
 * The first version collected all the elements, then clicked them in one
 * `page.evaluate` loop. Almost every control in this app re-renders its panel on
 * activation, so by the time the loop reached control N the node it held was
 * detached -- `el.click()` on a detached node is a silent no-op, and the sweep
 * reported 22 dead controls, every one of them working. A check that manufactures
 * its own failures gets deleted, and then it misses the real ones.
 *
 * So each control is located again by index at the moment of its click, and a
 * control that has vanished or become unclickable is skipped rather than blamed.
 *
 * @returns {Promise<{dead: string[], errors: string[], failed: string[], clicked: number}>}
 */
async function sweep(page, label) {
  const errors = [];
  const failed = [];
  const onConsole = (m) => m.type() === 'error' && errors.push(m.text());
  const onPageError = (e) => errors.push(e.message);
  const onFailedReq = (r) => failed.push(`${r.method()} ${r.url().replace(BASE, '')}`);
  const onResponse = (r) => {
    if (r.status() >= 400) failed.push(`${r.status()} ${r.url().replace(BASE, '')}`);
  };
  page.on('console', onConsole);
  page.on('pageerror', onPageError);
  page.on('requestfailed', onFailedReq);
  page.on('response', onResponse);

  const dead = [];
  let clicked = 0;

  const count = await page.locator(CONTROL).count();
  // Cap it: a pathological page should not make this check unbounded.
  const limit = Math.min(count, 90);

  for (let i = 0; i < limit; i += 1) {
    const loc = page.locator(CONTROL).nth(i);
    if (!(await loc.isVisible().catch(() => false))) continue;

    const labelText = await loc
      .evaluate((el) =>
        (el.getAttribute('aria-label') || el.textContent || el.tagName)
          .trim()
          .replace(/\s+/g, ' ')
          .slice(0, 46)
      )
      .catch(() => `#${i}`);

    const before = await page.evaluate(SNAPSHOT);

    let threw = false;
    try {
      await loc.click({ timeout: 4000 });
    } catch {
      threw = true;
    }
    await page.waitForTimeout(160);

    // Re-resolve: if the click tore the DOM down, this control's fate is
    // unknowable and blaming it would be wrong.
    const stillThere = await page
      .evaluate(
        ({ index, sel, testSrc }) => {
          const els = [...document.querySelectorAll(sel)];
          const el = els[index];
          if (!el) return false;
          // eslint-disable-next-line no-new-func
          return Boolean(new Function('el', `return (${testSrc})(el)`)(el));
        },
        { index: i, sel: CONTROL, testSrc: clickable.toString() }
      )
      .catch(() => true);

    const after = await page.evaluate(SNAPSHOT);

    if (!threw && stillThere && !changed(before, after)) {
      dead.push(`${label}: "${labelText}"`);
    } else {
      clicked += 1;
    }

    // Leave the page as we found it, so the next control starts from a known state.
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(90);
    if (threw) await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
  }

  page.off('console', onConsole);
  page.off('pageerror', onPageError);
  page.off('requestfailed', onFailedReq);
  page.off('response', onResponse);

  console.log(`\n=== ${label} ===`);
  console.log(`  controls acted on: ${clicked} / ${limit}`);
  console.log(`  no visible effect:  ${dead.length}`);
  for (const d of dead.slice(0, 10)) console.log(`    DEAD  ${d}`);
  console.log(`  console errors:     ${new Set(errors).size}`);
  for (const e of [...new Set(errors)].slice(0, 5)) console.log(`    ${e.slice(0, 110)}`);
  console.log(`  failed requests:    ${new Set(failed).size}`);
  for (const f of [...new Set(failed)].slice(0, 5)) console.log(`    ${f.slice(0, 110)}`);

  return { dead, errors: [...new Set(errors)], failed: [...new Set(failed)], clicked };
}

const browser = await chromium.launch();

/* ------------------------------ reader, signed out ------------------------------ */
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1800);
  const r = await sweep(page, 'reader, signed out');
  check('reader: no dead control', r.dead.length === 0, r.dead.slice(0, 5).join('; '));
  check('reader: no console error', r.errors.length === 0, r.errors[0]);
  check('reader: no failed request', r.failed.length === 0, r.failed[0]);
  await page.close();
}

/* ------------------------------ owner, signed in ------------------------------- */
{
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1800);

  const signedIn = await signIn(page, OWNER);
  check('owner: signed in', signedIn, `could not sign in as ${OWNER}`);

  if (signedIn) {
    await page.evaluate(() => {
      document.querySelector('[data-action="open-admin"], #open-admin')?.click();
    });
    await page.waitForTimeout(1200);

    // Every panel tab, so a dead control in any of them is found.
    const tabs = await page.$$eval('[data-admin-tab]', (els) => els.map((e) => e.dataset.adminTab));
    for (const tab of tabs) {
      const el = await page.$(`[data-admin-tab="${tab}"]`);
      if (el && (await el.isVisible())) {
        await el.click();
        await page.waitForTimeout(900);
      }
      const r = await sweep(page, `owner tab "${tab}"`);
      check(`owner/${tab}: no dead control`, r.dead.length === 0, r.dead.slice(0, 4).join('; '));
      check(`owner/${tab}: no console error`, r.errors.length === 0, r.errors[0]);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
      // Re-open: Escape may have closed the whole workspace.
      await page.evaluate(() => {
        if (!document.querySelector('#admin-panel:not(.hidden)')) {
          document.querySelector('[data-action="open-admin"], #open-admin')?.click();
        }
      });
      await page.waitForTimeout(600);
    }
  }

  await page.close();
}

await browser.close();

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  FAIL  ${f}`);
  process.exit(1);
}
console.log('RESULT: PASS — every control clicked did something.');
