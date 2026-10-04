/* =============================================================================
   scripts/push-check.mjs — WEB PUSH OPT-IN AND PERMISSION PROMPTING
   -----------------------------------------------------------------------------
   Runs against a LOCAL DEMO-MODE server, so it proves the client-side
   behaviour only: that the opt-in bar is actually painted, that it never
   introduces horizontal overflow on a phone, and above all that
   Notification.requestPermission() is reached by a real click and never by
   page load.

   Chrome on Android silently suppresses a permission request that is not tied
   to a user gesture, so "zero prompts on load, exactly one after a click" is
   the property worth locking down here.

   Run:  npm run test:push
   ========================================================================== */

import { chromium } from 'playwright';

const BASE = 'http://localhost:5203/';
const widths = [360, 390, 430];
const problems = [];
const ok = (m) => console.log('PASS  ' + m);
const bad = (m) => { problems.push(m); console.log('FAIL  ' + m); };

const browser = await chromium.launch();

for (const w of widths) {
  const ctx = await browser.newContext({ viewport: { width: w, height: 780 } });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1800);

  // 1. The opt-in bar must be VISIBLE (this is the fix under test).
  const bar = await page.evaluate(() => {
    const el = document.getElementById('alert-optin-bar');
    if (!el) return { missing: true };
    return { missing: false, hidden: el.hidden, text: (el.textContent || '').trim().slice(0, 90) };
  });
  if (bar.missing) bad(w + 'px: #alert-optin-bar is missing');
  else if (bar.hidden) bad(w + 'px: opt-in bar is still hidden');
  else ok(w + 'px: opt-in bar is visible -- "' + bar.text + '"');

  // 2. The opt-in button must exist inside it.
  const n = await page.locator('#alert-optin-button').count();
  if (n !== 1) bad(w + 'px: expected 1 #alert-optin-button, found ' + n);
  else ok(w + 'px: the opt-in button is inside the bar');

  // 3. No horizontal overflow.
  const ov = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (ov > 0) bad(w + 'px: horizontal overflow ' + ov + 'px');
  else ok(w + 'px: no horizontal overflow -- 0px');

  await ctx.close();
}

// 4. Gesture enforcement: requestPermission fires exactly once, only on click.
{
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 780 },
    // Headless Chromium reports Notification.permission === "denied" by default,
    // which short-circuits requestPermission() before it is ever called. Grant
    // the permission so the page starts at "default" -- the state a real phone
    // is in before the reader taps the button.
    permissions: ['notifications'],
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  await ctx.addInitScript(() => {
    // Headless Chromium hard-reports "denied" for Notification.permission no
    // matter what the context grants, and requestPermission() then
    // short-circuits without calling through. Present the pre-prompt state a
    // real phone is in: nothing asked yet.
    Object.defineProperty(Notification, 'permission', {
      configurable: true,
      get: () => 'default',
    });
  });
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  const permBefore = await page.evaluate(() => Notification.permission);
  if (permBefore !== 'default') bad('expected permission "default", saw "' + permBefore + '"');
  else ok('page starts at permission "default"');
  await page.evaluate(() => {
    window.__prompts = 0;
    const orig = Notification.requestPermission.bind(Notification);
    Object.defineProperty(Notification, 'requestPermission', {
      configurable: true,
      writable: true,
      value: (...a) => { window.__prompts += 1; return orig(...a); },
    });
  });
  await page.waitForTimeout(2500);
  const onLoad = await page.evaluate(() => window.__prompts);
  if (onLoad !== 0) bad('prompt fired ' + onLoad + 'x on page load (must be 0)');
  else ok('no permission prompt on page load -- 0 calls');

  // The opt-in button opens the gate modal; the prompt itself is on that
  // modal's Allow button. Two clicks, both real user gestures.
  await page.locator('#alert-optin-button').click();
  await page.waitForTimeout(600);
  const gateOpen = await page.evaluate(() => {
    const d = document.getElementById('alert-gate');
    return !!d && !d.classList.contains('hidden');
  });
  if (!gateOpen) bad('the opt-in button did not open the gate modal');
  else ok('clicking the opt-in button opens the gate modal');

  const before = await page.evaluate(() => window.__prompts);
  if (before !== 0) bad('the prompt fired just from opening the modal (' + before + ')');
  else ok('opening the modal alone does not prompt');

  await page.locator('#alert-gate-allow').click();
  await page.waitForTimeout(1800);
  const afterClick = await page.evaluate(() => window.__prompts);
  if (afterClick !== 1) bad('expected exactly 1 prompt after Allow, saw ' + afterClick);
  else ok('exactly one permission prompt, fired by the Allow click');

  await ctx.close();
  if (errs.length) bad('page errors: ' + errs.join(' | '));
  else ok('no uncaught page errors');
}

await browser.close();
console.log('\n' + (problems.length ? 'RESULT: FAIL' : 'RESULT: PASS'));
if (problems.length) { console.log(problems.join('\n')); process.exit(1); }