/**
 * Scoped-roster probe: the About Us page and the Credits page must not see each
 * other, in the DOM or in the network payload.
 *
 * THE BLEED THIS GUARDS AGAINST
 * The old design selected every `credits_people` row and filtered in the browser.
 * That is not separation: the board's names, roles, notes and photo URLs were
 * all in the HTML of the Credits page for a reader who never opened About Us.
 * So this asserts on BOTH the rendered text AND the raw response the page
 * actually received, which is the only place the old bug was visible.
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:5201/';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

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

// Collect every credits_people response body the page receives.
const payloads = [];
page.on('response', async (res) => {
  if (!/credits_people/.test(res.url())) return;
  try {
    payloads.push(await res.text());
  } catch {
    /* body already consumed or aborted; the DOM checks still apply */
  }
});

/* ============================== /about ============================== */
/**
 * Navigate by CLICKING the nav link, not by setting location.hash.
 *
 * The reader router is driven entirely by `wire:navigate`, dispatched from the
 * `[data-nav]` click handlers in app.js — there is no `hashchange` listener, and
 * navigation uses `history.replaceState`, so a hash-only jump does nothing at
 * all. Poking the hash directly left this probe measuring the /about page while
 * it believed it was on /credits.
 *
 * (That gap is pre-existing and out of scope here: browser Back does not walk
 * between reader views. Worth knowing, not fixed by this change.)
 *
 * THREE PLACES A NAV LINK CAN BE, all of which occur at 1280px:
 * inline in the bar, folded into the "More" disclosure, or in the mobile drawer.
 * A destination moved into the More menu is still in the DOM but inside a
 * `hidden` <li>, so `.first()` finds an invisible element and the click hangs --
 * which is exactly what the first version of this helper did.
 */
async function gotoView(page, view) {
  // Inline, if it is actually visible.
  for (const link of await page.locator(`[data-nav="${view}"]`).all()) {
    if (await link.isVisible()) {
      await link.click();
      await page.waitForTimeout(1400);
      return;
    }
  }

  // "More" disclosure.
  const more = page.locator('#nav-more-toggle');
  if (await more.isVisible().catch(() => false)) {
    await more.click();
    await page.waitForTimeout(300);
    const inMenu = page.locator(`#nav-more-menu [data-nav="${view}"]`).first();
    if (await inMenu.isVisible().catch(() => false)) {
      await inMenu.click();
      await page.waitForTimeout(1400);
      return;
    }
    await page.keyboard.press('Escape');
  }

  // Mobile drawer.
  const toggle = page.locator('#mobile-nav-toggle');
  if (await toggle.isVisible().catch(() => false)) {
    await toggle.click();
    await page.waitForTimeout(350);
    await page.locator(`#nav-drawer [data-nav="${view}"]`).first().click();
    await page.waitForTimeout(1400);
    return;
  }

  throw new Error(`no visible nav entry for "${view}"`);
}

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1600);
await gotoView(page, 'about');

const about = await page.evaluate(() => ({
  // The two About headings must both render.
  headings: [...document.querySelectorAll('.about-roster__heading')].map((h) =>
    h.textContent.trim()
  ),
  cards: [...document.querySelectorAll('.about-card')].map((c) => ({
    name: c.querySelector('.about-card__name')?.textContent.trim(),
    role: c.querySelector('.about-card__role')?.textContent.trim(),
    note: c.querySelector('.about-card__note')?.textContent.trim()
  })),
  // Any pill rendered as a SOLID block is the old bug, not the new design.
  solidBadges: [...document.querySelectorAll('.about-card__role')].filter((b) => {
    const bg = getComputedStyle(b).backgroundColor;
    // An rgba wash is translucent; a solid slab is opaque.
    const m = bg.match(/rgba?\(([^)]+)\)/);
    if (!m) return false;
    const parts = m[1].split(',').map((s) => parseFloat(s));
    return parts.length < 4 || parts[3] >= 0.85;
  }).length
}));

console.log('\n--- /about ---');
check('both About rosters render as headings', about.headings.length === 2, about.headings.join(' | '));
check('team cards rendered', about.cards.length > 0, `${about.cards.length} card(s)`);
check(
  'every About card has a name',
  about.cards.every((c) => c.name),
  JSON.stringify(about.cards.map((c) => c.name))
);
check(
  'no role badge is an opaque slab',
  about.solidBadges === 0,
  `${about.solidBadges} badge(s) painted solid`
);

/* ============================== /credits ============================== */
const aboutNames = about.cards.map((c) => c.name).filter(Boolean);
const beforeCredits = payloads.length;
await gotoView(page, 'credits');

const credits = await page.evaluate(() => {
  /**
   * Count only what a reader can SEE.
   *
   * `showReaderView()` parks a page by toggling the `hidden` CLASS on
   * `[data-reader-view]`, not the `hidden` attribute — so the parked page's cards
   * stay in the DOM permanently and `el.hidden` is `false` for all of them. The
   * first version of this check used a bare `document.querySelectorAll`, found the
   * parked About cards, and reported a bleed that does not exist.
   *
   * So "visible" has to mean: not inside any element carrying that class.
   */
  const parked = (el) => Boolean(el.closest('.hidden')) || el.hidden;
  const visibleCount = (sel) => {
    const el = document.querySelector(sel);
    return el && !parked(el) ? 1 : 0;
  };

  return {
    names: [...document.querySelectorAll('.credits-card__name')].map((n) => n.textContent.trim()),
    // The whole point: no About heading may be VISIBLE on this page.
    aboutHeadings: visibleCount('.about-roster__heading'),
    aboutCards: visibleCount('.about-card'),
    // And the About view must actually be the parked one right now.
    aboutParked: Boolean(document.querySelector('#about-view')?.classList.contains('hidden')),
    creditsShown: Boolean(
      document.querySelector('#credits-view') && !document.querySelector('#credits-view').classList.contains('hidden')
    )
  };
});

console.log('\n--- /credits ---');
check('credits cards rendered', credits.names.length > 0, `${credits.names.length} card(s)`);
check('the Credits view is the one showing', credits.creditsShown);
check('no About roster headings visible on /credits', credits.aboutHeadings === 0);
check('no About team cards visible on /credits', credits.aboutCards === 0);
check('the About view is parked', credits.aboutParked);

/*
 * THE PAYLOAD CHECK — the only one that could have caught the original bleed.
 *
 * AND IT IS VACUOUS IN DEMO MODE, which is worth stating plainly rather than
 * printing a green tick for it.
 *
 * `listPeopleInScope()` short-circuits to `demoRoster()` — localStorage — whenever
 * `config.demoMode` is on, so the browser issues no `credits_people` request at
 * all and `payloads` is empty. A check of the form
 * `payloads.length === 0 || payloads.every(...)` therefore passes no matter what
 * the query looks like: deleting `.eq('page_scope', wanted)` from the source
 * entirely still reported 23/23.
 *
 * That is the worst shape a guard can have — it looks like it covers the thing
 * and covers nothing. So:
 *
 *   * in demo mode it reports SKIP, not PASS;
 *   * the load-bearing version of this assertion is STATIC and lives in
 *     tests/features.mjs, which reads the source and requires both public
 *     readers to carry `.eq('page_scope', …)`. That one cannot be vacuous.
 *
 * Run with BASE_URL pointed at a real Supabase instance and this becomes a real
 * assertion again.
 */
const sawPayloads = payloads.length > 0;
const creditsPayload = payloads.slice(beforeCredits).join('\n');
const leakDetail = aboutNames.filter(
  (n) => !credits.names.includes(n) && creditsPayload.includes(n)
);

console.log('\n--- network payload ---');
if (!sawPayloads) {
  console.log(
    'SKIP  the Credits page never received an About Us name  -- no credits_people ' +
      'request was made, so there is nothing to inspect (demo mode reads ' +
      'localStorage). The static guard in tests/features.mjs covers this.'
  );
} else {
  check(
    'the Credits page never received an About Us name',
    leakDetail.length === 0,
    leakDetail.length ? `leaked: ${leakDetail.join(', ')}` : `${aboutNames.length} checked`
  );
  check(
    'every credits_people response is scope-filtered',
    payloads.every((p) => /page_scope/i.test(p) || !/"category"\s*:\s*"/.test(p)),
    `${payloads.length} response(s) inspected`
  );
}

/* ============================== role pill contrast ============================== */
const pills = await page.evaluate(() => {
  const out = [];
  for (const el of document.querySelectorAll('.role-pill')) {
    const s = getComputedStyle(el);
    // Walk up for the first non-transparent background: the card, not the page.
    let node = el;
    let bg = 'rgb(0,0,0)';
    while (node) {
      const c = getComputedStyle(node).backgroundColor;
      if (c && !/rgba\(0, 0, 0, 0\)|transparent/.test(c)) {
        bg = c;
        break;
      }
      node = node.parentElement;
    }
    out.push({
      text: el.textContent.trim(),
      color: s.color,
      bg,
      radius: s.borderRadius,
      spacing: s.letterSpacing,
      weight: s.fontWeight,
      size: s.fontSize
    });
  }
  return out;
});

/*
 * Back to /about: the pills under test live there, and the payload checks above
 * deliberately left the browser on /credits. Measuring them while that view is
 * parked found zero of them, which is the same "hidden means gone" mistake in a
 * new place.
 */
await gotoView(page, 'about');

/**
 * WCAG 2.1 relative luminance, WITH the sRGB transfer function.
 *
 * The first version of this probe omitted the `((c + 0.055) / 1.055) ** 2.4`
 * step, so it reported 4.05:1 for a colour that is really 8.60:1 and 2.89:1 for
 * one that is really 6.31:1. It then "failed" a palette that was correct � and
 * the obvious way to make the probe happy would have been to make the app
 * wrong. Measuring contrast with the wrong formula is worse than not measuring
 * it, because the failure looks like a finding.
 */
const lum = (rgb) => {
  const m = String(rgb).match(/rgba?\(([^)]+)\)/);
  if (!m) return 0;
  const ch = (raw) => {
    const v = parseFloat(raw) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = m[1].split(',').slice(0, 3).map(ch);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

/** Read every pill's text colour and the CARD it actually sits on. */
const readPills = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('.about-card__role, .role-pill')]
      .filter((el) => !el.closest('.hidden'))
      .map((el) => {
        // Walk up for the first background with REAL opacity: the card. The 12%
        // wash behind the pill itself is what the text sits on, but comparing
        // accent-to-wash measures almost nothing (1.00:1), so skip it — and skip
        // any other translucent layer on the way. Alpha >= 0.5 is the test.
        let node = el;
        let bg = 'rgb(0,0,0)';
        while (node) {
          const c = getComputedStyle(node).backgroundColor;
          const m = c && c.match(/rgba?\(([^)]+)\)/);
          const parts = m ? m[1].split(',').map(parseFloat) : [];
          const opaque = parts.length === 3 || (parts.length === 4 && parts[3] >= 0.5);
          if (opaque) {
            bg = c;
            break;
          }
          node = node.parentElement;
        }
        const s = getComputedStyle(el);
        const wash = el.getAttribute('style') || '';
        return {
          text: el.textContent.trim(),
          color: s.color,
          bg,
          washBg: s.backgroundColor,
          radius: s.borderRadius,
          spacing: s.letterSpacing,
          weight: s.fontWeight,
          size: s.fontSize,
          hasBothAccents:
            /--role-accent-light:/.test(wash) && /--role-accent-dark:/.test(wash)
        };
      })
  );

/*
 * BOTH THEMES.
 *
 * A single-theme check is exactly how the "lightened for the dark card" bug
 * survived in the first place: it passed in whichever theme happened to be on
 * screen when it was written. The site ships a theme toggle, so the pill has to
 * clear 4.5:1 in EACH, and `rolePalette()` emits both accents for that reason.
 */
for (const theme of ['light', 'dark']) {
  const already = await page.evaluate(() =>
    document.documentElement.classList.contains('dark')
  );
  if (theme === 'dark' !== already) {
    await page.evaluate(() => document.documentElement.classList.toggle('dark'));
    await page.waitForTimeout(300);
  }

  const pills = await readPills();
  console.log(`\n--- role pill (${theme} theme) ---`);

  check(`${theme}: pills found`, pills.length > 0, `${pills.length}`);
  check(
    `${theme}: every pill carries BOTH theme accents`,
    pills.every((p) => p.hasBothAccents),
    pills.filter((p) => !p.hasBothAccents).map((p) => p.text).join(', ')
  );
  check(
    `${theme}: pills are fully rounded`,
    pills.every((p) => parseFloat(p.radius) >= 999),
    pills.map((p) => p.radius).join(', ')
  );
  check(
    `${theme}: pills are uppercase-tracked and semibold at ~12px`,
    pills.every(
      (p) =>
        parseFloat(p.size) >= 11.5 &&
        parseFloat(p.size) <= 13.5 &&
        parseInt(p.weight, 10) >= 600 &&
        parseFloat(p.spacing) > 0
    ),
    pills.map((p) => `${p.size}/${p.weight}/${p.spacing}`).join(', ')
  );
  check(
    `${theme}: every wash is translucent, not a slab`,
    pills.every((p) => {
      const m = String(p.washBg).match(/rgba?\(([^)]+)\)/);
      if (!m) return false;
      const parts = m[1].split(',').map(parseFloat);
      return parts.length === 4 && parts[3] > 0 && parts[3] < 0.3;
    }),
    pills.map((p) => p.washBg).join(', ')
  );

  let worst = { ratio: Infinity, text: '', color: '', bg: '' };
  for (const p of pills) {
    const r = ratio(p.color, p.bg);
    if (r < worst.ratio) worst = { ratio: r, text: p.text, color: p.color, bg: p.bg };
  }
  check(
    `${theme}: worst pill clears 4.5:1`,
    worst.ratio >= 4.5,
    `${worst.ratio.toFixed(2)}:1 on "${(worst.text || '').slice(0, 24)}" ` +
      `(${worst.color} on ${worst.bg})`
  );
}
await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
