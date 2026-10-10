/* =============================================================================
   src/views/public.js — THE PUBLIC PUBLICATION
   -----------------------------------------------------------------------------
   Renders the reader-facing newspaper: the breaking-news ticker, Today's Pick,
   the latest front-page grid, the three weekly feature slots, the public
   assignment board and the archive search. All content comes from the store,
   so anything the owner publishes in the Newsroom Panel appears here on the
   next state change without a page reload.
   ========================================================================== */

import * as store from '../lib/store.js';
import {
  escapeHtml,
  safeUrl,
  byId,
  openDialog,
  closeDialog,
  showToast,
formatEditionDate,
    imageFallbackAttr,
    captionText
} from '../lib/dom.js';
import { bylineSticker, renderAbout } from '../lib/credits.js';
import { listPodcasts } from '../lib/podcasts.js';

/**
 * A story byline, credited by the NAME printed on the story.
 *
 * Deliberately NOT resolved through `articles.author_account_id`. That column
 * records which account may edit and delete the row -- migration 007 calls it
 * "the account the author signs in with" -- and the Owner publishing a piece
 * bylined to a reporter is ordinary practice. Resolving a face from it printed
 * the Owner's portrait beside somebody else's byline, which is the inconsistency
 * this function exists to prevent: one byline, two avatars, depending on which
 * account happened to post it.
 *
 * Every byline on the site goes through here -- the cards, the Weekly slots,
 * Today's Pick, the article modal and both search strips -- so a byline is
 * rendered one way or not at all.
 *
 * @param {{author?: string}} article
 * @param {{tag?: string, cls?: string, suffix?: string}} [opts]
 */
function renderByline(article, opts = {}) {
  return bylineSticker(article?.author || 'The Pulse staff', opts);
}

/** A neutral placeholder for stories with no lead image. */
const BLANK_IMAGE =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 450">' +
      '<rect width="800" height="450" fill="#e7e1d3"/>' +
      '<text x="50%" y="50%" font-family="Georgia,serif" font-size="42" ' +
      'fill="#8c1d11" text-anchor="middle">The Pulse</text></svg>'
  );

/* -------------------------------------------------------------------------- */
/* Header + ticker                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The organisation line shown under "The Pulse" in the masthead heading.
 *
 * This has to exist in two places -- here and in index.html -- because the
 * static markup is what a crawler reads and this function is what a reader
 * sees. `scripts/seo-check.mjs` asserts the two strings are identical so they
 * cannot drift apart.
 */
const ORG_LINE = 'Melvin Jones Press Club';

/** Paint the masthead from the stored branding + today's real date. */
export function renderMasthead() {
  const { branding } = store.getState();

  const title = byId('masthead-title');
  if (title) {
    // textContent replaces every child, so the organisation line is rebuilt
    // rather than left to the static markup. Setting the text alone would leave
    // a reader staring at "THE PULSE" while a crawler saw the full name -- the
    // heading and the masthead would disagree depending on who was looking.
    title.replaceChildren(
      document.createTextNode(branding.title),
      Object.assign(document.createElement('span'), {
        className:
          'mt-2 block text-[0.6rem] leading-tight font-bold tracking-[0.24em] md:text-[0.7rem]',
        textContent: ORG_LINE
      })
    );
  }

  const subtitle = byId('masthead-subtitle');
  if (subtitle) subtitle.textContent = branding.subtitle;

  const foot = byId('masthead-foot');
  if (foot) foot.textContent = branding.title;

  const date = byId('masthead-date');
  if (date) date.textContent = formatEditionDate();

  const edition = byId('edition-line');
  if (edition) edition.textContent = branding.edition;

  const year = byId('footer-year');
  if (year) year.textContent = String(new Date().getFullYear());
}

/** The live breaking-news bar, or nothing at all when it is switched off. */
export function renderBreakingBanner() {
  const slot = byId('breaking-banner-slot');
  if (!slot) return;

  const banner = store.getState().breakingNews;
  if (!banner?.enabled) {
    slot.replaceChildren();
    return;
  }

  // `color` used to be one of three fixed names. It is now whatever the Owner
  // typed or picked, so a real hex value wins and the named palette is kept
  // only as a fallback for banners saved before the colour picker existed.
  const accent = bannerAccent(banner.color);

  const severity = escapeHtml(banner.severity || 'Breaking');

  // Deliberately three elements and nothing else: severity, headline,
  // supporting line. The former Label / link-text / link-URL / dismiss
  // controls were settings with nothing on screen to hang them on, so the
  // Owner could fill them in and see no change. See renderBreakingTab().
  slot.innerHTML = `
    <div
      class="emergency-pulse text-white no-print"
      style="background: ${accent}"
      role="region"
      aria-label="Breaking news"
    >
      <div
        class="mx-auto flex max-w-7xl flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 text-[0.6875rem] font-bold tracking-[0.12em] uppercase"
      >
        <span class="badge badge-live shrink-0"
          style="background: #fff; color: ${accent}">${severity}</span>
        <strong class="min-w-0 flex-1 truncate">${escapeHtml(banner.headline)}</strong>
        ${
          escapeHtml(banner.subtext)
            ? `<span class="hidden truncate opacity-90 md:inline">${escapeHtml(banner.subtext)}</span>`
            : ''
        }
      </div>
    </div>
  `;
}

/**
 * Resolve the stored banner colour to something safe to put in a `style`
 * attribute.
 *
 * This value is interpolated straight into `style="background: ..."`, so it is
 * an injection point: an Owner (or anyone who reaches the settings row) could
 * otherwise write `red; background-image: url(...)` and pull a remote request
 * out of every reader's page. Only a real hex triplet is accepted; everything
 * else falls back to the named palette and then to the house red.
 */
function bannerAccent(color) {
  const raw = String(color || '').trim();

  if (/^#[0-9a-f]{6}$/i.test(raw)) return raw;
  if (/^#[0-9a-f]{3}$/i.test(raw)) {
    // Expand #abc -> #aabbcc so the CSS that assumes six digits stays simple.
    return `#${raw[1]}${raw[1]}${raw[2]}${raw[2]}${raw[3]}${raw[3]}`;
  }

  if (raw.toLowerCase() === 'gold') return 'var(--color-newsgold)';
  if (raw.toLowerCase() === 'blue') return 'var(--color-newsblue)';
  return 'var(--color-newsred)';
}

/* -------------------------------------------------------------------------- */
/* Small building blocks                                                     */
/* -------------------------------------------------------------------------- */

/** A story card used in the latest grid and the weekly slots. */
function articleCard(article, { showBody = false, size = 'md' } = {}) {
  if (!article) return '';
  const href = `#article-${escapeHtml(article.id)}`;
  const image = safeUrl(article.image) || BLANK_IMAGE;

  return `
    <article
      id="article-${escapeHtml(article.id)}"
      class="panel-raised group flex h-full flex-col overflow-hidden"
    >
      <a href="${href}" class="block overflow-hidden" tabindex="-1" aria-hidden="true">
        <img
          src="${escapeHtml(image)}"
          ${imageFallbackAttr(BLANK_IMAGE)}
          alt=""
          loading="lazy"
          decoding="async"
          class="${
            size === 'lg' ? 'h-64 md:h-80' : 'h-44'
          } w-full object-cover transition-transform duration-500 group-hover:scale-105"
        />
      </a>
      <div class="flex flex-1 flex-col p-4">
        <div class="flex flex-wrap items-center gap-2 text-[0.625rem] font-semibold tracking-[0.12em] uppercase">
          <span class="badge badge-gold">${escapeHtml(article.category)}</span>
          <span class="ink-muted font-mono">${escapeHtml(article.date)}</span>
        </div>
        <h3 class="mt-2 font-headline text-lg leading-tight font-black">
          <a href="${href}" class="text-link">${escapeHtml(article.title)}</a>
        </h3>
        ${renderByline(article, { cls: 'mt-1 text-[0.6875rem] ink-muted' })}
        ${
          showBody
            ? `<p class="mt-2 text-sm leading-relaxed ink-muted">${escapeHtml(
                (article.body || '').slice(0, 220)
              )}${(article.body || '').length > 220 ? '…' : ''}</p>`
            : ''
        }
        ${
captionText(article.caption)
              ? `<p class="mt-2 text-[0.6875rem] italic ink-muted">${escapeHtml(
                  captionText(article.caption)
                )}</p>`
              : ''
        }
        <button type="button" class="btn btn-quiet mt-3 self-start px-0" data-read="${escapeHtml(article.id)}">
          Read the full dispatch <i class="fa-solid fa-arrow-right text-[0.5rem]" aria-hidden="true"></i>
        </button>
      </div>
    </article>
  `;
}

/** A section heading with the newspaper double rule beneath it. */
function sectionHeading(id, kicker, title) {
    return `
      <div class="mb-5 rule border-b-2 border-double pb-3">
        ${kicker ? `<p class="accent-text text-[0.625rem] font-bold tracking-[0.24em] uppercase">${escapeHtml(kicker)}</p>` : ''}
        <h2 id="${escapeHtml(id)}" class="font-headline text-2xl font-black tracking-wide uppercase md:text-3xl">
          ${escapeHtml(title)}
        </h2>
      </div>
    `;
  }

/**
 * APPROVED PODCASTS, ABOVE THE ARTICLES.
 *
 * The brief asks for approved podcasts to lead the main content feed. They go on
 * the FRONT PAGE rather than on /podcasts, because /podcasts is its own reader
 * view with no articles on it — so "above articles" can only mean here.
 *
 * WHY THIS RENDERS A PLACEHOLDER AND FILLS ITSELF IN
 * ----------------------------------------------------
 * `listPodcasts()` is ASYNC. `renderPublication()` is synchronous and sits on the
 * first-paint path, so awaiting the episode list there would make the whole front
 * page wait on a network round trip for a section that is optional.
 *
 * The first version of this called `listPodcasts().filter(...)` synchronously,
 * which throws `TypeError: .filter is not a function` on a Promise — and because
 * it was inside a template literal, that error took the ENTIRE front page with it,
 * masthead and all. So: the container is painted empty, and the real markup is
 * inserted when the read resolves.
 *
 * An empty strip renders NOTHING, not an empty section. A heading over nothing
 * reads as a broken page rather than as "there are no episodes yet".
 *
 * APPROVED ONLY. The RLS policy already refuses non-approved rows to an anon
 * reader, so this is belt and braces rather than the gate — but the filter is
 * still here because the DEMO store has no RLS behind it at all and would
 * otherwise put a pending episode on the front page.
 *
 * @returns {string} an empty mount, filled asynchronously
 */
function renderPodcastStrip() {
  return '<div id="latest-podcasts-mount" data-podcast-strip></div>';
}

/** Replace the strip mount with the real section, or remove it if there is none. */
async function fillPodcastStrip() {
  const mount = byId('latest-podcasts-mount');
  if (!mount) return;

  let episodes = [];
  try {
    episodes = (await listPodcasts()).filter(
      (p) => String(p?.status || '').toLowerCase() === 'approved'
    );
  } catch (error) {
    // A podcast feed that cannot be read must not take the front page with it.
    console.warn('[public] podcast strip unavailable', error);
    mount.remove();
    return;
  }

  // The reader may have navigated away, or the store may have been re-rendered
  // underneath us while the read was in flight. Either way this mount is stale.
  if (!mount.isConnected) return;

  if (!episodes.length) {
    mount.remove();
    return;
  }

  const shown = episodes.slice(0, 3);

  mount.outerHTML = `
    <section id="latest-podcasts" aria-labelledby="latest-podcasts-heading" class="mb-12">
      ${sectionHeading('latest-podcasts-heading', 'Listen', 'Latest podcasts')}
      <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        ${shown.map(podcastCard).join('')}
      </div>
      ${
        episodes.length > shown.length
          ? `<p class="mt-3">
               <a class="btn btn-ghost" href="#podcasts" data-nav="podcasts">
                 <i class="fa-solid fa-headphones" aria-hidden="true"></i>
                 All ${episodes.length} episodes
               </a>
             </p>`
          : ''
      }
    </section>
  `;

  /*
   * WIRE THE PLAYERS. Without this the strip rendered a dead play button.
   *
   * `podcastCard` emits the full custom transport -- the <audio> element, the
   * toggle, the scrubber, the speed control -- but none of that is interactive
   * until `wirePodcastPlayer` attaches the listeners. The homepage was the only
   * place that emitted those cards and skipped the wiring, so the button was
   * there, the audio source was correct, and clicking did nothing at all. The
   * same cards on /podcasts worked because `renderPodcastsPage` has always called
   * it.
   *
   * Reached through the NEW section, not `mount`: `outerHTML` has already
   * replaced the mount node, so `mount` is detached and querying it would find
   * nothing. `document.getElementById` finds the replacement that took its place.
   */
  byId('latest-podcasts')
    ?.querySelectorAll('[data-podcast-player]')
    .forEach(wirePodcastPlayer);
}

/** Map a workflow status onto one of the badge variants. */
function statusBadge(status) {
  switch (status) {
    case 'Published':
      return 'badge badge-emerald';
    case 'Pending Review':
      return 'badge badge-amber';
    case 'Rejected':
      return 'badge badge-live';
    case 'Archived':
      return 'badge badge-neutral';
    default:
      return 'badge badge-sky';
  }
}

/* -------------------------------------------------------------------------- */
/* Full publication render                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Paint the whole reader-facing page into #publication-view.
 * Called on boot and again after every store mutation.
 */
export function renderPublication() {
  const view = byId('publication-view');
  if (!view) return;

  const published = store.listPublishedArticles();

  /*
   * Curation pointers are ids into `articles`, but a pointer can outlive its
   * story's Published status (unpublish keeps the row), and reconcileCuration()
   * can clear a pointer altogether. The store's read helpers resolve against
   * EVERY article and fall back to `articles[0]` of any status — which is how a
   * draft or a pulled story kept leading this page after the newsroom took it
   * down. Resolve against `published` instead: this is the only set of stories
   * a reader may open, and re-running it on every render is what makes a Save
   * on the Curation tab visibly re-sort the front page.
   */
  const { todaysPickId, weeklySlots, showThisWeek } = store.getState();
  const curated = (id) => published.find((article) => article.id === id) || null;
  const todaysPick = curated(todaysPickId) || published[0] || null;
  const week = {
    // A weekly slot with no published story behind it stays empty and shows
    // its own "No story curated" line rather than borrowing `articles[0]`.
    article: curated(weeklySlots.article),
    event: curated(weeklySlots.event),
    picture: curated(weeklySlots.picture)
  };
  const assignments = store.listAssignments();

  // Today's Pick is also shown as the lead story, so filter it out of the grid.
  const grid = published.filter((article) => article.id !== todaysPick?.id);
  const [lead, ...rest] = grid;

view.innerHTML = `
      ${renderPodcastStrip()}

      <!-- ================= TODAY'S PICK ================= -->
      <section id="today" aria-labelledby="today-heading" class="mb-12">
        ${sectionHeading('today-heading', 'The lead', "Today's Pick")}
        ${renderTodaysPick(todaysPick)}
      </section>

    <!-- ================= LATEST COVERAGE ================= -->
    <section id="latest" aria-labelledby="latest-heading" class="mb-12">
      ${sectionHeading('latest-heading', 'Front page', 'Latest Coverage')}
      ${
        published.length
          ? `<div class="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
              ${lead ? articleCard(lead, { showBody: true, size: 'lg' }) : ''}
              ${rest.map((article) => articleCard(article)).join('')}
            </div>`
          : `<p class="panel p-6 text-sm ink-muted">The archive is empty. Publish a story from the Newsroom Panel to see it here.</p>`
      }
    </section>

    <!-- ================= WEEKLY FEATURES ================= -->
    ${
      showThisWeek !== false
        ? `<section id="weekly" aria-labelledby="weekly-heading" class="mb-12">
      ${sectionHeading('weekly-heading', 'Curated by the owner', 'This Week In The Pulse')}
      <div class="grid gap-6 md:grid-cols-3">
        ${[
          { label: 'Feature of the week', item: week.article },
          { label: 'On the record', item: week.event },
          { label: 'In pictures', item: week.picture }
        ]
          .map((entry) => renderWeeklySlot(entry))
          .join('')}
      </div>
    </section>`
        : ''
    }

    <!-- ================= ASSIGNMENT BOARD ================= -->
    <section id="assignments" aria-labelledby="assignments-heading" class="mb-12">
      ${sectionHeading('assignments-heading', 'Open calls', 'Assignment Board')}
      ${renderAssignmentBoard(assignments)}
    </section>
  `;

  // The two "Weekly" nav links are static markup in index.html and do NOT come
  // back with the innerHTML above. Hide them when the band is off, or the nav
  // would offer readers an anchor to a section that is not on the page.
  document.querySelectorAll('a.nav-link[href="#weekly"]').forEach((link) => {
    link.hidden = showThisWeek === false;
  });

  /*
    Kick off the podcast strip AFTER the markup is in place, and do not await it.

    The mount only exists once the innerHTML above has been assigned, so this has
    to come after that line -- and it must not be awaited, because
    `renderPublication()` is synchronous and on the first-paint path. Fire and
    forget: the strip fills itself in when the read resolves, and a failure there
    removes the mount rather than touching the page.
  */
  fillPodcastStrip();

  // The markup was just replaced wholesale, so the "read the full dispatch"
  // buttons are new nodes - bind them with a single delegated listener on the
  // container instead of re-attaching on every render.
  view.onclick = (event) => {
    const trigger = event.target.closest('[data-read]');
    if (trigger) openArticle(trigger.dataset.read);

    const shot = event.target.closest('[data-lightbox]');
    if (shot) openLightbox(shot.dataset.lightbox);

    // The gallery door. Dispatched on the document because app.js owns the
    // reader-view router: this view does not know how to switch pages.
    if (event.target.closest('[data-gallery-open]')) {
      document.dispatchEvent(new CustomEvent('wire:navigate', { detail: 'gallery' }));
    }
  };
}

/**
 * Which gallery category page is open, or null for the category list.
 *
 * Two levels of the same view, held in one place so the Back button and the
 * store's repaint both agree on what is being shown.
 */
let openGalleryCategory = null;

/**
 * Does this reader have asked for less motion?
 *
 * The category transition is decorative, so `prefers-reduced-motion` turns it
 * off. Read live rather than cached at module load, because the setting can be
 * changed while the page is open.
 */
function reducedMotion() {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * One category card on the gallery index.
 *
 * A button rather than a link, but it navigates: it opens a whole PAGE for the
 * category rather than revealing one underneath itself. The newsroom asked for
 * that, because on a phone a nested grid pushes every other category off the
 * screen. The chevron points forward, matching the direction it goes.
 *
 * @param {{category: object, shots: Array<object>}} group
 */
function renderGalleryCard(group) {
  const category = group.category;
  const name = category?.name || 'Uncategorised';
  const id = category?.id || '';

  // The cover is the Owner's chosen image, else a photo filed under the card.
  const cover =
    safeUrl(category?.coverUrl) || safeUrl(group.shots[0]?.url) || BLANK_IMAGE;
  const count = group.shots.length;

  return `
    <article class="gallery-card">
      <button
        type="button"
        class="gallery-card__head"
        data-gallery-category="${escapeHtml(id)}"
        aria-label="Open the ${escapeHtml(name)} category, ${count} photograph${
          count === 1 ? '' : 's'
        }"
      >
        <img
          src="${escapeHtml(cover)}"
          ${imageFallbackAttr(BLANK_IMAGE)}
          alt=""
          aria-hidden="true"
          loading="lazy"
          decoding="async"
          class="gallery-card__cover"
        />
        <span class="gallery-card__body">
          <span class="font-headline text-lg font-black tracking-[0.06em] uppercase">
            ${escapeHtml(name)}
          </span>
          <span class="ink-muted mt-0.5 block text-sm">
            ${count} photograph${count === 1 ? '' : 's'}
          </span>
        </span>
        <i class="gallery-card__chevron fa-solid fa-arrow-right" aria-hidden="true"></i>
      </button>
    </article>
  `;
}

      /**
 * Level 2: one category, as a page of its own.
 *
 * @param {{category: object, shots: Array<object>}|undefined} group
 */
function renderGalleryCategoryPage(group) {
  // The category was deleted while its page was open (the Owner works in the
  // same tab). Fall back to the index rather than rendering an empty page.
  if (!group) {
    openGalleryCategory = null;
    return renderGalleryIndex();
  }

  const name = group.category?.name || 'Uncategorised';
  const count = group.shots.length;

  return `
    <div class="gallery-category-page">
      <button type="button" class="btn btn-ghost gallery-category-page__back"
        data-gallery-back>
        <i class="fa-solid fa-arrow-left" aria-hidden="true"></i> All categories
      </button>

      ${sectionHeading('gallery-category-heading', `${count} photograph${count === 1 ? '' : 's'}`, name)}

      ${
        count
          ? `<div class="gallery-card__grid">
              ${group.shots
                .map(
                  (shot) => `
                  <button
                    type="button"
                    class="gallery-card__shot"
                    data-lightbox="${escapeHtml(shot.id)}"
                    aria-label="Open ${escapeHtml(shot.caption || name)} full size"
                  >
                    <img
                      src="${escapeHtml(safeUrl(shot.url) || BLANK_IMAGE)}"
                      ${imageFallbackAttr(BLANK_IMAGE)}
                      alt="${escapeHtml(shot.caption || '')}"
                      loading="lazy"
                      decoding="async"
                    />
                    ${
captionText(shot.caption)
                          ? `<span class="gallery-card__caption">${escapeHtml(
                              captionText(shot.caption)
                            )}</span>`
                          : ''
                    }
                  </button>`
                )
                .join('')}
            </div>`
          : `<p class="panel p-6 text-sm ink-muted">
               No photographs filed under this category yet.
             </p>`
      }
    </div>
  `;
}

/**
 * Level 1: the list of categories.
 */
function renderGalleryIndex() {
  const groups = store.listGalleryByCategory();
  const total = groups.reduce((sum, group) => sum + group.shots.length, 0);

  return `
    ${sectionHeading('gallery-page-heading', 'Selected by the owner', 'Gallery')}
    ${
      total
        ? `<p class="ink-muted mb-6 text-sm">
            ${total} photograph${total === 1 ? '' : 's'},
            ${groups.length} categor${groups.length === 1 ? 'y' : 'ies'}.
            Tap a category to open it.
          </p>`
        : ''
    }
    ${
      groups.length
        ? `<div class="gallery-cards">${groups.map(renderGalleryCard).join('')}</div>`
        : `<p class="panel p-6 text-sm ink-muted">
             The gallery is empty. The Owner can add categories and publish
             photographs from the Media shelf in the Newsroom Panel.
           </p>`
    }
  `;
}

/**
 * The gallery page: the category list, or the open category's photographs.
 *
 * Rendered into #gallery-view by src/app.js. Clicking a category card does NOT
 * expand a dropdown -- it transitions into a full page for that category, with
 * a Back button returning to the list, because a nested grid on a phone pushes
 * every other category off the screen.
 *
 * The open level is deliberately NOT synced to the URL hash. The gallery is
 * already hash-routed (`#gallery`); a second path-like segment would mean
 * routing changes in src/app.js for no reader-visible gain, and Back is a
 * visible button here.
 */
export function renderGalleryPage() {
  const view = byId('gallery-view');
  if (!view) return;

  const group = openGalleryCategory
    ? store
        .listGalleryByCategory()
        .find((entry) => entry.category?.id === openGalleryCategory)
    : null;

  view.innerHTML = openGalleryCategory
    ? renderGalleryCategoryPage(group)
    : renderGalleryIndex();

  // One delegated listener for the whole page: the markup is destroyed on every
  // repaint, so per-card binding would be lost the moment the store changed.
  view.onclick = (event) => {
    // The Back button is destroyed along with the category page, so focus has to
    // be moved deliberately -- otherwise it falls to <body> and the next Tab
    // restarts from the nav on every return.
    if (event.target.closest('[data-gallery-back]')) {
      openGalleryCategory = null;
      renderGalleryPage();
      view.focus?.();
      return;
    }

    const card = event.target.closest('[data-gallery-category]');
    if (card) {
      openGalleryCategory = card.dataset.galleryCategory;
      renderGalleryPage();
      view.focus?.();
      window.scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' });
      return;
    }

    const shot = event.target.closest('[data-lightbox]');
    if (shot) openLightbox(shot.dataset.lightbox);
  };
}



/* -------------------------------------------------------------------------- */
/* Video interviews                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Which page of the interviews feed the reader is on.
 *
 * Module state, deliberately NOT in the URL. A paginated reader page whose page
 * number lives in a query string means the back button walks the reader back
 * through their own page changes, and a refresh on page 3 of a two-page feed
 * needs a second fetch to resolve. The gallery made the same call for the same
 * reason (see renderGalleryPage); the feed is short enough that a bookmark to
 * page 3 is not something anybody wants.
 */
let interviewPage = 1;

/**
 * Render one responsive YouTube embed.
 *
 * The 16/9 box is the whole trick. YouTube's player has no intrinsic size, so a
 * bare <iframe> defaults to 300x150 and cannot be made responsive with width
 * alone -- the classic result is a video letterboxed into a fixed box that
 * overflows its column on a phone. Wrapping it in an aspect-ratio box and
 * absolutely positioning the iframe inside makes the embed fill its column at
 * any width.
 *
 * Everything the player needs to stop tracking the reader is set here:
 * `youtube-nocookie` avoids setting cookies until play, `loading="lazy"` keeps
 * three embeds from fetching the player bundle on page load, and
 * `referrerpolicy` keeps our URLs out of the request.
 *
 * @param {string} videoId a bare 11-character id, from store.readVideoIds()
 * @param {string} title used for the accessible name
 * @param {number} index 1-based, for the label
 * @returns {string} markup, or '' if the id is unusable
 */
function interviewEmbed(videoId, title, index) {
  /*
  Asserted against YOUTUBE_EMBED_HOSTS rather than trusted because it came out of
  our own youtubeEmbedUrl(). The id is the untrusted part -- it arrives from a
  database column a writer filled in -- so this is the one place that proves the
  finished src cannot point anywhere but YouTube before it reaches an iframe.
  Returning '' drops the embed entirely, which is the right outcome for a value
  no id should ever have produced.
  */
  const src = safeUrl(store.youtubeEmbedUrl(videoId), {
    allowedHosts: store.YOUTUBE_EMBED_HOSTS
  });
  if (!src) return '';

  return `
    <figure class="interview-embed">
      <div class="interview-embed__frame">
        <iframe
          src="${escapeHtml(src)}"
          title="${escapeHtml(`${title} — part ${index}`)}"
          loading="lazy"
          allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          referrerpolicy="strict-origin-when-cross-origin"
          allowfullscreen="true"
        ></iframe>
      </div>
      <figcaption class="interview-embed__caption">
        <span class="interview-embed__part" aria-hidden="true">${index}</span>
        <span>Part ${index} of this interview</span>
      </figcaption>
    </figure>
  `;
}

/**
 * One interview card on the feed.
 *
 * A poster image is preferred over an inline embed: three players loading at
 * once is the single heaviest thing this page could do, and a reader scanning
 * the feed wants to see who it is with before deciding to play anything.
 *
 * @param {object} interview
 */
function interviewCard(interview) {
  if (!interview) return '';
  const poster = safeUrl(interview.image) || BLANK_IMAGE;
  const videoCount = (interview.videoIds || []).length;

  return `
    <article class="panel-raised flex h-full flex-col overflow-hidden">
      <div class="relative">
        <img
          src="${escapeHtml(poster)}"
          ${imageFallbackAttr(BLANK_IMAGE)}
          alt=""
          loading="lazy"
          decoding="async"
          class="h-44 w-full object-cover"
        />
        ${
          videoCount
            ? `<span class="badge badge-neutral absolute bottom-2 left-2">
                 <i class="fa-solid fa-play text-[0.5rem]" aria-hidden="true"></i>
                 ${videoCount} video${videoCount === 1 ? '' : 's'}
               </span>`
            : ''
        }
      </div>

      <div class="flex flex-1 flex-col p-4">
        <p class="text-[0.625rem] font-semibold tracking-[0.12em] uppercase">
          <span class="accent-text">Interview</span>
          ${
            interview.guestRole
              ? `<span class="ink-muted"> · ${escapeHtml(interview.guestRole)}</span>`
              : ''
          }
        </p>

        <h3 class="mt-2 font-headline text-lg leading-tight font-black">
          ${escapeHtml(interview.guest || 'Unnamed guest')}
        </h3>

        <p class="ink-muted mt-1 text-[0.6875rem]">
          ${escapeHtml(interview.title)}
          ${interview.interviewer ? ` · by ${escapeHtml(interview.interviewer)}` : ''}
        </p>

        ${
          interview.summary
            ? `<p class="mt-3 text-sm leading-relaxed ink-muted">${escapeHtml(
                interview.summary
              )}</p>`
            : ''
        }

        <button type="button" class="btn btn-accent mt-4 self-start" data-interview="${escapeHtml(
          interview.id
        )}">
          <i class="fa-solid fa-play" aria-hidden="true"></i>
          Watch the interview
        </button>
      </div>
    </article>
  `;
}

/** The Newer/Older pager. Rendered only when there is somewhere to go. */
function interviewPager({ page, pageCount, hasPrev, hasNext, total }) {
  if (pageCount <= 1) {
    return total
      ? `<p class="ink-muted mt-6 text-center text-xs">
           All ${total} published interview${total === 1 ? '' : 's'} are shown above.
         </p>`
      : '';
  }

  return `
    <nav class="mt-8 flex items-center justify-center gap-3" aria-label="Interviews pages">
      <button
        class="btn btn-ghost"
        data-interview-page="${page - 1}"
        ${hasPrev ? '' : 'disabled aria-disabled="true"'}
      >
        <i class="fa-solid fa-arrow-left text-[0.6rem]" aria-hidden="true"></i>
        Newer
      </button>

      <span class="ink-muted text-xs" aria-live="polite">
        Page ${page} of ${pageCount}
      </span>

      <button
        class="btn btn-ghost"
        data-interview-page="${page + 1}"
        ${hasNext ? '' : 'disabled aria-disabled="true"'}
      >
        Older
        <i class="fa-solid fa-arrow-right text-[0.6rem]" aria-hidden="true"></i>
      </button>
    </nav>
  `;
}

/**
 * The interviews page: three published interviews per page, with a pager.
 *
 * Rendered into #interviews-view by src/app.js. Same shape as the gallery page --
 * the element is repainted wholesale on every store change, so the click
 * delegation is (re)assigned here rather than bound once per card.
 */
export function renderInterviewsPage() {
  const view = byId('interviews-view');
  if (!view) return;

  const published = store.listPublishedInterviews();
  const result = store.listPublishedInterviewsPage(interviewPage);

  /*
  Everything below reads `result.*`, NOT the raw `interviewPage`. The store
  clamps a stale or out-of-range page number (an Owner who deletes an interview
  from the panel while a reader sits on the last page would otherwise strand that
  reader on an empty grid), and hasPrev/hasNext come from the clamped value so
  the pager cannot disagree with the grid it sits under.
  */

  view.innerHTML = `
    ${sectionHeading('interviews-page-heading', 'On the record', 'Interviews')}

    ${
      published.length
        ? `<p class="ink-muted mb-6 text-sm">
             ${published.length} published interview${published.length === 1 ? '' : 's'},
             ${result.pageCount} page${result.pageCount === 1 ? '' : 's'}.
           </p>`
        : ''
    }

    ${
      result.items.length
        ? `<div class="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
             ${result.items.map(interviewCard).join('')}
           </div>
           ${interviewPager({
             page: result.page,
             pageCount: result.pageCount,
             hasPrev: result.hasPrev,
             hasNext: result.hasNext,
             total: result.total
           })}`
        : published.length
          ? `<p class="panel p-6 text-sm ink-muted">No interviews on this page.</p>`
          : `<p class="panel p-6 text-sm ink-muted">
               No interviews have been published yet. The Pulse interviews
               commissioners, archivists and organisers on the record; recordings
               appear here once the Owner has approved them.
             </p>`
    }
  `;

  view.onclick = (event) => {
    const opener = event.target.closest('[data-interview]');
    if (opener) {
      openInterview(opener.dataset.interview);
      return;
    }

    const pager = event.target.closest('[data-interview-page]');
    if (pager) {
      const next = Number(pager.dataset.interviewPage);
      // A disabled button is still clickable in some browsers, and a NaN here
      // would silently reset the reader to page 1 without them asking for it.
      if (!Number.isInteger(next) || next < 1 || next > result.pageCount) return;
      interviewPage = next;
      renderInterviewsPage();
      view.focus?.();
      window.scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' });
    }
  };
}

/**
 * Open one interview in the reading modal.
 *
 * Pending interviews are refused with a toast rather than rendered: the store
 * already filters them out of the public list, so a link reaching here with one
 * is either a stale render or a hand-typed id, and either way the answer is the
 * same -- it has not been approved yet.
 *
 * @param {string} id
 */
export function openInterview(id) {
  const interview = store.getInterview(id);
  const body = byId('interview-modal-body');
  if (!interview || !body) return;

  if (String(interview.status || '').toLowerCase() !== 'published') {
    showToast('That interview is still awaiting approval.', { type: 'info' });
    return;
  }

  // Split on blank lines so each becomes its own <p>, exactly as the article
  // reader does. escapeHtml on every block: an interview description is
  // free-text written by a writer in the panel, not trusted markup.
  const paragraphs = String(interview.description || '')
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => `<p class="mt-4">${escapeHtml(block)}</p>`)
    .join('');

  const poster = safeUrl(interview.image);
  // readVideoIds() rather than trusting the stored array: it re-normalises, drops
  // anything unparseable and caps the list, so a row written before the CHECK was
  // tightened still renders three or fewer embeds rather than anything it holds.
  const videos = store.readVideoIds(interview.videoIds);
  const label = interview.guest || interview.title || 'Interview';

  /*
  published_at is a timestamptz, and the feed orders by it, so it is the date the
  reader wants. Formatted through the same path as the masthead rather than
  printed raw: the raw value is an ISO string and renders as a wall of digits in
  the middle of a headline. Falls back to created_at for a row that was published
  without a stamp.
  */
  const stamp = interview.publishedAt || interview.createdAt;
  const shown = stamp
    ? new Date(stamp).toLocaleDateString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric'
      })
    : '';

  body.innerHTML = `
    <article>
      ${
        poster
          ? `<figure>
               <img
                 src="${escapeHtml(poster)}"
                 ${imageFallbackAttr(BLANK_IMAGE)}
                 alt="${escapeHtml(label)}"
                 class="h-52 w-full object-cover md:h-72"
               />
             </figure>`
          : ''
      }

      <div class="p-6 md:p-8">
        <div class="flex flex-wrap items-center gap-2 text-[0.625rem] font-semibold tracking-[0.14em] uppercase">
          <span class="badge badge-gold">Interview</span>
          ${shown ? `<span class="ink-muted font-mono">${escapeHtml(shown)}</span>` : ''}
        </div>

        <h2 id="interview-modal-title" class="mt-3 font-headline text-2xl leading-tight font-black md:text-4xl">
          ${escapeHtml(label)}
        </h2>

        <p class="ink-muted mt-2 text-xs font-semibold tracking-wide uppercase">
          ${interview.guestRole ? escapeHtml(interview.guestRole) : ''}${interview.guestRole && interview.interviewer ? ' &middot; ' : ''}${interview.interviewer ? `by ${escapeHtml(interview.interviewer)}` : ''}
        </p>

        ${interview.title ? `<h3 class="mt-4 font-headline text-lg leading-snug font-bold">${escapeHtml(interview.title)}</h3>` : ''}

        ${interview.summary ? `<p class="mt-3 text-base leading-relaxed">${escapeHtml(interview.summary)}</p>` : ''}

        ${
          videos.length
            ? `<div class="mt-8 space-y-6">
                 ${videos.map((videoId, index) => interviewEmbed(videoId, label, index + 1)).join('')}
               </div>`
            : `<p class="ink-muted mt-8 text-sm">No recording has been attached to this interview yet.</p>`
        }

        <div class="first-letter-cap mt-8">${
          paragraphs || '<p class="mt-4">This interview has no written notes yet.</p>'
        }</div>
      </div>
    </article>
  `;

  openDialog('interview-modal');
}

/**
 * The dialog is declared once in index.html, so it is only ever populated here.
 * @param {string} id
 */
function openLightbox(id) {
  const dialog = byId('lightbox');
  const frame = byId('lightbox-image');
  const caption = byId('lightbox-caption');
  if (!dialog || !frame || !caption) return;

  const shot = store.listGallery().find((entry) => entry.id === id);
  if (!shot) return;

  frame.src = safeUrl(shot.url) || BLANK_IMAGE;
  frame.alt = shot.caption || '';
  caption.textContent = shot.caption || '';

  /*
  Route the lightbox through openDialog() rather than showing it by hand.

  It used to do `dialog.classList.remove('hidden')` plus an inline
  `document.body.style.overflow = 'hidden'`. Two problems followed:

    1. Bypassing openDialog() meant the dialog was never counted, so the
       delegated Escape/Tab-trap handlers could not see it and it never released
       the scroll lock it had taken. Nothing ever removed that inline style.
    2. An inline `overflow: hidden` outranks EVERY stylesheet rule. When the
       Owner then opened the Newsroom Panel from the gallery, the phone rule
       `body.admin-active { overflow: auto }` could not restore scrolling, so
       the panel was mounted but frozen and unreachable below the tab strip.

  openDialog() counts the lock and toggles a `dialog-locked` CLASS, which
  participates in the normal cascade and is cleared by releaseDialogLocks().
  */
  openDialog(dialog, { initialFocus: '#lightbox-close' });
}

/** The lead story block. */
function renderTodaysPick(todaysPick) {
  if (!todaysPick) {
    return `<p class="panel p-6 text-sm ink-muted">No stories have been published yet.</p>`;
  }
  const href = `#article-${escapeHtml(todaysPick.id)}`;
  return `
    <article class="grid items-center gap-6 md:grid-cols-5">
      <a href="${href}" class="md:col-span-3" tabindex="-1" aria-hidden="true">
        <img
          src="${escapeHtml(safeUrl(todaysPick.image) || BLANK_IMAGE)}"
          ${imageFallbackAttr(BLANK_IMAGE)}
          alt=""
          decoding="async"
          class="h-64 w-full object-cover md:h-96"
        />
      </a>
      <div class="md:col-span-2">
        <span class="badge badge-live">${escapeHtml(todaysPick.category)}</span>
        <h3 class="mt-3 font-headline text-2xl leading-tight font-black md:text-3xl">
          <a href="${href}" class="text-link">${escapeHtml(todaysPick.title)}</a>
        </h3>
        ${renderByline(todaysPick, {
          cls: 'mt-2 text-[0.6875rem] ink-muted',
          suffix: ` · ${todaysPick.date}`
        })}
        ${captionText(todaysPick.caption)
            ? `<p class="mt-3 text-xs italic ink-muted">${escapeHtml(
                captionText(todaysPick.caption)
              )}</p>`
            : ''}
        <button type="button" class="btn btn-primary mt-4" data-read="${escapeHtml(todaysPick.id)}">
          <i class="fa-solid fa-book-open" aria-hidden="true"></i>
          Read the full dispatch
        </button>
      </div>
    </article>
  `;
}

/** One of the three curated weekly slots. */
function renderWeeklySlot({ label, item }) {
  return `
    <div class="panel-raised p-4">
      <p class="accent-text text-[0.625rem] font-bold tracking-[0.2em] uppercase">${escapeHtml(label)}</p>
      ${
        item
          ? `<img src="${escapeHtml(safeUrl(item.image) || BLANK_IMAGE)}" ${imageFallbackAttr(BLANK_IMAGE)} alt="" loading="lazy" decoding="async" class="mt-3 h-40 w-full object-cover" />
             <h3 class="mt-3 font-headline text-lg leading-snug font-black">
               <a href="#article-${escapeHtml(item.id)}" class="text-link">${escapeHtml(item.title)}</a>
             </h3>
             ${renderByline(item, { cls: 'mt-1 text-[0.6875rem] ink-muted' })}
             <button type="button" class="btn btn-quiet mt-2 px-0" data-read="${escapeHtml(item.id)}">
               Open <i class="fa-solid fa-arrow-right text-[0.5rem]" aria-hidden="true"></i>
             </button>`
          : `<p class="mt-3 text-sm ink-muted">No story curated for this slot yet.</p>`
      }
    </div>
  `;
}

/** The public, read-only assignment board. */
function renderAssignmentBoard(assignments) {
  if (!assignments.length) {
    return `<p class="panel p-6 text-sm ink-muted">No open assignments. The owner has not posted any calls.</p>`;
  }

  return `
    <div class="panel-raised divide-y">
      ${assignments
        .map(
          (item) => `
        <article class="flex flex-wrap items-center gap-3 p-4">
          <div class="min-w-0 flex-1">
            <h3 class="font-headline text-base leading-snug font-bold">${escapeHtml(item.title)}</h3>
            <p class="mt-1 text-[0.6875rem] ink-muted">
              ${
                item.reporter
                  ? `Assigned to ${escapeHtml(item.reporter)}`
                  : 'Unclaimed — reporters may submit a pitch'
              }
              ${item.deadline ? ` · deadline ${escapeHtml(item.deadline)}` : ''}
            </p>
          </div>
          <span class="${statusBadge(item.status)}">${escapeHtml(item.status)}</span>
        </article>
      `
        )
        .join('')}
    </div>
  `;
}

/* -------------------------------------------------------------------------- */
/* Article reader modal                                                      */
/* -------------------------------------------------------------------------- */

/** Open a published article in the reading modal. */
export async function openArticle(id) {
  const article = store.getArticle(id);
  const body = byId('article-modal-body');
  if (!article || !body) return;

  if (String(article.status || '').toLowerCase() !== 'published') {
    showToast('That dispatch is still in the editorial queue.', { type: 'info' });
    return;
  }

  // NOTE: permission is deliberately NOT requested here. Opening a story is a
  // click, but it is not a deliberate opt-in, and Android Chrome suppresses a
  // permission prompt that is not the result of an explicit "turn on alerts"
  // action. The request lives behind the opt-in button in views/alerts.js only.

  // Split the body on blank lines so each becomes a <p>.
  const paragraphs = String(article.body || '')
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => `<p class="mt-4">${escapeHtml(block)}</p>`)
    .join('');

  const image = safeUrl(article.image);
  const extraPhotos = Array.isArray(article.extraImages)
    ? article.extraImages.filter(Boolean)
    : [];

  body.innerHTML = `
    <article>
      ${
        image
          ? `<figure>
              <img src="${escapeHtml(image)}" ${imageFallbackAttr(BLANK_IMAGE)} alt="${escapeHtml(captionText(article.caption))}" class="h-56 w-full object-cover md:h-72" />
              ${
                captionText(article.caption)
                  ? `<figcaption class="surface-sunken px-5 py-2 text-xs italic ink-muted">${escapeHtml(captionText(article.caption))}</figcaption>`
                  : ''
              }
            </figure>`
          : ''
      }
      <div class="p-6 md:p-8">
        <div class="flex flex-wrap items-center gap-2 text-[0.625rem] font-semibold tracking-[0.14em] uppercase">
          <span class="badge badge-gold">${escapeHtml(article.category)}</span>
          <span class="ink-muted font-mono">${escapeHtml(article.date)}</span>
        </div>
        <h2 id="article-modal-title" class="mt-3 font-headline text-2xl leading-tight font-black md:text-4xl">
          ${escapeHtml(article.title)}
        </h2>
        ${renderByline(article, {
          cls: 'mt-2 text-xs font-semibold tracking-wide uppercase ink-muted'
        })}
        <div class="first-letter-cap mt-2">${paragraphs || '<p class="mt-4">This dispatch has no body copy yet.</p>'}</div>
        ${renderArticlePhotoStrip(extraPhotos)}
      </div>
    </article>
  `;

  // The strip expands in place. Bound on the dialog body, which was just
  // replaced wholesale, so the listener dies with the old nodes.
  body.querySelectorAll('[data-photo-toggle]').forEach((trigger) => {
    trigger.addEventListener('click', () => {
      const panel = body.querySelector(
        `[data-photo-panel="${trigger.dataset.photoToggle}"]`
      );
      const open = trigger.getAttribute('aria-expanded') === 'true';
      if (!panel) return;
      trigger.setAttribute('aria-expanded', String(!open));
      panel.hidden = open;
    });
  });

  openDialog('article-modal');
}

/**
 * The supporting photographs under a dispatch's body copy.
 *
 * Collapsed by default: a phone reader who opens a story to read it should not
 * be scrolled past three full-bleed images first. One row of small thumbnails
 * sits after the copy, and tapping it expands the photos in place rather than
 * paging to a separate screen -- the reader stays in the article they opened.
 *
 * The count is capped at MAX_ARTICLE_PHOTOS in the store, so nothing has to be
 * trimmed here; this function only renders what it is given.
 *
 * @param {string[]} urls
 */
function renderArticlePhotoStrip(urls) {
  if (!urls.length) return '';

  return `
    <section class="article-photos" aria-label="More photographs from this story">
      <h3 class="rule-soft mb-3 mt-8 border-t pt-4 font-headline text-xs font-bold tracking-[0.18em] uppercase ink-muted">
        ${urls.length} more photograph${urls.length === 1 ? '' : 's'}
      </h3>

      <button
        type="button"
        class="article-photos__toggle"
        data-photo-toggle="strip"
        aria-expanded="false"
        aria-controls="article-photo-panel"
      >
        <span class="article-photos__thumbs" aria-hidden="true">
          ${urls
            .map(
              (url) =>
                `<img src="${escapeHtml(safeUrl(url) || BLANK_IMAGE)}" ${imageFallbackAttr(BLANK_IMAGE)} alt="" loading="lazy" decoding="async" />`
            )
            .join('')}
        </span>
        <span class="article-photos__label">
          <i class="fa-solid fa-images" aria-hidden="true"></i>
          View the photo set
        </span>
      </button>

      <div class="article-photos__grid" id="article-photo-panel" data-photo-panel="strip" hidden>
        ${urls
          .map(
            (url, index) => `
            <figure class="article-photos__item">
              <img
                src="${escapeHtml(safeUrl(url) || BLANK_IMAGE)}"
                ${imageFallbackAttr(BLANK_IMAGE)}
                alt="Supporting photograph ${index + 1} for this story"
                loading="lazy"
                decoding="async"
              />
            </figure>`
          )
          .join('')}
      </div>
    </section>
  `;
}

/* -------------------------------------------------------------------------- */
/* Archive search                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Filter the published archive as the visitor types.
 * @param {string} query
 */
export function runSearch(query) {
  const target = byId('search-results');
  if (!target) return;

  const needle = String(query || '').trim().toLowerCase();
  const published = store.listPublishedArticles();

  if (!needle) {
    target.innerHTML = published
      .slice(0, 6)
      .map(
        (article) => `
        <button type="button" class="panel-sunken w-full p-3 text-left hover:opacity-80" data-search-id="${escapeHtml(article.id)}">
          <span class="accent-text block text-[0.625rem] font-bold tracking-[0.14em] uppercase">${escapeHtml(article.category)}</span>
          <span class="mt-1 block font-headline text-base font-bold">${escapeHtml(article.title)}</span>
          ${renderByline(article, {
            tag: 'span',
            cls: 'mt-0.5 block text-[0.6875rem] ink-muted',
            suffix: ` · ${article.date}`
          })}
        </button>`
      )
      .join('');
  } else {
    const matches = published.filter((article) =>
      [article.title, article.author, article.category, article.body]
        .join(' ')
        .toLowerCase()
        .includes(needle)
    );

    target.innerHTML = matches.length
      ? matches
          .map(
            (article) => `
        <button type="button" class="panel-sunken w-full p-3 text-left hover:opacity-80" data-search-id="${escapeHtml(article.id)}">
          <span class="accent-text block text-[0.625rem] font-bold tracking-[0.14em] uppercase">${escapeHtml(article.category)}</span>
          <span class="mt-1 block font-headline text-base font-bold">${escapeHtml(article.title)}</span>
          ${renderByline(article, {
            tag: 'span',
            cls: 'mt-0.5 block text-[0.6875rem] ink-muted',
            suffix: ` · ${article.date}`
          })}
        </button>`
          )
          .join('')
      : `<p class="panel-sunken p-4 text-sm ink-muted">No dispatch matches "${escapeHtml(query)}".</p>`;
  }

  target.querySelectorAll('[data-search-id]').forEach((button) => {
    button.addEventListener('click', () => {
      closeDialog('search-modal');
      openArticle(button.dataset.searchId);
    });
  });
}

/** Open the search dialog and focus the query field. */
export function openSearch() {
  const input = byId('search-input');
  if (input) input.value = '';
  runSearch('');
  openDialog('search-modal', { initialFocus: '#search-input' });
}

/* -------------------------------------------------------------------------- */
/* Podcasts                                                                    */
/* -------------------------------------------------------------------------- */

/** Playback rates the speed button cycles through, slowest first. */
const PODCAST_SPEEDS = [0.75, 1, 1.25, 1.5, 2];

/** Seconds to `M:SS`, or `H:MM:SS` past an hour. */
export function formatClock(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * Paint the public podcast feed into #podcasts-view.
 *
 * Repainted on every reveal rather than once, for the same reason the gallery
 * and interviews feeds are: the Owner can approve an episode at any moment, and a
 * reader who has the tab open must not be left on a stale list.
 */
export function renderPodcastsPage() {
  const view = byId('podcasts-view');
  if (!view) return;

  view.innerHTML = `
    <div class="mx-auto max-w-4xl px-4 py-10 md:py-14">
      ${sectionHeading('podcasts-heading', 'Listen', 'Podcasts')}
      <div id="podcast-feed" class="space-y-4">
        <p class="panel-sunken p-6 text-center text-sm ink-muted">
          <i class="fa-solid fa-circle-notch spin-slow me-2" aria-hidden="true"></i>
          Loading episodes…
        </p>
      </div>
    </div>
  `;

  const feed = byId('podcast-feed');
  if (!feed) return;

  listPodcasts()
    .then((episodes) => {
      if (!feed.isConnected) return;

      if (!episodes.length) {
        feed.innerHTML = `
          <p class="panel-sunken p-8 text-center text-sm ink-muted">
            <i class="fa-solid fa-microphone-lines mb-3 text-2xl" aria-hidden="true"></i><br />
            No episodes have been published yet.
          </p>`;
        return;
      }

      feed.innerHTML = episodes.map(podcastCard).join('');
      feed.querySelectorAll('[data-podcast-player]').forEach(wirePodcastPlayer);
    })
    .catch((error) => {
      console.warn('[public] podcasts failed to load', error);
      if (!feed.isConnected) return;
      feed.innerHTML = `
        <p class="panel-sunken p-8 text-center text-sm ink-muted">
          The episodes could not be loaded just now. Please try again shortly.
        </p>`;
    });
}

/**
 * One episode card.
 *
 * The <audio> element carries no `controls`. This is a custom player, and
 * leaving the native one in place would put two sets of transport controls on the
 * same card. `preload="metadata"` so the duration is known before playback
 * without pulling the whole file down for a reader who only ever sees the card.
 */
function podcastCard(episode) {
  const duration = Number(episode.duration_seconds) || 0;
  const playable = Boolean(episode.audio_url);
  // Artwork, which migration 031 added and this card never rendered: the column
  // was stored and nothing read it, so a Writer who set a cover and an Owner who
  // did not produced visually identical episodes. `safeUrl` because it lands in
  // an `src`, and `imageFallbackAttr` so an episode whose art 404s loses the
  // picture rather than the episode.
  const cover = safeUrl(episode.cover_url);

  return `
    <article class="podcast-card" data-podcast-player>
      ${
        cover
          ? `<img class="podcast-card__cover" src="${escapeHtml(cover)}" ${imageFallbackAttr()}
               alt="" width="96" height="96" loading="lazy" decoding="async" />`
          : ''
      }

      <div class="podcast-card__head">
        <h3 class="podcast-card__title">${escapeHtml(episode.title || 'Untitled episode')}</h3>
        <p class="podcast-card__byline">${escapeHtml(episode.author_name || 'The Pulse Staff')}</p>
      </div>

      ${
        episode.description
          ? `<p class="podcast-card__desc">${escapeHtml(episode.description)}</p>`
          : ''
      }

      ${
        playable
          ? `
        <audio
          class="podcast-card__audio"
          data-audio
          src="${escapeHtml(episode.audio_url)}"
          preload="metadata"
        ></audio>

        <div class="podcast-player">
          <button
            type="button"
            class="podcast-player__toggle"
            data-toggle
            aria-label="Play episode"
          >
            <i class="fa-solid fa-play" data-icon aria-hidden="true"></i>
          </button>

          <span class="podcast-player__time" data-elapsed>0:00</span>

          <input
            type="range"
            class="podcast-player__scrub"
            data-scrub
            min="0"
            max="100"
            step="0.1"
            value="0"
            aria-label="Seek within the episode"
          />

          <span class="podcast-player__time" data-total>${
            duration ? escapeHtml(formatClock(duration)) : '0:00'
          }</span>

          <button
            type="button"
            class="podcast-player__speed"
            data-speed
            aria-label="Playback speed, currently 1 times"
          >1&times;</button>
        </div>`
          : `
        <p class="podcast-card__unavailable">
          <i class="fa-solid fa-circle-exclamation me-2" aria-hidden="true"></i>
          The audio for this episode is not available.
        </p>`
      }
    </article>
  `;
}

/**
 * Wire one card's transport controls.
 *
 * Three details that are easy to get wrong and were:
 *
 *   • While the pointer is DOWN on the scrubber the element is `scrubbing`, and
 *     `timeupdate` must not write `value` back -- otherwise the thumb snaps to
 *     wherever playback happens to be and the drag feels broken. The handler
 *     only writes back when the user is not dragging.
 *
 *   • Speed is applied on `ratechange` rather than on click, so a browser or
 *     extension that changes the rate on its own is reflected in the label.
 *
 *   • `ended` resets the transport. Without it a finished episode keeps the play
 *     icon and sits at the end of the bar looking paused.
 */
function wirePodcastPlayer(card) {
  const audio = card.querySelector('[data-audio]');
  const toggle = card.querySelector('[data-toggle]');
  const scrub = card.querySelector('[data-scrub]');
  const elapsed = card.querySelector('[data-elapsed]');
  const total = card.querySelector('[data-total]');
  const speed = card.querySelector('[data-speed]');
  const icon = card.querySelector('[data-icon]');

  if (!audio || !toggle || !scrub) return;

  let scrubbing = false;
  let speedIndex = PODCAST_SPEEDS.indexOf(1);

  const paint = (isPlaying) => {
    if (icon) icon.className = `fa-solid ${isPlaying ? 'fa-pause' : 'fa-play'}`;
    toggle.setAttribute('aria-label', isPlaying ? 'Pause episode' : 'Play episode');
    toggle.setAttribute('aria-pressed', String(isPlaying));
  };

  toggle.addEventListener('click', () => {
    if (audio.paused) {
      // A play() rejected by autoplay policy is silent otherwise, and the reader
      // is left tapping a button that appears to do nothing.
      audio.play().catch((error) => console.warn('[podcasts] play refused', error));
    } else {
      audio.pause();
    }
  });

  audio.addEventListener('play', () => paint(true));
  audio.addEventListener('pause', () => paint(false));

  audio.addEventListener('loadedmetadata', () => {
    if (total && Number.isFinite(audio.duration)) total.textContent = formatClock(audio.duration);
  });

  audio.addEventListener('durationchange', () => {
    if (total && Number.isFinite(audio.duration)) total.textContent = formatClock(audio.duration);
  });

  audio.addEventListener('timeupdate', () => {
    if (elapsed) elapsed.textContent = formatClock(audio.currentTime);
    if (scrubbing) return;
    const span = Number(audio.duration) || 0;
    scrub.value = span ? String((audio.currentTime / span) * 100) : '0';
  });

  audio.addEventListener('ended', () => {
    paint(false);
    scrub.value = '0';
    if (elapsed) elapsed.textContent = '0:00';
  });

  audio.addEventListener('error', () => {
    const note = card.querySelector('.podcast-card__unavailable');
    if (note) {
      note.innerHTML =
        '<i class="fa-solid fa-triangle-exclamation me-2" aria-hidden="true"></i>This episode could not be loaded.';
    }
    toggle.setAttribute('disabled', '');
  });

  scrub.addEventListener('pointerdown', () => {
    scrubbing = true;
  });

  const endScrub = () => {
    if (!scrubbing) return;
    scrubbing = false;
    const span = Number(audio.duration) || 0;
    if (span) audio.currentTime = (Number(scrub.value) / 100) * span;
  };

  scrub.addEventListener('pointerup', endScrub);
  scrub.addEventListener('pointercancel', endScrub);
  // A keyboard user never fires pointerdown, so the change event has to commit
  // the position too or the arrow keys move the thumb without seeking.
  scrub.addEventListener('change', endScrub);
  scrub.addEventListener('input', () => {
    const span = Number(audio.duration) || 0;
    if (elapsed && span) elapsed.textContent = formatClock((Number(scrub.value) / 100) * span);
  });

  if (speed) {
    const paintSpeed = () => {
      const rate = PODCAST_SPEEDS[speedIndex];
      speed.textContent = `${rate}\u00d7`;
      speed.setAttribute('aria-label', `Playback speed, currently ${rate} times`);
    };

    speed.addEventListener('click', () => {
      speedIndex = (speedIndex + 1) % PODCAST_SPEEDS.length;
      audio.playbackRate = PODCAST_SPEEDS[speedIndex];
      audio.defaultPlaybackRate = PODCAST_SPEEDS[speedIndex];
      paintSpeed();
    });

    audio.addEventListener('ratechange', () => {
      const found = PODCAST_SPEEDS.indexOf(Number(audio.playbackRate));
      if (found !== -1 && found !== speedIndex) {
        speedIndex = found;
        paintSpeed();
      }
    });

    paintSpeed();
  }

  paint(false);
}

/* -------------------------------------------------------------------------- */
/* Public interaction wiring                                                  */
/* -------------------------------------------------------------------------- */

/** Attach every listener the reader-facing page needs. Called once at boot. */
export function initPublicInteractions() {
  byId('open-search')?.addEventListener('click', openSearch);

  const searchInput = byId('search-input');
  searchInput?.addEventListener('input', (event) => runSearch(event.target.value));

  // Navigation: one link list, rendered three ways.
  //
  // Inline row, overflow menu and mobile drawer all read from NAV_LINKS below.
  // They were three separate hardcoded <ul>s at one point, and they drifted:
  // a section added to the masthead row never reached the drawer, so it was
  // simply unreachable on a phone. One source, three renderings.
  initNavigation();
}

/**
 * Every primary destination, in reading order.
 *
 * `page` values are the reader views the router knows; `anchor` values are
 * in-page sections of the publication. Split because the two navigate
 * differently -- an anchor scrolls, a page swaps the view -- and because the
 * footer and the drawer both need the split to decide what markup to emit.
 */
const NAV_LINKS = [
  /*
   * SEVEN DESTINATIONS, DELIBERATELY.
   *
   * "Today's Pick" and "Weekly" were removed from the header. Their SECTIONS still
   * exist on the front page and are still rendered — they are simply no longer
   * destinations the header offers, so a reader reaches them by scrolling rather
   * than by picking from a row of labels.
   *
   * That matters for more than tidiness. This list is the single source for three
   * renderings — the inline bar, the "More" overflow menu and the phone drawer —
   * and it is also what `measureNav()` budgets against. Every entry here is a
   * label competing for width at 320px, so each one removed is width given back
   * to the controls beside it. The overflow menu exists precisely because this
   * row used to be ten wide; at seven it is much closer to fitting outright.
   *
   * "Masthead" was removed from the drawer's footer at the same time, for the same
   * reason: it is a masthead link, and the masthead is the thing you are already
   * looking at.
   */
  { label: 'Latest', anchor: '#latest' },
  { label: 'Assignments', anchor: '#assignments' },
  { label: 'Interviews', page: 'interviews' },
  { label: 'Podcasts', page: 'podcasts' },
  { label: 'Photo Gallery', page: 'gallery' },
  { label: 'Credits', page: 'credits' },
  { label: 'About Us', page: 'about' }
];

function initNavigation() {
  const bar = document.querySelector('.nav-bar');
  const list = byId('primary-links');
  const burger = byId('mobile-nav-toggle');
  const drawer = byId('nav-drawer');
  const drawerList = drawer?.querySelector('[data-nav-drawer-list]');
  const moreWrap = document.querySelector('[data-nav-more]');
  const moreToggle = byId('nav-more-toggle');
  const moreMenu = byId('nav-more-menu');

  if (!bar || !list) return;

  /* --- the drawer ------------------------------------------------------- */
  // A <dialog> rather than a styled <ul>: on a phone the links cover the
  // viewport, and something that covers the page has to trap focus, take Escape,
  // return focus to the control that opened it, and stop the page behind it
  // scrolling. showModal() provides all four; a hidden <ul> provides none.
  if (drawer && drawerList) {
    drawerList.innerHTML = NAV_LINKS.map((link) => {
      const inner = link.page
        ? `<button type="button" data-nav="${escapeHtml(link.page)}">${escapeHtml(link.label)}</button>`
        : `<a href="${escapeHtml(link.anchor)}">${escapeHtml(link.label)}</a>`;
      return `<li class="nav-drawer__item">${inner}</li>`;
    }).join('');

    const openDrawer = () => {
      if (drawer.open) return;
      drawer.showModal();
      burger?.setAttribute('aria-expanded', 'true');
      // The page behind a modal dialog must not scroll under the reader's thumb.
      document.body.style.overflow = 'hidden';
    };

    const closeDrawer = () => {
      if (!drawer.open) return;
      drawer.close();
      burger?.setAttribute('aria-expanded', 'false');
      document.body.style.removeProperty('overflow');
    };

    burger?.addEventListener('click', openDrawer);
    drawer.querySelector('#nav-drawer-close')?.addEventListener('click', closeDrawer);

    // Escape closes a modal dialog natively, but `close` does not fire our
    // handler, so the burger's aria-expanded and the body scroll lock would be
    // left behind. This is the one event that has to be listened for explicitly.
    drawer.addEventListener('close', () => {
      burger?.setAttribute('aria-expanded', 'false');
      document.body.style.removeProperty('overflow');
    });

    // Choosing a destination should dismiss the sheet rather than leave it
    // covering the page the reader just asked for.
    drawerList.addEventListener('click', (event) => {
      if (event.target.closest('a, button')) closeDrawer();
    });
  }

  /* --- the overflow menu ------------------------------------------------ */
  const closeMore = () => {
    if (!moreMenu || moreMenu.hidden) return;
    moreMenu.hidden = true;
    moreToggle?.setAttribute('aria-expanded', 'false');
  };

  moreToggle?.addEventListener('click', (event) => {
    event.stopPropagation();
    const open = moreMenu.hidden;
    moreMenu.hidden = !open;
    moreToggle.setAttribute('aria-expanded', String(open));
  });

  document.addEventListener('click', (event) => {
    if (event.target.closest('[data-nav-more]')) return;
    closeMore();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeMore();
  });

  /* --- measure, do not guess -------------------------------------------- */
  // A media query would need hand-tuning against a wordmark whose width depends
  // on the theme's font, and it is wrong the moment a label changes length.
  // Measuring the row's natural width against the space available is exact and
  // self-correcting: links move into "More" until the row fits, and back out
  // when it does.
  const overflowItems = [...list.querySelectorAll('[data-nav-overflow]')];

  /**
   * The width the inline row needs.
   *
   * NOT `list.scrollWidth`. The <ul> is itself a shrinkable flex item inside a
   * `justify-content: space-between` row, so the browser compresses IT before
   * anything overflows -- which means its scrollWidth reads back as the width it
   * was squeezed to, and the check reports "fits" while labels are wrapping
   * inside their own boxes. That is the bug this bar had twice.
   *
   * Summing the items and adding the gaps measures what the row actually wants,
   * which is the only number that can be compared against the space available.
   *
   * EVERY item is counted, not just the movable ones. Summing only the overflow
   * candidates made this return 416px against 514px of space -- "it fits", move
   * nothing -- while the five primary links the reader could not avoid took up
   * another 530px the decision never saw. The row then overflowed the viewport by
   * 295px and the page scrolled sideways. An overflow decision that ignores
   * fixed content is not an overflow decision.
   */
  const neededWidth = () => {
    const shown = [...list.children].filter(
      (item) => !item.hidden && item.offsetWidth > 0
    );
    if (!shown.length) return 0;
    const gap = Number.parseFloat(getComputedStyle(list).columnGap) || 0;
    return shown.reduce((sum, item) => sum + item.offsetWidth, 0) + gap * (shown.length - 1);
  };

  const placeOverflow = () => {
    if (!overflowItems.length || !moreWrap) return;

    // Start from everything inline, in a state that does not disturb layout.
    for (const item of overflowItems) item.hidden = false;
    moreWrap.hidden = true;

    // Below the drawer breakpoint every item measures 0 (the list is display:none)
    // and "More" stays hidden -- the drawer is the answer there, not a menu.
    const toolsWidth = bar.querySelector('.nav-bar__tools')?.offsetWidth || 0;
    const available = bar.clientWidth - toolsWidth - 32; // 32 = bar padding

    if (neededWidth() <= available) {
      // Everything fits. Hide "More" entirely rather than offering a menu with
      // nothing in it.
      moreWrap.hidden = true;
      closeMore();
      return;
    }

    // Otherwise move links out until the row fits. Longest labels go first, so
    // the ones that stay visible are the ones that read worst in a menu.
    for (const candidate of overflowItems) {
      if (neededWidth() <= available) break;
      if (candidate.hidden) continue;

      // Move the widest REMAINING item, measured, rather than assuming that
      // document order is width order. "Photo Gallery" is not the last item but
      // it is usually the widest.
      const widest = overflowItems
        .filter((item) => !item.hidden)
        .sort((a, b) => b.offsetWidth - a.offsetWidth)[0];
      if (!widest) break;

      widest.hidden = true;

      // `widest` may be a later item than `candidate`, so walk forward until the
      // widest one is passed. Without this the loop iterates `candidate` twice for
      // the same row and the menu ends up listing "Credits" twice.
      if (widest === candidate) continue;
    }

    // The menu is built from the DOM, not from a log of what was moved. The
    // hidden flags are the single source of truth, so an item cannot be listed
    // twice no matter how the loop above got there -- which is exactly what
    // happened when the menu was built from an accumulator.
    const hidden = overflowItems.filter((item) => item.hidden);

    moreWrap.hidden = hidden.length === 0;
    if (hidden.length === 0) {
      closeMore();
      return;
    }

    moreMenu.innerHTML = hidden
      .map((item) => {
        const button = item.querySelector('button');
        if (!button) return '';
        const page = button.dataset.nav;
        return `<li><button type="button" data-nav="${escapeHtml(page)}">${escapeHtml(
          button.textContent.trim()
        )}</button></li>`;
      })
      .join('');
  };

  placeOverflow();

  // Re-measure on resize and on the theme change, since the wordmark width moves
  // with the font. Debounced: a drag of the window edge fires this constantly.
  let resizeTimer = null;
  const remeasure = () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(placeOverflow, 120);
  };

  window.addEventListener('resize', remeasure);
  document.addEventListener('wire:theme-changed', remeasure);

  // The auth slot is filled after boot and changes the width of the tools area.
  byId('auth-slot') &&
    new MutationObserver(remeasure).observe(byId('auth-slot'), {
      childList: true,
      subtree: true
    });
}
