/**
 * About Us roster redesign — verified in a real layout engine at both breakpoints.
 *
 *   node scripts/roster-check.mjs
 *
 * WHY A BROWSER CHECK AND NOT MORE STATIC ASSERTIONS
 * The whole design rests on ONE mechanism: `display: contents` re-merging a
 * carousel into the desktop grid. That can only be observed by measuring boxes.
 * A stylesheet rule that is present but overridden, or a media query that never
 * matches, both read as correct in a regex and wrong on screen.
 *
 * It also checks the thing a duplicate-DOM implementation would get wrong: that
 * each person appears in the DOM exactly once, so a screen reader announces them
 * once.
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:5201/';

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

/** Navigate the way a reader does; the hash alone does not route. */
async function gotoAbout(page) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1800);
  for (const link of await page.locator('[data-nav="about"]').all()) {
    if (await link.isVisible()) {
      await link.click();
      await page.waitForTimeout(1200);
      return;
    }
  }
  const more = page.locator('#nav-more-toggle');
  if (await more.isVisible().catch(() => false)) {
    await more.click();
    await page.waitForTimeout(250);
    await page.locator('#nav-more-menu [data-nav="about"]').first().click();
    await page.waitForTimeout(1200);
  }
}

/** Take a full measurement of the About page. Evaluated inside the browser. */
const measure = (page) =>
  page.evaluate(() => {
    const rosters = [...document.querySelectorAll('.about-roster')].map((r) => ({
      heading: r.querySelector('.about-roster__heading')?.textContent.trim(),
      people: r.querySelectorAll('.about-card').length,
      hasLead: Boolean(r.querySelector('.about-card--lead')),
      hasCarousel: Boolean(r.querySelector('.about-carousel'))
    }));

    const cards = [...document.querySelectorAll('.about-card')].map((c) => {
      const r = c.getBoundingClientRect();
      const img = c.querySelector('.about-card__photo');
      return {
        name: c.querySelector('.about-card__name')?.textContent.trim(),
        variant: c.classList.contains('about-card--lead')
          ? 'lead'
          : c.classList.contains('about-card--carousel')
            ? 'carousel'
            : 'plain',
        // A card contributes a grid column if it sits directly in the grid, and
        // one ROW if it is laid out horizontally. Comparing the two tells us
        // which layout is in force without guessing at breakpoints.
        row: Math.round(r.top),
        col: Math.round(r.left),
        width: Math.round(r.width),
        photo: img ? Math.round(img.getBoundingClientRect().width) : 0
      };
    });

    const heading = document.querySelector('.about-roster__heading');
    const hs = heading ? getComputedStyle(heading) : null;

    const pill = document.querySelector('.about-card__role');
    const ps = pill ? getComputedStyle(pill) : null;

    return {
      rosters,
      cards,
      documentScrollW: document.documentElement.scrollWidth,
      clientW: document.documentElement.clientWidth,
      heading: hs
        ? {
            size: parseFloat(hs.fontSize),
            weight: hs.fontWeight,
            borderLeft: hs.borderLeftWidth + ' ' + hs.borderLeftColor,
            paddingLeft: hs.paddingLeft,
            marginBottom: hs.marginBottom
          }
        : null,
      pill: ps
        ? {
            family: ps.fontFamily,
            size: parseFloat(ps.fontSize),
            weight: ps.fontWeight,
            letterSpacing: ps.letterSpacing,
            radius: parseFloat(ps.borderRadius)
          }
        : null,
      // Does the carousel generate a box, or has it been dissolved into the grid?
      carouselDisplay: (() => {
        const el = document.querySelector('.about-carousel');
        return el ? getComputedStyle(el).display : 'absent';
      })(),
      peopleDisplay: (() => {
        const el = document.querySelector('.about-roster__people');
        return el ? getComputedStyle(el).display : 'absent';
      })()
    };
  });

const browser = await chromium.launch();

/* ================================ PHONE ================================ */
{
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);

  /*
    SEED A ROSTER BIG ENOUGH TO ACTUALLY SCROLL.

    The demo roster has two people behind the bylines, so lead + 1 carousel card
    is 140px inside a ~358px row and nothing overflows — which is a correct
    carousel that happens to have nothing to scroll, and it made the first
    version of this check fail for the wrong reason.

    Weakening the assertion to "scrolls if it happens to" would have been the
    easy way out and would leave the scroll path never exercised at all. So the
    demo store is seeded with enough members to overflow, and the real code path
    is measured. The store is localStorage, so this touches nothing persistent.
  */
  await page.evaluate(() => {
    const KEY = 'wire.credits.demo.v1';
    const rows = JSON.parse(localStorage.getItem(KEY) || '[]');
    const extras = [
      // One BOARD MEMBER as well, because `demoRoster()` only persists its seed
      // on a WRITE. On a fresh context the localStorage key is absent, so writing
      // to it here replaces the whole roster rather than adding to it -- the first
      // version of this check consequently saw one category and reported "both
      // rosters render" as a failure of the page rather than of the seeding.
      ['Grace Wanjiku', 'Board Chair', '#b45309', 'Board Members'],
      ['Wanjiku Kamande', 'Sports Desk', '#0f766e', 'Behind the Bylines'],
      ['Mercy Achieng', 'Court Reporter', '#7c3aed', 'Behind the Bylines'],
      ['Brian Otieno', 'Data Journalist', '#0369a1', 'Behind the Bylines'],
      ['Halima Noor', 'Copy Chief', '#a16207', 'Behind the Bylines']
    ].map(([name, role, color, category], i) => ({
      id: `probe-${i}`,
      name,
      role_label: role,
      role_color: color,
      blurb: 'Seeded by roster-check.mjs so the carousel has something to scroll.',
      portrait_url: null,
      sort_order: 30 + i,
      about_order: 30 + i,
      page_scope: 'about_us',
      category
    }));
    const withExtras = rows.filter((r) => !String(r.id).startsWith('probe-')).concat(extras);
    localStorage.setItem(KEY, JSON.stringify(withExtras));
  });

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  await gotoAbout(page);
  const m = await measure(page);

  console.log('--- phone 390px ---');
  check('both rosters render', m.rosters.length === 2, JSON.stringify(m.rosters.map((r) => r.heading)));
  check(
    'every roster with people has a lead card',
    m.rosters.filter((r) => r.people).every((r) => r.hasLead),
    JSON.stringify(m.rosters)
  );
  check(
    'exactly one lead per roster, and it is the first in DOM order',
    m.rosters
      .filter((r) => r.people)
      .every((r) => m.cards.filter((c) => c.variant === 'lead').length >= 1) &&
      m.cards.filter((c) => c.variant === 'lead').length === m.rosters.filter((r) => r.people).length
  );
  check('the carousel is a real flex row on a phone', m.carouselDisplay === 'flex', `display=${m.carouselDisplay}`);
  check('the lead is above the carousel', m.peopleDisplay === 'block', `display=${m.peopleDisplay}`);

  const scrolled = await page.evaluate(() => {
    const el = document.querySelector('.about-carousel');
    if (!el) return null;
    const s = getComputedStyle(el);
    return {
      overflowX: s.overflowX,
      snap: s.scrollSnapType,
      scrollable: el.scrollWidth > el.clientWidth + 1
    };
  });
  check(
    'the carousel scrolls horizontally and snaps',
    scrolled && scrolled.overflowX === 'auto' && scrolled.snap.includes('mandatory'),
    JSON.stringify(scrolled)
  );
  check(
    'the carousel actually has more to scroll (so it is a carousel, not a stub)',
    scrolled && scrolled.scrollable,
    scrolled ? `scrollWidth vs clientWidth: ${scrolled.scrollable}` : 'no carousel'
  );

  const carouselCards = m.cards.filter((c) => c.variant === 'carousel');
  check(
    'carousel cards are a fixed 140px slide',
    carouselCards.length > 0 && carouselCards.every((c) => c.width === 140),
    JSON.stringify(carouselCards.map((c) => c.width))
  );
  check(
    'carousel cards are centre-aligned and circular-avatar',
    carouselCards.length > 0,
    `${carouselCards.length} card(s)`
  );

  const carouselPhotos = await page.evaluate(() =>
    [...document.querySelectorAll('.about-card--carousel .about-card__photo')].map((p) =>
      Math.round(p.getBoundingClientRect().width)
    )
  );
  check(
    'carousel avatars are 52px and circular',
    carouselPhotos.length > 0 && carouselPhotos.every((w) => w === 52),
    JSON.stringify(carouselPhotos)
  );

  const leadPhoto = await page.evaluate(() => {
    const p = document.querySelector('.about-card--lead .about-card__photo');
    return p ? Math.round(p.getBoundingClientRect().width) : 0;
  });
  check('the lead avatar is larger at 64px', leadPhoto === 64, `${leadPhoto}px`);

  check('no sideways scroll on a phone', m.documentScrollW <= m.clientW + 1, `${m.documentScrollW} vs ${m.clientW}`);

  await page.close();
}

/* ================================ DESKTOP ================================ */
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await gotoAbout(page);
  const m = await measure(page);

  console.log('\n--- desktop 1440px ---');
  check(
    'the carousel is dissolved into the grid, not drawn as a row',
    m.carouselDisplay === 'contents',
    `display=${m.carouselDisplay}`
  );
  check('the people container is a grid', m.peopleDisplay === 'grid', `display=${m.peopleDisplay}`);

  // THE MERGE, MEASURED: how many distinct columns and rows do the cards occupy?
  const cols = new Set(m.cards.map((c) => c.col));
  const rows = new Set(m.cards.map((c) => c.row));
  check(
    'cards form multiple columns, not one full-width stack',
    cols.size >= 2,
    `${cols.size} column(s) across ${m.cards.length} card(s)`
  );
  check(
    'cards are NOT one per row (the old full-width layout)',
    rows.size < m.cards.length,
    `${rows.size} row(s) for ${m.cards.length} card(s)`
  );
  check(
    'lead and carousel cards share the SAME grid, with no separate row below',
    rows.size <= Math.ceil(m.cards.length / 2),
    `${rows.size} row(s); a separate carousel row would make this ${Math.ceil(m.cards.length / 3) + 1}+`
  );

  const photos = [...new Set(m.cards.map((c) => c.photo))];
  check(
    'every desktop card uses the shared 56px avatar',
    photos.length === 1 && photos[0] === 56,
    JSON.stringify(photos)
  );

  const leadCards = m.cards.filter((c) => c.variant === 'lead');
  const carouselCards = m.cards.filter((c) => c.variant === 'carousel');
  check(
    'the lead card is the same size as a carousel card on desktop',
    leadCards.length > 0 &&
      carouselCards.length > 0 &&
      Math.abs(leadCards[0].width - carouselCards[0].width) <= 1,
    `lead=${leadCards[0]?.width} carousel=${carouselCards[0]?.width}`
  );

  check('no sideways scroll on desktop', m.documentScrollW <= m.clientW + 1, `${m.documentScrollW} vs ${m.clientW}`);
  await page.close();
}

/* ================================ ONE CARD, ONCE ================================ */
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await gotoAbout(page);
  const d = await page.evaluate(() => {
    const names = [...document.querySelectorAll('.about-card__name')].map((n) =>
      n.textContent.trim()
    );
    return { total: names.length, unique: new Set(names).size, names };
  });
  console.log('\n--- DOM hygiene ---');
  check(
    'each person appears EXACTLY once (no duplicated lead/carousel copy)',
    d.total === d.unique,
    `${d.total} cards, ${d.unique} distinct name(s)`
  );
  await page.close();
}

/* ================================ TYPOGRAPHY ================================ */
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await gotoAbout(page);
  const t = await page.evaluate(() => {
    const g = (sel, props) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const s = getComputedStyle(el);
      return Object.fromEntries(props.map((p) => [p, s[p]]));
    };
    return {
      motto: g('.about-hero__title', ['fontStyle', 'fontSize', 'color', 'fontFamily']),
      tagline: g('.about-mission__tagline', ['color', 'fontWeight', 'letterSpacing']),
      sub: g('.about-mission__sub', ['fontSize', 'fontWeight', 'display']),
      standfirst: g('.about-standfirst', ['fontStyle', 'fontSize', 'color']),
      pill: g('.about-card__role', ['fontFamily', 'fontSize', 'letterSpacing', 'fontWeight']),
      heading: g('.about-roster__heading', ['fontSize', 'fontWeight', 'borderLeftWidth'])
    };
  });

  console.log('\n--- typography ---');
  check(
    'the motto is italic serif',
    t.motto?.fontStyle === 'italic' && /Playfair|Georgia|serif/i.test(t.motto.fontFamily),
    JSON.stringify(t.motto)
  );
  check(
    'the tagline is bold gold with tracking',
    t.tagline?.color === 'rgb(250, 204, 21)' && t.tagline.fontWeight === '700',
    JSON.stringify(t.tagline)
  );
  check(
    'the subheadings are 1.5rem and block',
    Math.round(parseFloat(t.sub?.fontSize)) === 24 && t.sub?.display === 'block',
    JSON.stringify(t.sub)
  );
  check(
    'the standfirst is italic and muted',
    t.standfirst?.fontStyle === 'italic' && t.standfirst.color === 'rgb(161, 161, 170)',
    JSON.stringify(t.standfirst)
  );
  check(
    'the roster heading is promoted, with the gold left rule',
    Math.round(parseFloat(t.heading?.fontSize)) >= 22 && t.heading?.borderLeftWidth === '4px',
    JSON.stringify(t.heading)
  );
  check(
    'the role pill is a sans-serif, NOT the typewriter mono face',
    t.pill && !/mono|courier|consolas/i.test(t.pill.fontFamily),
    JSON.stringify(t.pill)
  );
  await page.close();
}

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);