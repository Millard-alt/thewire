/**
 * Layout check: the header fits, and nothing scrolls sideways.
 *
 * Two bugs shipped here that no unit test could see, and both were the same
 * shape -- the row was WIDER than the viewport and nothing said so:
 *
 *   1. The nav row is a flex line whose items default to `flex-shrink: 1`, so a
 *      row that is slightly too wide COMPRESSES instead of overflowing, and
 *      multi-word labels wrap inside their own boxes. "Today's Pick" measured
 *      41px tall next to "Weekly" at 24.5px.
 *
 *   2. The overflow menu's fit test summed only the FIVE movable items (416px)
 *      against 514px of space, decided "it fits", moved nothing -- while the
 *      five fixed links the reader cannot avoid took another 530px it never
 *      counted. The page then scrolled sideways by up to 295px on a 768px tablet.
 *
 * Both are measured here against a real layout engine, at the widths where they
 * appeared, because the alternative is finding out from a reader.
 *
 *   node node_modules/vite/bin/vite.js --mode demo --port 5201
 *   BASE_URL=http://localhost:5201/ node scripts/layout-check.mjs
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:5201/';

/**
 * Each width is a case that actually broke, plus the extremes.
 *
 * 320 is the tightest phone still in use and is where the auth button's label
 * was 85px too wide. 768 is the tablet where the nav overflowed by 295px.
 */
const WIDTHS = [
  { w: 320, h: 700, why: 'tightest phone' },
  { w: 360, h: 740, why: 'common android' },
  { w: 390, h: 844, why: 'iphone' },
  { w: 768, h: 900, why: 'tablet, nav overflowed here' },
  { w: 900, h: 800, why: 'small laptop' },
  { w: 1440, h: 900, why: 'desktop' }
];

const results = [];
const browser = await chromium.launch();

for (const { w, h, why } of WIDTHS) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1600);

  const measured = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;

    // Anything actually sticking out past the viewport. `position: fixed`
    // elements are excluded: a drawer is SUPPOSED to be as wide as the screen.
    const offenders = [];
    for (const el of document.querySelectorAll('body *')) {
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      if (style.position === 'fixed') continue;
      const r = el.getBoundingClientRect();
      if (!r.width) continue;
      const over = Math.max(r.right - vw, -r.left);
      if (over > 1) {
        offenders.push(
          `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''} +${Math.round(over)}px`
        );
      }
    }

    const bar = document.querySelector('.nav-bar');
    const list = document.querySelector('#primary-links');
    const visible = [...list.querySelectorAll('li')].filter((li) => !li.hidden && li.offsetParent);

    // Every visible nav label must sit on ONE line. This is the squeeze check:
    // a wrapped label shows up as a taller box, not as an overflow.
    const heights = new Set(
      visible.map((li) => Math.round(li.getBoundingClientRect().height))
    );

    const inline = visible.length;
    const inMore = document.querySelectorAll('#nav-more-menu li').length;
    const drawerHidesInline = inline === 0;

    return {
      vw,
      docScrollW: document.documentElement.scrollWidth,
      offenders: [...new Set(offenders)],
      barHeight: Math.round(bar.getBoundingClientRect().height),
      distinctNavHeights: [...heights],
      inline,
      inMore,
      // inline + inMore must equal the 10 destinations once the drawer is
      // accounted for: 5 primary + 5 overflow candidates.
      totalDestinations: inline + inMore,
      drawerItems: document.querySelectorAll('#nav-drawer__list, .nav-drawer__item').length,
      burgerVisible: document.querySelector('#mobile-nav-toggle')?.offsetParent !== null
    };
  });

  const problems = [];
  if (measured.docScrollW > measured.vw + 1) {
    problems.push(
      `page scrolls sideways by ${measured.docScrollW - measured.vw}px ` +
        `(offenders: ${measured.offenders.slice(0, 3).join(', ') || 'none found'})`
    );
  }
  if (measured.offenders.length) {
    problems.push(`${measured.offenders.length} element(s) past the viewport`);
  }
  if (measured.distinctNavHeights.length > 1) {
    problems.push(
      `nav labels sit at ${measured.distinctNavHeights.join('/')}px -- ` +
        'a squeezed flex item wraps its own text instead of overflowing'
    );
  }
  if (!measured.burgerVisible && measured.totalDestinations !== 10) {
    problems.push(
      `${measured.totalDestinations} destinations reachable, expected 10 ` +
        '(the menu lists an item twice, or one is unreachable)'
    );
  }
  if (measured.burgerVisible && measured.drawerItems < 9) {
    problems.push(`drawer lists ${measured.drawerItems} destinations, expected 9`);
  }
  if (errors.length) problems.push(`console: ${errors[0]}`);

  results.push({ w, why, measured, problems });

  const flag = problems.length ? 'FAIL' : 'PASS';
  console.log(
    `${flag}  ${String(w).padStart(4)}px  scrollW=${measured.docScrollW}  ` +
      `nav=${measured.barHeight}px  inline=${measured.inline}+more=${measured.inMore}  ` +
      `drawer=${measured.drawerItems}  (${why})`
  );
  for (const p of problems) console.log(`        ${p}`);

  await page.close();
}

await browser.close();

const failed = results.filter((r) => r.problems.length);
const total = results.length * 4;
const passed = total - failed.reduce((sum, r) => sum + r.problems.length, 0);

console.log(`\n${passed}/${total} layout checks passed`);
if (failed.length) {
  console.log('RESULT: FAIL — the layout does not fit.');
  process.exit(1);
}
console.log('RESULT: PASS — no horizontal overflow, and every destination is reachable.');
