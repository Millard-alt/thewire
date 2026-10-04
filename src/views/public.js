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
  formatEditionDate
} from '../lib/dom.js';
import { bylineSticker } from '../lib/credits.js';

/** A neutral placeholder for stories with no lead image. */
const BLANK_IMAGE =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 450">' +
      '<rect width="800" height="450" fill="#e7e1d3"/>' +
      '<text x="50%" y="50%" font-family="Georgia,serif" font-size="42" ' +
      'fill="#8c1d11" text-anchor="middle">The Wire</text></svg>'
  );

/* -------------------------------------------------------------------------- */
/* Header + ticker                                                            */
/* -------------------------------------------------------------------------- */

/** Paint the masthead from the stored branding + today's real date. */
export function renderMasthead() {
  const { branding } = store.getState();

  const title = byId('masthead-title');
  if (title) title.textContent = branding.title;

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
        ${bylineSticker(article.author, { cls: 'mt-1 text-[0.6875rem] ink-muted' })}
        ${
          showBody
            ? `<p class="mt-2 text-sm leading-relaxed ink-muted">${escapeHtml(
                (article.body || '').slice(0, 220)
              )}${(article.body || '').length > 220 ? '…' : ''}</p>`
            : ''
        }
        ${
          article.caption
            ? `<p class="mt-2 text-[0.6875rem] italic ink-muted">${escapeHtml(article.caption)}</p>`
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
  const todaysPick = store.getTodaysPick();
  const week = {
    article: store.getWeeklySlot('article'),
    event: store.getWeeklySlot('event'),
    picture: store.getWeeklySlot('picture')
  };
  const assignments = store.listAssignments();

  // Today's Pick is also shown as the lead story, so filter it out of the grid.
  const grid = published.filter((article) => article.id !== todaysPick?.id);
  const [lead, ...rest] = grid;

  view.innerHTML = `
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
    <section id="weekly" aria-labelledby="weekly-heading" class="mb-12">
      ${sectionHeading('weekly-heading', 'Curated by the owner', 'This Week In The Wire')}
      <div class="grid gap-6 md:grid-cols-3">
        ${[
          { label: 'Feature of the week', item: week.article },
          { label: 'On the record', item: week.event },
          { label: 'In pictures', item: week.picture }
        ]
          .map((entry) => renderWeeklySlot(entry))
          .join('')}
      </div>
    </section>

    <!-- ================= ASSIGNMENT BOARD ================= -->
    <section id="assignments" aria-labelledby="assignments-heading" class="mb-12">
      ${sectionHeading('assignments-heading', 'Open calls', 'Assignment Board')}
      ${renderAssignmentBoard(assignments)}
    </section>
  `;

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
                      alt="${escapeHtml(shot.caption || '')}"
                      loading="lazy"
                      decoding="async"
                    />
                    ${
                      shot.caption
                        ? `<span class="gallery-card__caption">${escapeHtml(shot.caption)}</span>`
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



/**
 * Open the shared lightbox on one gallery image.
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
        ${bylineSticker(todaysPick.author, {
          cls: 'mt-2 text-[0.6875rem] ink-muted',
          suffix: ` · ${todaysPick.date}`
        })}
        ${todaysPick.caption ? `<p class="mt-3 text-xs italic ink-muted">${escapeHtml(todaysPick.caption)}</p>` : ''}
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
          ? `<img src="${escapeHtml(safeUrl(item.image) || BLANK_IMAGE)}" alt="" loading="lazy" decoding="async" class="mt-3 h-40 w-full object-cover" />
             <h3 class="mt-3 font-headline text-lg leading-snug font-black">
               <a href="#article-${escapeHtml(item.id)}" class="text-link">${escapeHtml(item.title)}</a>
             </h3>
             ${bylineSticker(item.author, { cls: 'mt-1 text-[0.6875rem] ink-muted' })}
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
              <img src="${escapeHtml(image)}" alt="${escapeHtml(article.caption || '')}" class="h-56 w-full object-cover md:h-72" />
              ${
                article.caption
                  ? `<figcaption class="surface-sunken px-5 py-2 text-xs italic ink-muted">${escapeHtml(article.caption)}</figcaption>`
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
        ${bylineSticker(article.author, {
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
                `<img src="${escapeHtml(safeUrl(url) || BLANK_IMAGE)}" alt="" loading="lazy" decoding="async" />`
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
          ${bylineSticker(article.author, {
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
          ${bylineSticker(article.author, {
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
/* Public interaction wiring                                                  */
/* -------------------------------------------------------------------------- */

/** Attach every listener the reader-facing page needs. Called once at boot. */
export function initPublicInteractions() {
  byId('open-search')?.addEventListener('click', openSearch);

  const searchInput = byId('search-input');
  searchInput?.addEventListener('input', (event) => runSearch(event.target.value));

  // Mobile navigation disclosure.
  //
  // The list ships in the markup with `flex`, so before this ran it was visible
  // on a phone from first paint — the menu "auto-opened" on every page load and
  // the toggle only reacted to the *next* click. State is therefore applied on
  // init, and re-applied when the viewport crosses the desktop breakpoint so a
  // rotate/resize can never leave the links stranded in the wrong mode.
  const mobileToggle = byId('mobile-nav-toggle');
  const links = byId('primary-links');
  if (mobileToggle && links) {
    const desktop = window.matchMedia('(min-width: 48rem)');

    const setOpen = (open) => {
      mobileToggle.setAttribute('aria-expanded', String(open));
      links.classList.toggle('hidden', !open);
      links.classList.toggle('flex', open);
    };

    // Collapsed on phones, always visible from the `md` breakpoint up.
    const sync = () => setOpen(desktop.matches);
    sync();

    mobileToggle.addEventListener('click', () => {
      setOpen(mobileToggle.getAttribute('aria-expanded') !== 'true');
    });

    // Tapping a link should dismiss the sheet rather than leave it covering
    // the article the reader just asked to see.
    links.addEventListener('click', (event) => {
      if (event.target.closest('a, button') && !desktop.matches) setOpen(false);
    });

    desktop.addEventListener('change', sync);
  }
}
