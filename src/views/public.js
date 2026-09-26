/* =============================================================================
   src/views/public.js â€” THE PUBLIC PUBLICATION
   -----------------------------------------------------------------------------
   Renders the reader-facing newspaper: the breaking-news ticker, Today's Pick,
   the latest front-page grid, the three weekly feature slots, the public
   assignment board and the archive search. All content comes from the store,
   so anything the owner publishes in the control centre appears here on the
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
import { ensureAlertPermission } from './alerts.js';

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

  const accent =
    banner.color === 'Gold'
      ? 'var(--color-newsgold)'
      : banner.color === 'Blue'
        ? 'var(--color-newsblue)'
        : 'var(--color-newsred)';

  const url = safeUrl(banner.linkUrl);
  const severity = escapeHtml(banner.severity || 'Breaking');

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
        ${
          url && banner.linkText
            ? `<a class="btn shrink-0 border border-white/50 text-white hover:bg-white hover:text-black" href="${escapeHtml(url)}">${escapeHtml(banner.linkText)}</a>`
            : ''
        }
        ${
          banner.dismissible
            ? `<button type="button" id="dismiss-breaking" class="btn-quiet shrink-0 text-white" aria-label="Dismiss breaking news"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>`
            : ''
        }
      </div>
    </div>
  `;

  // The dismiss button only exists when the owner enabled `dismissible`, so it
  // is bound defensively after each paint.
  byId('dismiss-breaking')?.addEventListener('click', () => {
    slot.replaceChildren();
    showToast('Breaking-news alert dismissed for this visit.', { type: 'info' });
  });
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
        <p class="mt-1 text-[0.6875rem] ink-muted">By ${escapeHtml(article.author)}</p>
        ${
          showBody
            ? `<p class="mt-2 text-sm leading-relaxed ink-muted">${escapeHtml(
                (article.body || '').slice(0, 220)
              )}${(article.body || '').length > 220 ? 'â€¦' : ''}</p>`
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
          : `<p class="panel p-6 text-sm ink-muted">The archive is empty. Publish a story from the Owner Control Center to see it here.</p>`
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

    <!-- ================= PHOTO GALLERY ================= -->
    <section id="gallery" aria-labelledby="gallery-heading" class="mb-12">
      ${sectionHeading('gallery-heading', 'Selected by the owner', 'Photo Gallery')}
      ${renderGallery()}
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
  };
}

/**
 * The public photo gallery. Only images the Owner has explicitly published
 * appear here; the rest of the media shelf is an internal production resource
 * and is deliberately not exposed to readers.
 */
function renderGallery() {
  const shots = store.listGallery();

  if (!shots.length) {
    return `<p class="panel p-6 text-sm ink-muted">No photographs have been published to the gallery yet. The Owner can publish any image from the Media shelf in the Control Center.</p>`;
  }

  return `
    <p class="ink-muted mb-4 text-sm">
      ${shots.length} photograph${shots.length === 1 ? '' : 's'} from the newsroom.
    </p>
    <div class="gallery-grid">
      ${shots
        .map(
          (shot, index) => `
        <figure class="gallery-item">
          <button
            type="button"
            class="gallery-btn"
            data-lightbox="${escapeHtml(shot.id)}"
            aria-label="View larger: ${escapeHtml(shot.caption)}"
          >
            <img
              src="${escapeHtml(safeUrl(shot.url) || BLANK_IMAGE)}"
              alt="${escapeHtml(shot.caption)}"
              loading="lazy"
              decoding="async"
              width="640"
              height="480"
            />
            <span class="gallery-zoom" aria-hidden="true">
              <i class="fa-solid fa-magnifying-glass-plus"></i>
            </span>
          </button>
          <figcaption>${escapeHtml(shot.caption)}</figcaption>
        </figure>`
        )
        .join('')}
    </div>
  `;
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

  dialog.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  byId('lightbox-close')?.focus();
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
        <p class="mt-2 text-[0.6875rem] ink-muted">
          By ${escapeHtml(todaysPick.author)} Â· ${escapeHtml(todaysPick.date)}
        </p>
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
             <p class="mt-1 text-[0.6875rem] ink-muted">By ${escapeHtml(item.author)}</p>
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
                  : 'Unclaimed â€” reporters may submit a pitch'
              }
              ${item.deadline ? ` Â· deadline ${escapeHtml(item.deadline)}` : ''}
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

  // The publication is alert-first: a reader sees the notification
  // instructions before they can be pushed to, so the first popup they ever
  // receive is a real dispatch rather than a surprise prompt. Declining is
  // always allowed and never blocks reading \u2014 it only leaves alerts off.
  ensureAlertPermission();

  // Split the body on blank lines so each becomes a <p>.
  const paragraphs = String(article.body || '')
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => `<p class="mt-4">${escapeHtml(block)}</p>`)
    .join('');

  const image = safeUrl(article.image);

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
        <p class="mt-2 text-xs font-semibold tracking-wide uppercase ink-muted">
          By ${escapeHtml(article.author)}
        </p>
        <div class="first-letter-cap mt-2">${paragraphs || '<p class="mt-4">This dispatch has no body copy yet.</p>'}</div>
      </div>
    </article>
  `;

  openDialog('article-modal');
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
          <span class="mt-0.5 block text-[0.6875rem] ink-muted">By ${escapeHtml(article.author)} Â· ${escapeHtml(article.date)}</span>
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
          <span class="mt-0.5 block text-[0.6875rem] ink-muted">By ${escapeHtml(article.author)} Â· ${escapeHtml(article.date)}</span>
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

  // Mobile navigation disclosure
  const mobileToggle = byId('mobile-nav-toggle');
  const links = byId('primary-links');
  if (mobileToggle && links) {
    mobileToggle.addEventListener('click', () => {
      const expanded = mobileToggle.getAttribute('aria-expanded') === 'true';
      mobileToggle.setAttribute('aria-expanded', String(!expanded));
      links.classList.toggle('hidden', expanded);
      links.classList.toggle('flex', !expanded);
    });
  }
}
