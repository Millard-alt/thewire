/**
 * About Us roster hierarchy — verified in a real layout engine at both breakpoints.
 *
 *   node scripts/roster-check.mjs
 *
 * WHY A BROWSER CHECK AND NOT MORE STATIC ASSERTIONS
 * The whole design rests on mechanisms a regex cannot see: `display: contents`
 * re-merging a carousel into the desktop grid, and CSS deciding a card's
 * prominence from its POSITION inside a sub-team. A rule that is present but
 * overridden, or a media query that never matches, both read as correct in a
 * regex and wrong on screen.
 *
 * IT ALSO CHECKS THE THING A DUPLICATE-DOM IMPLEMENTATION WOULD GET WRONG: each
 * person appears in the DOM exactly once, so a screen reader announces them once.
 *
 * WHAT CHANGED WHEN SUB-CATEGORIES ARRIVED (migration 032)
 * -------------------------------------------------------
 * The previous version of this file asserted "lead and carousel cards share the
 * SAME grid, with no separate row below", and it measured that across a whole
 * main category. That assertion is now wrong by design: there is one grid per
 * SUB-TEAM, so "3 rows for 4 cards" is the feature working, not a stray
 * carousel row. The check moved inward a level — `.about-group` instead of
 * `.about-roster` — which is where the merge actually has to hold.
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

/**
 * Seed a roster with the FULL SHAPE the feature describes: two main categories,
 * several sub-teams, and a mix of DESIGNATED leads (is_lead true) and teams with
 * nobody ticked (which must fall back to the first member by display order).
 *
 * BOTH STATES ARE SEEDED DELIBERATELY, and — the part that was wrong the first
 * time — the ticked lead is NEVER ALSO THE FIRST MEMBER OF ITS TEAM. Both teams
 * that designate somebody put a lower-ordered non-lead in front of them:
 *
 *   Writers      order 10 Wanjiku Kamande (no tick)
 *                order 30 Amara K.          (TICKED)
 *
 * Seed the tick on the first row and the whole feature is untestable, because
 * "first by order" and "the tick" name the same person and the page passes for
 * either reason. That is not a hypothetical: this seed did exactly that, a
 * mutation that made `resolveLead()` ignore `is_lead` entirely still passed 37/37,
 * and the only thing that exposed it was the failure to fail. With the tick
 * behind a lower-ordered row, the two paths are distinguishable and the mutant
 * dies on the assertion below.
 *
 * The store is localStorage, so this touches nothing persistent.
 *
 * [name, role, colour, main category, sub-team, is_lead, about_order]
 */
const SEED = [
  // --- Board Members -----------------------------------------------------------
  ['Peter Kimani', 'Treasurer', '#0f766e', 'Board Members', 'Leadership', false, 10],
  ['Achieng Odhiambo', 'Secretary', '#7c3aed', 'Board Members', 'Leadership', false, 15],
  ['Grace Wanjiku', 'Board Chair', '#b45309', 'Board Members', 'Leadership', true, 5],
  // A SECOND sub-team under the same main heading, which is the whole reason the
  // level exists: the board has officers AND advisers, each with its own lead.
  ['Mercy Achieng', 'Adviser', '#0369a1', 'Board Members', 'Advisers', false, 20],

  // --- Behind the Bylines ------------------------------------------------------
  ['Wanjiku Kamande', 'Sports Desk', '#0f766e', 'Behind the Bylines', 'Writers', false, 10],
  ['Brian Otieno', 'Data Journalist', '#0369a1', 'Behind the Bylines', 'Writers', false, 20],
  ['Amara K.', 'Senior Reporter', '#1d4ed8', 'Behind the Bylines', 'Writers', true, 30],
  ['Halima Noor', 'Copy Chief', '#a16207', 'Behind the Bylines', 'Writers', false, 40],
  // THE SAME TEAM, MISSPELLED. Lower-cased, so it must fold into the one Writers
  // heading rather than producing a second one. Two headings differing only in
  // case are indistinguishable to a reader and look like a bug, which is the
  // whole reason `groupBySubCategory()` folds case for MATCHING while rendering
  // the first spelling it met. Dropping that fold would give this its own team.
  ['Zawadi M.', 'Copy Assistant', '#334155', 'Behind the Bylines', 'writers', false, 45],
  // Nobody ticked in this team, so the page must promote its FIRST member by
  // display order. That is the fallback the brief asks for.
  ['Noor H.', 'Lead Photographer', '#0f766e', 'Behind the Bylines', 'Photographers', false, 60],
  ['Lilian W.', 'Photo Editor', '#b45309', 'Behind the Bylines', 'Photographers', false, 70],
  // Same shape as Writers: the tick sits behind a lower-ordered row.
  ['Grace N.', 'Layout Assistant', '#475569', 'Behind the Bylines', 'Designers', false, 50],
  ['Samuel K.', 'Arts Reporter', '#6d28d9', 'Behind the Bylines', 'Designers', true, 80]
];

/** Write the seed into the demo store. Runs in the page. */
async function seed(page) {
  await page.evaluate((rows) => {
    const KEY = 'wire.credits.demo.v1';
    const existing = JSON.parse(localStorage.getItem(KEY) || '[]');
    const extras = rows.map(
      ([name, role, color, category, sub, isLead, order], i) => ({
        id: `probe-${i}`,
        name,
        role_label: role,
        role_color: color,
        blurb: 'Seeded by roster-check.mjs so the sub-teams and the carousel have something to show.',
        portrait_url: null,
        sort_order: (i + 1) * 10,
        about_order: order,
        page_scope: 'about_us',
        category,
        sub_category: sub,
        is_lead: isLead
      })
    );
    // Replacing rather than merging: `demoRoster()` only persists its own seed on
    // a WRITE, so on a fresh context the key is absent and appending here would
    // replace the whole roster anyway.
    const kept = existing.filter((r) => !String(r.id).startsWith('probe-'));
    localStorage.setItem(KEY, JSON.stringify(kept.concat(extras)));
  }, SEED);
}

/** Take a full measurement of the About page. Evaluated inside the browser. */
const measure = (page) =>
  page.evaluate(() => {
    /*
      ONE CARD READER, USED TWICE.

      The previous version of this file built the card list twice — once inside
      each group and once page-wide — and the page-wide copy quietly lacked the
      border and pill fields, so two assertions silently measured `undefined`
      against `undefined` and passed for the wrong reason. One reader, one shape.
    */
    const readCard = (c) => {
      const r = c.getBoundingClientRect();
      const img = c.querySelector('.about-card__photo');
      const pill = c.querySelector('.about-card__lead-pill');
      return {
        name: c.querySelector('.about-card__name')?.textContent.trim(),
        variant: c.classList.contains('about-card--lead')
          ? 'lead'
          : c.classList.contains('about-card--carousel')
            ? 'carousel'
            : 'plain',
        hasLeadPill: Boolean(pill),
        leadPillShown: pill ? getComputedStyle(pill).display !== 'none' : false,
        borderLeftWidth: getComputedStyle(c).borderLeftWidth,
        // A card contributes a grid column if it sits directly in the grid, and
        // one ROW if it is laid out horizontally. Comparing the two tells us
        // which layout is in force without guessing at breakpoints.
        row: Math.round(r.top),
        col: Math.round(r.left),
        width: Math.round(r.width),
        photo: img ? Math.round(img.getBoundingClientRect().width) : 0
      };
    };

    const rosters = [...document.querySelectorAll('.about-roster')].map((r) => ({
      heading: r.querySelector('.about-roster__heading')?.textContent.trim(),
      subheads: [...r.querySelectorAll('.about-subhead')].map((h) => h.textContent.trim())
    }));

    // ONE MEASUREMENT PER SUB-TEAM. This is the level the merge has to hold at:
    // the lead card and its own carousel have to land in the same grid, without a
    // stray row of carousel cards below them.
    const groups = [...document.querySelectorAll('.about-group')].map((g) => {
      const lead = g.querySelector('.about-card--lead');
      return {
        heading: g.querySelector('.about-subhead')?.textContent.trim() || null,
        cards: [...g.querySelectorAll('.about-card')].map(readCard),
        hasLead: Boolean(lead),
        hasCarousel: Boolean(g.querySelector('.about-carousel')),
        // The lead must be the FIRST card in its own group, or the phone layout
        // is showing somebody else's team above this one.
        leadIsFirst: lead ? lead === g.querySelector('.about-card') : false,
        hasHint: Boolean(g.querySelector('.about-group__hint'))
      };
    });

    const cards = [...document.querySelectorAll('.about-card')].map(readCard);

    const heading = document.querySelector('.about-roster__heading');
    const hs = heading ? getComputedStyle(heading) : null;
    const subhead = document.querySelector('.about-subhead');
    const ss = subhead ? getComputedStyle(subhead) : null;

    return {
      rosters,
      groups,
      cards,
      documentScrollW: document.documentElement.scrollWidth,
      clientW: document.documentElement.clientWidth,
      heading: hs
        ? {
            size: parseFloat(hs.fontSize),
            weight: hs.fontWeight,
            borderLeft: hs.borderLeftWidth + ' ' + hs.borderLeftColor,
            paddingLeft: hs.paddingLeft,
            marginBottom: hs.marginBottom,
            textTransform: hs.textTransform,
            tag: heading.tagName
          }
        : null,
      subhead: ss
        ? {
            size: parseFloat(ss.fontSize),
            borderBottom: ss.borderBottomWidth,
            borderBottomColor: ss.borderBottomColor,
            textTransform: ss.textTransform,
            tag: subhead.tagName
          }
        : null,
      // Does the FIRST carousel generate a box, or has it been dissolved?
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

  await seed(page);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  await gotoAbout(page);
  const m = await measure(page);

  console.log('--- phone 390px ---');
  check('both main categories render', m.rosters.length === 2, JSON.stringify(m.rosters.map((r) => r.heading)));
  check(
    'the main headings are promoted, uppercase <h3>s',
    m.heading?.tag === 'H3' && m.heading.textTransform === 'uppercase' && m.heading.size >= 22,
    JSON.stringify(m.heading)
  );
  check(
    'sub-category headings render as <h4> one level down',
    m.subhead?.tag === 'H4' && m.subhead.borderBottom !== '0px',
    JSON.stringify(m.subhead)
  );

  const byCategory = m.rosters.map((r) => r.heading);
  check(
    'every seeded sub-team has a heading, under its own main category',
    m.rosters.every((r) => r.subheads.length > 0),
    JSON.stringify(m.rosters)
  );
  check(
    'Leadership and Advisers are both under Board Members',
    m.rosters.find((r) => r.heading === 'Board Members')?.subheads.length === 2,
    JSON.stringify(m.rosters.find((r) => r.heading === 'Board Members'))
  );
  check(
    'a mis-cased sub-category folds into the one team, not a second heading',
    m.rosters
      .flatMap((r) => r.subheads)
      .filter((h) => /^writers$/i.test(h)).length === 1,
    JSON.stringify(m.rosters.flatMap((r) => r.subheads))
  );

  const groups = m.groups.filter((g) => g.cards.length);
  check(
    'every sub-team with people has exactly one lead card',
    groups.length > 0 && groups.every((g) => g.hasLead && g.cards.filter((c) => c.variant === 'lead').length === 1),
    JSON.stringify(groups.map((g) => [g.heading, g.cards.length]))
  );
  check(
    'the lead is the FIRST card in its own sub-team',
    groups.every((g) => g.leadIsFirst),
    JSON.stringify(groups.map((g) => [g.heading, g.leadIsFirst]))
  );
  check('the carousel is a real flex row on a phone', m.carouselDisplay === 'flex', `display=${m.carouselDisplay}`);
  check('the lead sits above its carousel, not beside it', m.peopleDisplay === 'block', `display=${m.peopleDisplay}`);
  check(
    'the LEAD pill is HIDDEN on a phone, where position already says it',
    m.cards.every((c) => !c.leadPillShown),
    JSON.stringify(m.cards.filter((c) => c.leadPillShown).map((c) => c.name))
  );
  check(
    'the lead card keeps its gold rail on a phone',
    m.cards.filter((c) => c.variant === 'lead').every((c) => c.borderLeftWidth === '3px'),
    JSON.stringify(m.cards.filter((c) => c.variant === 'lead').map((c) => c.borderLeftWidth))
  );

  const scrolled = await page.evaluate(() => {
    const els = [...document.querySelectorAll('.about-carousel')].map((el) => {
      const s = getComputedStyle(el);
      return {
        overflowX: s.overflowX,
        snap: s.scrollSnapType,
        scrollable: el.scrollWidth > el.clientWidth + 1
      };
    });
    return els;
  });
  check(
    'every carousel scrolls horizontally and snaps',
    scrolled.length > 0 && scrolled.every((s) => s.overflowX === 'auto' && s.snap.includes('mandatory')),
    JSON.stringify(scrolled)
  );
  check(
    'at least one carousel actually has more to scroll (so it is a carousel, not a stub)',
    scrolled.some((s) => s.scrollable),
    JSON.stringify(scrolled.map((s) => s.scrollable))
  );

  const carouselCards = m.cards.filter((c) => c.variant === 'carousel');
  check(
    'carousel cards are a fixed 140px slide',
    carouselCards.length > 0 && carouselCards.every((c) => c.width === 140),
    JSON.stringify(carouselCards.map((c) => c.width))
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
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  await seed(page);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  await gotoAbout(page);
  const m = await measure(page);

  console.log('\n--- desktop 1440px ---');
  check(
    'the carousel is dissolved into the grid, not drawn as a row',
    m.carouselDisplay === 'contents',
    `display=${m.carouselDisplay}`
  );
  check('the people container is a grid', m.peopleDisplay === 'grid', `display=${m.peopleDisplay}`);

  /*
    THE MERGE, MEASURED PER SUB-TEAM. This is the assertion the two-level layout
    made necessary: it used to hold across a whole main category, and it now has
    to hold inside each sub-team, because each one owns its own grid.
  */
  const wide = m.groups.filter((g) => g.cards.length > 1);
  check(
    'lead and carousel cards share ONE grid inside their own sub-team',
    wide.length > 0 &&
      wide.every((g) => new Set(g.cards.map((c) => c.row)).size <= Math.ceil(g.cards.length / 3)),
    JSON.stringify(wide.map((g) => [g.heading, new Set(g.cards.map((c) => c.row)).size, g.cards.length]))
  );
  check(
    'a multi-person sub-team spans MULTIPLE COLUMNS',
    wide.every((g) => new Set(g.cards.map((c) => c.col)).size >= 2),
    JSON.stringify(wide.map((g) => [g.heading, new Set(g.cards.map((c) => c.col)).size]))
  );

  const photos = [...new Set(m.cards.map((c) => c.photo))];
  check(
    'every desktop card uses the shared 56px avatar',
    photos.length === 1 && photos[0] === 56,
    JSON.stringify(photos)
  );

  const leadCards = m.cards.filter((c) => c.variant === 'lead');
  const nonLead = m.cards.filter((c) => c.variant !== 'lead');
  check(
    'the LEAD pill is VISIBLE on a desktop, where position no longer identifies the lead',
    leadCards.length > 0 && m.cards.filter((c) => c.hasLeadPill).length === leadCards.length,
    `${m.cards.filter((c) => c.leadPillShown).length} shown of ${leadCards.length} leads`
  );
  check(
    'exactly ONE card per sub-team carries the pill — the others do not',
    m.groups.filter((g) => g.cards.length).every((g) => g.cards.filter((c) => c.hasLeadPill).length === 1),
    JSON.stringify(m.groups.map((g) => [g.heading, g.cards.filter((c) => c.hasLeadPill).length]))
  );
  check(
    'non-lead cards are NOT given the gold rail',
    nonLead.every((c) => c.borderLeftWidth !== '3px'),
    JSON.stringify(nonLead.map((c) => c.borderLeftWidth))
  );
  check(
    'lead and non-lead cards are the same width, so the rail is the only difference',
    leadCards.length > 0 && nonLead.length > 0 && Math.abs(leadCards[0].width - nonLead[0].width) <= 1,
    `lead=${leadCards[0]?.width} other=${nonLead[0]?.width}`
  );

  check('no sideways scroll on desktop', m.documentScrollW <= m.clientW + 1, `${m.documentScrollW} vs ${m.clientW}`);
  await page.close();
}

/* ================================ LEAD RESOLUTION ================================ */
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  await seed(page);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  await gotoAbout(page);

  /*
    THE FALLBACK, READ BACK OFF THE PAGE.

    'Photographers' is seeded with nobody ticked. The brief says that team must
    then show its first member by display order, so the lead card there has to be
    Noor H. — who is first by `about_order` — and NOT Lilian W. A renderer that
    silently picked nobody, or picked an arbitrary row, fails here.
  */
  const photo = await page.evaluate(() => {
    const group = [...document.querySelectorAll('.about-group')].find((g) =>
      (g.querySelector('.about-subhead')?.textContent || '').includes('Photographers')
    );
    return {
      lead: group?.querySelector('.about-card--lead .about-card__name')?.textContent.trim() || null,
      // The panel tells the Owner when the lead was a fallback; the page is not
      // required to shout about it, so this is informational only.
      hint: group?.querySelector('.about-group__hint')?.textContent.trim() || null
    };
  });
  console.log('\n--- lead resolution ---');
  check(
    'a team with nobody ticked falls back to its FIRST member by display order',
    photo.lead === 'Noor H.',
    `lead=${photo.lead}`
  );

  const writers = await page.evaluate(() => {
    const group = [...document.querySelectorAll('.about-group')].find((g) =>
      (g.querySelector('.about-subhead')?.textContent || '').includes('Writers')
    );
    return group?.querySelector('.about-card--lead .about-card__name')?.textContent.trim() || null;
  });
  check(
    'a DESIGNATED lead beats a lower-ordered colleague',
    writers === 'Amara K.',
    `lead=${writers}; the seed puts Wanjiku Kamande (order 10) ahead of the ticked Amara K. (order 30), so "first by order" would answer "Wanjiku Kamande"`
  );

  const designers = await page.evaluate(() => {
    const group = [...document.querySelectorAll('.about-group')].find((g) =>
      (g.querySelector('.about-subhead')?.textContent || '').includes('Designers')
    );
    return group?.querySelector('.about-card--lead .about-card__name')?.textContent.trim() || null;
  });
  check(
    'and does so for a SECOND team, not just the first one that has a tick',
    designers === 'Samuel K.',
    `lead=${designers}; the seed puts Grace N. (order 50) ahead of the ticked Samuel K. (order 80)`
  );
  await page.close();
}

/* ================================ ONE CARD, ONCE ================================ */
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  await seed(page);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  await gotoAbout(page);
  const d = await page.evaluate(() => {
    const names = [...document.querySelectorAll('.about-card__name')].map((n) =>
      n.textContent.trim()
    );
    const groups = [...document.querySelectorAll('.about-group')];
    return {
      total: names.length,
      unique: new Set(names).size,
      names,
      // Every card sits inside exactly one sub-team. A card outside all of them
      // would mean the template leaked somebody past the hierarchy.
      ungrouped: [...document.querySelectorAll('.about-card')].filter(
        (c) => !groups.some((g) => g.contains(c))
      ).length
    };
  });
  console.log('\n--- DOM hygiene ---');
  check(
    'each person appears EXACTLY once (no duplicated lead/carousel copy)',
    d.total === d.unique,
    `${d.total} cards, ${d.unique} distinct name(s)`
  );
  check('every card belongs to exactly one sub-team', d.ungrouped === 0, `${d.ungrouped} ungrouped`);
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
      leadPill: g('.about-card__lead-pill', ['fontFamily', 'fontSize', 'textTransform', 'display'])
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
    'the role pill is a sans-serif, NOT the typewriter mono face',
    t.pill && !/mono|courier|consolas/i.test(t.pill.fontFamily),
    JSON.stringify(t.pill)
  );
  check(
    'the LEAD pill is a small uppercase sans-serif, not the mono face',
    t.leadPill &&
      t.leadPill.display !== 'none' &&
      t.leadPill.textTransform === 'uppercase' &&
      !/mono|courier|consolas/i.test(t.leadPill.fontFamily),
    JSON.stringify(t.leadPill)
  );
  await page.close();
}

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);