/* =============================================================================
   src/views/admin.js — NEWSROOM PANEL
   -----------------------------------------------------------------------------
   The privileged workspace. It is only ever mounted by src/app.js after
   `isAdmin()` returns true, and it re-checks the session on every render, so a
   stale view can never be reached by typing a URL or a hash.

   Structure:
     • Shared render helpers  — badges, panel headers, empty states
     • Tab renderers          — one pure function per tab
     • Dialogs                — article / staff / assignment editors
     • Shell mount+unmount    — openAdmin() / closeAdmin() / refreshAdmin()
     • Delegated handlers     — one click listener driving `data-action`

   Every write goes through src/lib/store.js, which persists to Supabase when
   configured and to localStorage otherwise. Nothing here mutates state
   directly; the store's subscribe() callback repaints the active tab.
   ========================================================================== */

import * as store from '../lib/store.js';
import {
  signOut,
  isAdmin,
  isOwner,
  roleAtLeast,
  currentRole,
  listAccounts,
  approveAccount,
  rejectAccount,
  setAccountRole,
  setAccountPassword
} from '../lib/auth.js';
import { getReleases, pendingCount, sectionIcon } from '../lib/changelog.js';
import { config, describeBackend } from '../lib/config.js';
import {
  sendBroadcastToDevices,
  ensureAlertPermission
} from './alerts.js';
import * as push from '../lib/push.js';
import { uploadImage, uploadImages, bindImagePicker } from '../lib/upload.js';
import { squareUpImage } from '../lib/portrait.js';
import { MAX_ARTICLE_PHOTOS } from '../lib/store.js';
import {
  // `listCredits` is deliberately NOT imported. The panel reads the whole roster
  // through `listCreditsForOwner()` and filters it per tab; a scoped read here
  // would make rows on the other page unreachable rather than merely hidden.
  listCreditsForOwner,
  addPerson,
  updatePerson,
  removePerson,
  assignPortrait,
  setPortraitStatus,
  resetPortrait,
  primePortraits,
  indexStaffPortraits,
  isCreditsMigrationMissing,
  normaliseColour,
  normaliseScope,
  // rolePalette/paletteVars build the accent wash the role pill is drawn in, so
  // the preview in this panel is the SAME rendering the public page does -- not a
  // second approximation of it that drifts.
  rolePalette,
  paletteVars,
  groupByRole,
  // groupBySubCategory/resolveLead are the SAME functions the public About page
  // groups and picks its lead with, imported rather than reimplemented: a second
  // copy in this panel would drift, and the drift would be invisible — the Owner
  // would arrange one shape and the page would publish another.
  groupBySubCategory,
  resolveLead,
  moveRoleBand,
  ABOUT_CATEGORIES,
  normaliseAboutCategory,
  normaliseSubCategory,
  SUB_CATEGORY_PRESETS
} from '../lib/credits.js';
import {
  escapeHtml,
  safeUrl,
  byId,
  openDialog,
  closeDialog,
  isOpen,
  releaseDialogLocks,
  showToast,
  formatEditionDate,
  imageFallbackAttr,
  captionText
} from '../lib/dom.js';

/** Which article statuses the Content Desk is filtered to. */
let contentFilter = 'all';
// Same idea for the Interviews tab: 'all' | 'pending' | 'published'. Separate from
// contentFilter because the two vocabularies are disjoint -- an interview is
// never 'Pending Review', so sharing one filter would make every row vanish when
// the Owner switched tabs.
let interviewFilter = 'all';
// Ids being edited, and the video rows staged in the editor.
let editingInterviewId = null;
let interviewVideoDraft = [];
/** Which tab is showing. Not persisted — the workspace always opens on Overview. */
let activeTab = 'overview';

/**
 * Which reader view was on screen when the Newsroom Panel was opened. The panel
 * hides all of them; closeAdmin() brings this one back and leaves the rest hidden.
 */
let lastReaderView = 'publication-view';
/** The article loaded into the editor, or null when creating a new one. */
let editingArticleId = null;
/** The staff record loaded into the editor, or null when creating. */
let editingStaffId = null;
/** The pitch loaded into the edit dialog, or null. */
let editingAssignmentId = null;
/** Set while the workspace is mounted, so we only subscribe/unsubscribe once. */
let isMounted = false;
/** Store subscription, torn down by closeAdmin(). */
let unsubscribeStore = null;
/** True once the delegated document listeners have been attached. */
let listenersAttached = false;
/**
 * Two-step guard for the destructive "reset all settings" action. The button
 * only arms the confirmation; nothing is written until the Owner confirms.
 * Always reset to false when the workspace is closed or the tab is left.
 */
let resetArmed = false;

/* -------------------------------------------------------------------------- */
/* Shared render helpers                                                       */
/* -------------------------------------------------------------------------- */

/** Neutral placeholder art for records with no image. */
const BLANK_IMAGE =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 450">' +
      '<rect width="800" height="450" fill="#e7e1d3"/>' +
      '<text x="50%" y="50%" font-family="Georgia,serif" font-size="42" ' +
      'fill="#8c1d11" text-anchor="middle">The Pulse</text></svg>'
  );

/** Fallback art for any record with a missing or unsafe image URL. */
function artFor(url) {
  return safeUrl(url) || BLANK_IMAGE;
}

/** Map a publication / workflow status onto a badge class. */
function statusBadge(status) {
  const map = {
    Published: 'badge-emerald',
    'Pending Review': 'badge-amber',
    Rejected: 'badge-neutral',
    Archived: 'badge-neutral',
    Active: 'badge-emerald',
    Suspended: 'badge-neutral',
    Open: 'badge-sky',
    'In Progress': 'badge-amber',
    Completed: 'badge-emerald',
    Claimed: 'badge-sky'
  };
  return `<span class="badge ${map[status] || 'badge-neutral'}">${escapeHtml(
    status || 'Unknown'
  )}</span>`;
}

/** A section heading with optional action buttons on the right. */
function panelHeader(title, subtitle, actionHtml = '') {
  return `
    <div class="rule-soft flex flex-wrap items-end justify-between gap-3 border-b pb-4">
      <div>
        <h2 class="font-headline text-2xl font-black tracking-wide uppercase">
          ${escapeHtml(title)}
        </h2>
        <p class="ink-muted mt-1 text-xs">${escapeHtml(subtitle)}</p>
      </div>
      <div class="flex flex-wrap gap-2">${actionHtml}</div>
    </div>
  `;
}

/** Empty-state block used by every list. */
function emptyState(message, icon = 'fa-inbox') {
  return `
    <div class="panel-sunken flex flex-col items-center gap-2 px-6 py-12 text-center">
      <i class="fa-solid ${icon} ink-muted text-2xl" aria-hidden="true"></i>
      <p class="ink-muted text-sm">${escapeHtml(message)}</p>
    </div>
  `;
}

/** The "New article" button, reused by several tab headers. */
const NEW_ARTICLE_BUTTON = `
  <button class="btn btn-accent" data-action="article-new">
    <i class="fa-solid fa-plus" aria-hidden="true"></i> New article
  </button>
`;

/* -------------------------------------------------------------------------- */
/* Tab 1 — Overview                                                            */
/* -------------------------------------------------------------------------- */

function renderOverview() {
  const state = store.getState();
  const backend = describeBackend();
  const published = store.listPublishedArticles();
  const pending = store.getPendingQueue();

  const metrics = [
    { label: 'Published dispatches', value: published.length, icon: 'fa-newspaper' },
    { label: 'Awaiting review', value: pending.length, icon: 'fa-hourglass-half' },
    {
      label: 'Open assignments',
      value: state.assignments.filter((a) => a.status !== 'Completed').length,
      icon: 'fa-clipboard-list'
    },
    { label: 'Active subscribers', value: state.notifications.activeSubscriberCount, icon: 'fa-users' }
  ];

  const recentAudit = state.auditLogs.slice(0, 6);

  /*
    TWO OVERVIEW TILES ARE OWNER-ONLY, AND THE LIST IS FILTERED RATHER THAN
    CONDITIONALLY RENDERED.
    `metrics` is a flat list consumed by one `.map()` lower down, so the honest
    fix is to leave the tile out of the list -- filtering afterwards would render
    an empty cell, and a separate `${isOwner() ? ... : ''}` block around the audit
    list is how the two halves drift apart again.

    Active subscribers is a headcount of who receives push, and the audit trail
    records who did what. Neither is a Writer's business, and the brief asks for
    both to go.

    "Awaiting review" is deliberately KEPT for a Writer: it is their own queue,
    counting work they filed, and hiding it would leave them with no indication
    that something is waiting. It shows a count only -- never whose.
  */
  const isOwnerView = isOwner();
  const ownerOnlyMetrics = isOwnerView
    ? metrics
    : metrics.filter((m) => m.label !== 'Active subscribers');

  /*
    THE REVIEW QUEUE IS THE APPROVER TIER, NOT A READ-ONLY LIST.
    A Writer gets neither the section nor a placeholder, for the same reason the
    audit trail is Owner-only: an empty "Review queue" heading reads as "nothing
    is waiting", which is a FALSE statement about other people's work. It rendered
    for everyone here, complete with a LIVE `article-publish` button, so a Writer
    was handed the one control the brief reserves for the Owner and a Board
    Manager.

    It is gated on `canApprove()` rather than `isOwner()` because migration 030
    made a Board Manager an approver and this list is where an approver works.
    The rendering of the queue is a convenience; `articles_publish_guard` and
    `public.can_approve()` in migration 033 are the enforcement, and this button
    was never the thing standing between a Writer and the front page.

    Note the asymmetry with the "Awaiting review" TILE above, which a Writer keeps:
    the tile counts their own filings and shows no names, and the list names other
    people and offers to publish them. Keeping one and gating the other is
    deliberate, not an oversight.
  */
  const canReview = store.canApprove();

  return `
    <div class="space-y-6">
      ${panelHeader('Newsroom overview', `Backend: ${backend.label}`,
        `<button class="btn btn-ghost" data-action="refresh">
           <i class="fa-solid fa-rotate" aria-hidden="true"></i> Refresh
         </button>`)}

      <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        ${ownerOnlyMetrics
          .map(
            (metric) => `
          <div class="panel-raised p-4">
            <div class="flex items-center justify-between">
              <span class="ink-muted text-[0.65rem] font-bold tracking-[0.12em] uppercase">
                ${escapeHtml(metric.label)}
              </span>
              <i class="fa-solid ${metric.icon} ink-muted" aria-hidden="true"></i>
            </div>
            <p class="font-headline mt-2 text-3xl font-black">${escapeHtml(
              String(metric.value)
            )}</p>
          </div>`
          )
          .join('')}
      </div>

      <div class="panel-raised p-4">
        <div class="flex flex-wrap items-center gap-2">
          <span class="badge ${config.demoMode ? 'badge-amber' : 'badge-emerald'}">
            <i class="fa-solid fa-database" aria-hidden="true"></i>
            ${escapeHtml(backend.label)}
          </span>
          <p class="ink-muted flex-1 text-xs">${escapeHtml(backend.detail)}</p>
        </div>
      </div>

      ${
        /*
          THE WHOLE TWO-COLUMN GRID IS OMITTED FOR A WRITER, not just its two
          sections. Both are gated above -- the queue on `canReview`, the audit
          trail on `isOwnerView` -- and a Writer fails both, which left an empty
          `grid gap-6 lg:grid-cols-2` element in the document contributing
          nothing but a phantom row of space. Gating each child was necessary and
          is not sufficient; the container is gated too.
        */
        canReview || isOwnerView
          ? `<div class="grid gap-6 lg:grid-cols-2">
        ${
          canReview
            ? `<section>
          <h3 class="font-headline text-lg font-black tracking-wide uppercase">
            Review queue
          </h3>
          <div class="mt-3 space-y-2">
            ${
              pending.length
                ? pending
                    .slice(0, 5)
                    .map(
                      (article) => `
              <div class="panel-sunken flex items-center gap-3 p-3">
                <div class="min-w-0 flex-1">
                  <p class="truncate text-sm font-semibold">${escapeHtml(article.title)}</p>
                  <p class="ink-muted text-[0.7rem]">
                    ${escapeHtml(article.author)} • ${escapeHtml(article.date)}
                  </p>
                </div>
                <button class="btn btn-ghost" data-action="article-publish"
                  data-id="${escapeHtml(article.id)}">Approve</button>
              </div>`
                    )
                    .join('')
                : emptyState('Nothing is waiting for review.', 'fa-circle-check')
            }
          </div>
        </section>`
            : ''
        }

        ${
          /*
            THE AUDIT TRAIL IS OWNER-ONLY.
            It records who did what, across every tab, including the roster and the
            roster's photos. A Writer gets neither the section nor a placeholder:
            an empty "Audit trail" heading reads as "nothing happened", which is a
            false statement rather than an absence of information.
          */
          isOwnerView
            ? `<section>
          <h3 class="font-headline text-lg font-black tracking-wide uppercase">
            Audit trail
          </h3>
          <div class="panel-sunken mt-3 divide-y rule-soft">
            ${
              recentAudit.length
                ? recentAudit
                    .map(
                      (entry) => `
              <div class="p-3">
                <p class="text-xs font-semibold">${escapeHtml(entry.action)}</p>
                <p class="ink-muted text-[0.7rem]">
                  ${escapeHtml(entry.user)} • ${escapeHtml(entry.time)}
                </p>
              </div>`
                    )
                    .join('')
: `<p class="p-4 text-xs ink-muted">No administrative activity recorded yet.</p>`
              }
            </div>
          </section>`
              : ''
        }
    </div>`
          : ''
      }
    `;
  }

/* -------------------------------------------------------------------------- */
/* Tab 2 — Content Desk                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The ids of the front-page layout as the Owner currently sees it, and whether
 * it differs from what is saved.
 *
 * Module state rather than a DOM read, because the panel is re-rendered from the
 * store on every unrelated change and a drag in progress must survive that. The
 * saved baseline is captured when the list is first built so "Save" knows whether
 * there is anything to write.
 */
let layoutDraft = null;
let layoutSaved = '';

/** The order the Owner is looking at, falling back to the store's own order. */
function currentLayoutOrder() {
  if (layoutDraft) return layoutDraft;
  return store.listPublishedArticles().map((article) => article.id);
}

function layoutIsDirty() {
  const order = currentLayoutOrder();
  return order.join('|') !== layoutSaved;
}

/**
 * "Latest Coverage" ordering, with drag-to-reorder and arrow buttons.
 *
 * WHY POINTER EVENTS AND NOT A LIBRARY
 * ------------------------------------
 * The brief named @hello-pangea/dnd or dnd-kit. Both are React; this panel is
 * vanilla template strings, so either would mean adding React to render a list
 * that is already rendered, or reaching for the vanilla build and hand-writing
 * the accessibility layer anyway. Pointer Events give the same result in about
 * forty lines and no dependency, and `touch-action: none` on the handle is the
 * whole trick for stopping the page scrolling under a drag.
 *
 * THE ARROWS ARE NOT A FALLBACK, THEY ARE THE PRIMARY CONTROL
 * -----------------------------------------------------------
 * A one-step move is the common case -- "swap these two" -- and on a phone a
 * drag for it is slow and easy to get wrong. The arrows are always present, not
 * hidden behind a hover, because there is no hover on the device most of this
 * will be used on.
 */
function contentLayoutPanel() {
  const published = store.listPublishedArticles();
  if (!published.length) return '';

  /*
    THE FRONT PAGE ORDER IS THE OWNER'S, AND THE PANEL NOW SAYS SO.
    ------------------------------------------------------------------
    This panel rendered for every Writer: live drag handles, live arrows and a
    live Save button. `wire_set_article_layout` is Owner-only on the server, so
    every one of those controls was a dead end that cost a Writer a click to
    discover they did not have the permission -- and before migration 033 the
    `articles_approver_update` policy plus a table-wide UPDATE grant meant a
    Board Manager could set `display_order` directly, bypassing the RPC entirely.

    Return NOTHING rather than a disabled panel. The Content tab is `minRole:
    'Writer'`, so this is the tab a Writer spends their time in; an inert
    reorder list in it is a control that invites a mistake, and "the front page
    order" is not a thing a Writer is being asked about.

    The enforcement is `wire_set_article_layout`'s `is_owner()` check plus
    `wire_approver_scope_guard` in migration 033. This is the same shape as the
    Audit trail: hiding it keeps the panel honest, the database keeps it true.
  */
  if (!isOwner()) return '';

  const byId = new Map(published.map((article) => [article.id, article]));
  const order = currentLayoutOrder().filter((id) => byId.has(id));
  // Anything published that is not in the draft still belongs on the page: a row
  // published in another tab must not silently vanish from the ordering UI.
  for (const article of published) {
    if (!order.includes(article.id)) order.push(article.id);
  }

  layoutSaved = store.listPublishedArticles().map((article) => article.id).join('|');

  const dirty = layoutIsDirty();

  return `
    <section class="layout-panel" aria-labelledby="layout-heading">
      <div class="layout-panel__head">
        <div>
          <h2 id="layout-heading" class="text-sm font-black tracking-tight">
            Latest Coverage order
          </h2>
          <p class="ink-muted mt-1 text-xs">
            Drag a card by its handle, or use the arrows, to choose the order the
            front page runs in. Stories you have not placed keep their
            newest-first order below yours.
          </p>
        </div>
        <button
          type="button"
          class="btn btn-accent shrink-0"
          data-action="layout-save"
          ${dirty ? '' : 'disabled'}
        >
          <i class="fa-solid fa-floppy-disk" aria-hidden="true"></i> Save Layout Order
        </button>
      </div>

      <ol class="layout-list" data-layout-list>
        ${order
          .map((id, index) => layoutRow(byId.get(id), index, order.length))
          .join('')}
      </ol>

      ${
        dirty
          ? ''
          : `<p class="layout-panel__saved">
               <i class="fa-solid fa-circle-check ink-muted" aria-hidden="true"></i>
               Saved. The front page is running this order.
             </p>`
      }
    </section>
  `;
}

function layoutRow(article, index, total) {
  const id = escapeHtml(article.id || '');
  const placed = Number.isFinite(article.displayOrder);

  return `
    <li class="layout-row" data-layout-id="${id}">
      <button
        type="button"
        class="layout-row__handle"
        data-layout-handle
        aria-label="Drag to reorder ${escapeHtml(article.title || 'this story')}"
        title="Drag to reorder"
      >
        <i class="fa-solid fa-grip-vertical" aria-hidden="true"></i>
      </button>

      <span class="layout-row__rank" aria-hidden="true">${index + 1}</span>

      <div class="layout-row__body">
        <p class="layout-row__title">${escapeHtml(article.title || 'Untitled')}</p>
        <p class="layout-row__meta">
          ${escapeHtml(article.author || 'The Pulse Staff')} &#8226;
          ${escapeHtml(article.date || '')}
          ${placed ? '' : ' &#8226; <span class="ink-muted">not placed yet</span>'}
        </p>
      </div>

      <div class="layout-row__moves">
        <button type="button" class="btn btn-quiet" data-action="layout-up"
          data-id="${id}" ${index === 0 ? 'disabled' : ''}
          aria-label="Move ${escapeHtml(article.title || 'this story')} up">
          <i class="fa-solid fa-arrow-up" aria-hidden="true"></i>
        </button>
        <button type="button" class="btn btn-quiet" data-action="layout-down"
          data-id="${id}" ${index === total - 1 ? 'disabled' : ''}
          aria-label="Move ${escapeHtml(article.title || 'this story')} down">
          <i class="fa-solid fa-arrow-down" aria-hidden="true"></i>
        </button>
      </div>
    </li>
  `;
}

/** Move one row by `delta`, then repaint. Purely local until Save is pressed. */
function nudgeLayout(id, delta) {
  const order = [...currentLayoutOrder()];
  const from = order.indexOf(id);
  if (from === -1) return;
  const to = from + delta;
  if (to < 0 || to >= order.length) return;

  order.splice(to, 0, ...order.splice(from, 1));
  layoutDraft = order;
  paintActiveTab();
}

/**
 * Pointer-driven reordering for the layout list.
 *
 * Bound once per render of the list, on the list itself rather than per row, so
 * a repaint mid-drag cannot leave a handler attached to a detached node.
 */
function wireLayoutDrag() {
  const list = document.querySelector('[data-layout-list]');
  if (!list || list.dataset.dragBound === '1') return;
  list.dataset.dragBound = '1';

  let dragging = null;

  const rowAt = (clientY) => {
    const rows = [...list.querySelectorAll('[data-layout-id]')];
    return rows.find((row) => {
      const box = row.getBoundingClientRect();
      return clientY >= box.top && clientY <= box.bottom;
    });
  };

  list.addEventListener('pointerdown', (event) => {
    const handle = event.target.closest('[data-layout-handle]');
    if (!handle) return;

    const row = handle.closest('[data-layout-id]');
    if (!row) return;

    dragging = row;
    row.classList.add('layout-row--dragging');
    // Capture on the list so the pointer keeps sending moves after it leaves the
    // handle, and so a pointerup outside any row still ends the drag.
    list.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  });

  list.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    const over = rowAt(event.clientY);
    if (!over || over === dragging) return;

    // Insert before or after depending on which half of the target the pointer
    // is in, so the row follows the finger rather than jumping on contact.
    const box = over.getBoundingClientRect();
    const after = event.clientY > box.top + box.height / 2;
    over.parentNode.insertBefore(dragging, after ? over.nextSibling : over);
  });

  const endDrag = () => {
    if (!dragging) return;
    dragging.classList.remove('layout-row--dragging');
    dragging = null;
    // The DOM order IS the draft now, so read it back rather than trying to
    // track every move -- and repaint so the rank numbers and the arrow states
    // agree with what the pointer just did.
    layoutDraft = [...list.querySelectorAll('[data-layout-id]')].map(
      (row) => row.dataset.layoutId
    );
    paintActiveTab();
  };

  list.addEventListener('pointerup', endDrag);
  list.addEventListener('pointercancel', endDrag);
}

function renderContent() {
  const all = store.listArticles();
  const filtered =
    contentFilter === 'all'
      ? all
      : all.filter(
          (article) =>
            String(article.status || '').toLowerCase() ===
            String(contentFilter || '').toLowerCase()
        );

  const filters = ['all', ...store.ARTICLE_STATUSES];

  return `
    <div class="space-y-5">
    ${panelHeader(
      'Content desk',
      `${all.length} record${all.length === 1 ? '' : 's'} in the publication archive`,
      `<div class="flex flex-wrap gap-2">
         <button class="btn btn-ghost" data-action="podcast-new">
           <i class="fa-solid fa-microphone-lines" aria-hidden="true"></i> Submit a podcast
         </button>
         ${NEW_ARTICLE_BUTTON}
       </div>`
    )}

      <div class="flex flex-wrap gap-2" role="group" aria-label="Filter articles by status">
        ${filters
          .map(
            (filter) => `
          <button
            class="btn ${contentFilter === filter ? 'btn-accent' : 'btn-ghost'}"
            data-action="content-filter"
            data-filter="${escapeHtml(filter)}"
            aria-pressed="${contentFilter === filter}"
          >
            ${escapeHtml(filter === 'all' ? 'All' : filter)}
          </button>`
          )
          .join('')}
      </div>

      ${contentLayoutPanel()}

      ${
        filtered.length
          ? `<div class="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        ${filtered
          .map(
            (article) => `
          <article class="panel-raised flex flex-col overflow-hidden">
            <img
              class="h-36 w-full object-cover"
              src="${escapeHtml(artFor(article.image))}"
              ${imageFallbackAttr(BLANK_IMAGE)}
              alt="${escapeHtml(article.caption || article.title)}"
              loading="lazy"
            />
            <div class="flex flex-1 flex-col gap-2 p-4">
              <div class="flex items-center gap-2">
                ${statusBadge(article.status)}
                ${article.featured ? '<span class="badge badge-gold">Lead</span>' : ''}
              </div>
              <h3 class="font-headline text-base leading-snug font-bold">
                ${escapeHtml(article.title)}
              </h3>
              <p class="ink-muted text-[0.7rem]">
                ${escapeHtml(article.author)} • ${escapeHtml(article.category)}
              </p>
              <div class="mt-auto flex flex-wrap gap-2 pt-3">
                ${
                  store.canEditArticle(article)
                    ? `<button class="btn btn-ghost" data-action="article-edit"
                        data-id="${escapeHtml(article.id)}">
                        <i class="fa-solid fa-pen" aria-hidden="true"></i> Edit
                      </button>`
                    : // A Writer sees no Edit on somebody else's byline. The RLS
                      // policy in supabase/007 already refuses the save; hiding the
                      // affordance just stops them reaching a permission error.
                      `<button class="btn btn-ghost" disabled
                        title="You can only edit your own articles.">
                        <i class="fa-solid fa-pen" aria-hidden="true"></i> Edit
                      </button>`
                }
                ${
                  /*
                    APPROVE / UNPUBLISH IS THE APPROVER TIER, NOT AN EDIT.
                    canApprove() is Owner-or-Active-Board-Manager, matching
                    public.can_approve() in migration 030. A Writer gets neither
                    button on anything -- not even on their own article, because
                    the brief makes the approve decision an Owner/BM one, and an
                    author approving their own work is the thing the pending status
                    exists to prevent.
                  */
                  store.canApprove()
                    ? String(article.status || '').toLowerCase() === 'pending review'
                      ? `<button class="btn btn-ghost" data-action="article-publish"
                          data-id="${escapeHtml(article.id)}">Approve</button>`
                      : `<button class="btn btn-ghost" data-action="article-reject"
                          data-id="${escapeHtml(article.id)}">Unpublish</button>`
                    : `<button class="btn btn-ghost" disabled
                        title="Only the Owner or a Board Manager can approve or unpublish.">
                        ${String(article.status || '').toLowerCase() === 'pending review'
                          ? 'Approve'
                          : 'Unpublish'}
                      </button>`
                }
                ${
                  // A writer may delete only their own articles; the Owner may
                  // delete any. Enforced for real by the RLS policy in
                  // supabase/007_article_ownership.sql -- this only keeps the
                  // button honest so nobody clicks through to a database error.
                  store.canDeleteArticle(article)
                    ? `<button class="btn btn-quiet" data-action="article-delete"
                  data-id="${escapeHtml(article.id)}"
                  data-title="${escapeHtml(article.title)}">
                  <i class="fa-solid fa-trash" aria-hidden="true"></i>
                  <span class="sr-only">Delete</span>`
                    : `<button class="btn btn-quiet" disabled
                  title="You can only delete your own articles.">
                  <i class="fa-solid fa-trash" aria-hidden="true"></i>
                  <span class="sr-only">Delete</span>`
                }
                </button>
              </div>
            </div>
          </article>`
          )
          .join('')}
      </div>`
          : emptyState('No articles match this filter.', 'fa-newspaper')
      }
    </div>
  `;
}

/* -------------------------------------------------------------------------- */
/* Tab 2b -- Interviews Desk                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The Owner/Writer management tab for interviews.
 *
 * Deliberately a separate tab from Content rather than a second filter on it:
 * an interview is a recording of a named person on the record, so it carries a
 * guest and up to three video embeds, and the approve/publish decision applies
 * to a different thing. Mixing the two vocabularies into one list is how you get
 * a filter that hides everything.
 */
function renderInterviewsTab() {
  const all = store.listInterviews();
  const pending = store.getPendingInterviews();
  const filtered =
    interviewFilter === 'all'
      ? all
      : all.filter((item) =>
          String(item.status || '').toLowerCase() ===
          String(interviewFilter).toLowerCase()
        );

  const filters = ['all', ...store.INTERVIEW_STATUSES];

  return `
    <div class="space-y-5">
    ${panelHeader(
      'Interviews desk',
      `${all.length} interview${all.length === 1 ? '' : 's'} on file - ${
        pending.length
      } awaiting approval`,
      `<button class="btn btn-accent" data-action="interview-new">
         <i class="fa-solid fa-plus" aria-hidden="true"></i> New interview
       </button>`
    )}

      <div class="flex flex-wrap gap-2" role="group" aria-label="Filter interviews by status">
        ${filters
          .map(
            (filter) => `
          <button
            class="btn ${interviewFilter === filter ? 'btn-accent' : 'btn-ghost'}"
            data-action="interview-filter"
            data-filter="${escapeHtml(filter)}"
            aria-pressed="${interviewFilter === filter}"
          >
            ${escapeHtml(filter === 'all' ? 'All' : filter)}
          </button>`
          )
          .join('')}
      </div>

      ${
        filtered.length
          ? `<div class="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        ${filtered.map(interviewAdminCard).join('')}
      </div>`
          : emptyState('No interviews match this filter.', 'fa-circle-play')
      }
    </div>
  `;
}

/**
 * One interview row in the management grid.
 *
 * The video count is shown from the stored ids rather than a separate counter so
 * it cannot disagree with what the public detail view will actually embed.
 */
function interviewAdminCard(interview) {
  const videos = store.readVideoIds(interview.videoIds);
  const isPublished =
    String(interview.status || '').toLowerCase() === 'published';

  return `
    <article class="panel-raised flex flex-col overflow-hidden">
      <img
        class="h-32 w-full object-cover"
        src="${escapeHtml(artFor(interview.image))}"
        ${imageFallbackAttr(BLANK_IMAGE)}
        alt="${escapeHtml(interview.title || interview.guest || '')}"
        loading="lazy"
      />
      <div class="flex flex-1 flex-col gap-2 p-4">
        <div class="flex items-center gap-2">
          ${statusBadge(isPublished ? 'Published' : 'Pending Review')}
          ${videos.length ? `<span class="badge badge-neutral">${videos.length} video${videos.length === 1 ? '' : 's'}</span>` : ''}
        </div>
        <h3 class="font-headline text-base leading-snug font-bold">
          ${escapeHtml(interview.guest || 'Unnamed guest')}
        </h3>
        <p class="ink-muted text-[0.7rem]">
          ${escapeHtml(interview.title || '')}
          ${interview.interviewer ? ` - by ${escapeHtml(interview.interviewer)}` : ''}
        </p>
        <div class="mt-auto flex flex-wrap gap-2 pt-3">
          ${
            store.canEditInterview(interview)
              ? `<button class="btn btn-ghost" data-action="interview-edit"
                  data-id="${escapeHtml(interview.id)}">
                  <i class="fa-solid fa-pen" aria-hidden="true"></i> Edit
                </button>`
              : `<button class="btn btn-ghost" disabled
                  title="You can only edit interviews you filed.">
                  <i class="fa-solid fa-pen" aria-hidden="true"></i> Edit
                </button>`
          }
          ${
            // The approver tier, as on the article grid: Owner or Active Board
            // Manager only, per public.can_approve() in migration 030.
            store.canApprove()
              ? isPublished
                ? `<button class="btn btn-ghost" data-action="interview-unpublish"
                    data-id="${escapeHtml(interview.id)}">Unpublish</button>`
                : `<button class="btn btn-ghost" data-action="interview-publish"
                    data-id="${escapeHtml(interview.id)}">Approve</button>`
              : `<button class="btn btn-ghost" disabled
                  title="Only the Owner or a Board Manager can approve or unpublish.">
                  ${isPublished ? 'Unpublish' : 'Approve'}
                </button>`
          }
          ${
            // Mirrors the article grid: the RLS policy plus
            // wire_owns_interview() is the real enforcement, this only keeps the
            // button honest.
            store.canDeleteInterview(interview)
              ? `<button class="btn btn-quiet" data-action="interview-delete"
                  data-id="${escapeHtml(interview.id)}"
                  data-title="${escapeHtml(interview.guest || interview.title || '')}">
                   <i class="fa-solid fa-trash" aria-hidden="true"></i>
                   <span class="sr-only">Delete</span>
                 </button>`
              : `<button class="btn btn-quiet" disabled
                  title="You can only delete your own interviews.">
                   <i class="fa-solid fa-trash" aria-hidden="true"></i>
                   <span class="sr-only">Delete</span>
                 </button>`
          }
        </div>
      </div>
    </article>
  `;
}

/* -------------------------------------------------------------------------- */
/* Tab 3 — Assignments                                                         */
/* -------------------------------------------------------------------------- */

export const ASSIGNMENT_STATUSES = ['Open', 'In Progress', 'Completed', 'Claimed'];

function renderAssignmentsTab() {
  const assignments = store.listAssignments();

  return `
    <div class="space-y-5">
      ${panelHeader(
        'Assignment board',
        'Commission, track and close out newsroom work',
        `<button class="btn btn-accent" data-action="assignment-new">
           <i class="fa-solid fa-plus" aria-hidden="true"></i> New assignment
         </button>`
      )}

      ${
        assignments.length
          ? `<div class="panel-raised overflow-x-auto">
        <table class="w-full text-left text-sm">
          <thead class="rule-soft border-b">
            <tr class="ink-muted text-[0.65rem] tracking-[0.12em] uppercase">
              <th scope="col" class="px-4 py-3">Assignment</th>
              <th scope="col" class="px-4 py-3">Reporter</th>
              <th scope="col" class="px-4 py-3">Status</th>
              <th scope="col" class="px-4 py-3">Deadline</th>
              <th scope="col" class="px-4 py-3"><span class="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody class="divide-y rule-soft">
            ${assignments
              .map(
                (item) => `
              <tr>
                <td class="px-4 py-3 font-semibold">${escapeHtml(item.title)}</td>
                <td class="ink-muted px-4 py-3">${escapeHtml(item.reporter || '—')}</td>
                <td class="px-4 py-3">${statusBadge(item.status)}</td>
                <td class="ink-muted px-4 py-3">${escapeHtml(item.deadline || '—')}</td>
                <td class="px-4 py-3">
                  <div class="flex justify-end gap-1">
                    <button class="btn btn-quiet" data-action="assignment-edit"
                      data-id="${escapeHtml(item.id)}" aria-label="Edit assignment">
                      <i class="fa-solid fa-pen" aria-hidden="true"></i>
                    </button>
                    <button class="btn btn-quiet" data-action="assignment-delete"
                      data-id="${escapeHtml(item.id)}"
                      data-title="${escapeHtml(item.title)}" aria-label="Delete assignment">
                      <i class="fa-solid fa-trash" aria-hidden="true"></i>
                    </button>
                  </div>
                </td>
              </tr>`
              )
              .join('')}
          </tbody>
        </table>
      </div>`
          : emptyState('No assignments have been commissioned yet.', 'fa-clipboard-list')
      }
    `;
}

/* -------------------------------------------------------------------------- */
/* Tab 4 — Banner                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Resolve the stored banner colour to the `#rrggbb` an `<input type="color">`
 * will actually accept.
 *
 * A colour input silently renders black and rewrites the field to #000000 the
 * moment it is given anything else, so the raw stored value cannot be used as
 * its `value`. Three things need normalising:
 *   - the legacy named palette ('Red' / 'Gold' / 'Blue') still in seeded rows,
 *     which is what the seeded banner actually holds;
 *   - shorthand hex (#abc), which no picker will render;
 *   - anything malformed, which must fall back rather than blank the input.
 *
 * The named values mirror the CSS custom properties used by public.js, so the
 * swatch a reader sees matches the one the Owner picked.
 */
function bannerSwatch(color) {
  const raw = String(color || '').trim();

  if (/^#[0-9a-f]{6}$/i.test(raw)) return raw;
  if (/^#[0-9a-f]{3}$/i.test(raw)) {
    return `#${raw[1]}${raw[1]}${raw[2]}${raw[2]}${raw[3]}${raw[3]}`;
  }

  switch (raw.toLowerCase()) {
    case 'gold':
    case 'newsgold':
      return '#b8860b'; // --color-newsgold
    case 'blue':
    case 'newsblue':
      return '#1c3f60'; // --color-newsblue
    default:
      return '#8c1d11'; // --color-newsred
  }
}

function renderBreakingTab() {
  const breaking = store.getState().breakingNews;

  return `
    <div class="space-y-5">
      ${panelHeader('Banner', 'The real-time alert strip that runs above the masthead')}

      <form id="breaking-form" class="panel-raised space-y-4 p-5" novalidate>
        <div class="flex flex-wrap items-center gap-4">
          <label class="switch" for="breaking-enabled">
            <input id="breaking-enabled" type="checkbox" ${
              breaking.enabled ? 'checked' : ''
            } />
            <span class="switch-track"></span>
            <span class="switch-thumb"></span>
          </label>
          <label class="field-label mb-0" for="breaking-enabled">
            Banner is live on the public site
          </label>
        </div>

        <p class="ink-muted text-xs">
          Readers see three things only: the severity, the headline and the
          supporting line.
        </p>

        <div class="grid gap-4 sm:grid-cols-2">
          <div>
            <label class="field-label" for="breaking-severity">Severity</label>
            <input id="breaking-severity" class="field" type="text"
              list="breaking-severity-presets" maxlength="24"
              placeholder="Breaking"
              value="${escapeHtml(breaking.severity || 'Breaking')}" />
            <datalist id="breaking-severity-presets">
              ${['Breaking', 'Developing', 'Advisory', 'Urgent', 'Update']
                .map((option) => `<option value="${option}"></option>`)
                .join('')}
            </datalist>
            <p class="ink-muted mt-1 text-xs">
              Any wording you like. Suggested values are offered as you type.
            </p>
          </div>
          <div>
            <label class="field-label" for="breaking-color">Colour</label>
            <div class="flex items-center gap-2">
              <input id="breaking-color-picker" type="color"
                class="h-10 w-12 shrink-0 cursor-pointer rounded border border-black/20 bg-transparent p-1"
                value="${escapeHtml(bannerSwatch(breaking.color))}"
                aria-label="Pick a banner colour" />
              <input id="breaking-color" class="field" type="text"
                placeholder="#8C1D11"
                value="${escapeHtml(breaking.color || '')}" />
            </div>
            <p class="ink-muted mt-1 text-xs">
              Pick a swatch or type any hex colour, e.g. #8C1D11.
            </p>
          </div>
        </div>

        <div>
          <label class="field-label" for="breaking-headline">Headline</label>
          <input id="breaking-headline" class="field" type="text"
            value="${escapeHtml(breaking.headline)}" />
        </div>

        <div>
          <label class="field-label" for="breaking-subtext">Supporting line</label>
          <input id="breaking-subtext" class="field" type="text"
            value="${escapeHtml(breaking.subtext)}" />
        </div>

        <div class="flex justify-end gap-2">
          <button type="button" class="btn btn-ghost" data-action="breaking-off">
            <i class="fa-solid fa-eye-slash" aria-hidden="true"></i> Hide banner
          </button>
          <button type="submit" class="btn btn-accent">
            <i class="fa-solid fa-bullhorn" aria-hidden="true"></i> Save banner
          </button>
        </div>
      </form>

      <p class="ink-muted text-xs">
        The banner renders above the masthead on the public site the moment you
        save with “Banner is live” switched on.
      </p>
    </div>
  `;
}

/* -------------------------------------------------------------------------- */
/* Tab 5 — Broadcasts                                                          */
/* -------------------------------------------------------------------------- */

function renderBroadcastsTab() {
  const notifications = store.getState().notifications;
  const history = store.listBroadcasts();

  return `
    <div class="space-y-5">
      ${panelHeader(
        'Broadcast centre',
        notifications.activeSubscriberCount
          ? `${notifications.activeSubscriberCount} device${notifications.activeSubscriberCount === 1 ? '' : 's'} recorded as opted in`
          : 'No devices have opted in to alerts yet'
      )}

      <form id="broadcast-form" class="panel-raised space-y-4 p-5" novalidate>
        <p class="panel-sunken flex items-start gap-2 p-3 text-[0.7rem] leading-relaxed ink-muted">
          <i class="fa-solid fa-circle-info mt-0.5 shrink-0" aria-hidden="true"></i>
          <span>
            <strong class="text-[0.7rem]">Sent as a real push notification.</strong>
            This goes out through Web Push, so it reaches opted-in devices even when
            The Pulse is closed. Open devices also pick it up on their next refresh,
            which covers anyone whose browser cannot take a push.
          </span>
        </p>

        <div>
          <label class="field-label" for="broadcast-title">Subject</label>
          <input id="broadcast-title" class="field" type="text" required
            placeholder="Council approves new water allocation" />
        </div>
        <div>
          <label class="field-label" for="broadcast-message">Message</label>
          <textarea id="broadcast-message" class="field min-h-24" rows="4"
            placeholder="One or two sentences your readers should see immediately."></textarea>
        </div>
        <div class="grid gap-4 sm:grid-cols-2">
          <div>
            <label class="field-label" for="broadcast-audience">Audience</label>
            <select id="broadcast-audience" class="field">
              ${['Everyone', 'Writers', 'Assignment Managers', 'Specific User']
                .map((option) => `<option value="${option}">${option}</option>`)
                .join('')}
            </select>
          </div>
          <div class="flex items-end">
            <button type="submit" class="btn btn-accent w-full">
              <i class="fa-solid fa-paper-plane" aria-hidden="true"></i>
              Send broadcast
            </button>
          </div>
        </div>

        <!-- Shown only while "Specific User" is selected. -->
        <div id="broadcast-target-wrap" class="hidden">
          <label class="field-label" for="broadcast-target">Send to</label>
          <input
            id="broadcast-target"
            class="field"
            type="text"
            autocomplete="off"
            placeholder="Start typing a name…"
            aria-describedby="broadcast-target-help"
          />
          <p id="broadcast-target-help" class="ink-muted mt-1 text-xs">
            Only the devices belonging to the person you pick will receive this.
          </p>
          <div
            id="broadcast-target-results"
            class="mt-2 max-h-56 overflow-y-auto rounded border border-line"
            role="listbox"
            aria-label="Staff members"
          ></div>
          <input id="broadcast-target-id" type="hidden" />
          <p id="broadcast-target-chosen" class="ink-muted mt-2 text-xs"></p>
        </div>
      </form>

      <section>
        <h3 class="font-headline text-lg font-black tracking-wide uppercase">
          Delivery history
        </h3>
        <div class="mt-3 space-y-2">
          ${
            history.length
              ? history
                  .map(
                    (item) => `
            <div class="panel-raised flex flex-wrap items-center gap-3 p-4">
              <div class="min-w-0 flex-1">
                <p class="text-sm font-semibold">${escapeHtml(item.title)}</p>
                <p class="ink-muted text-xs">${escapeHtml(item.message)}</p>
                <p class="ink-muted mt-1 text-[0.7rem]">
                  ${escapeHtml(item.audience)} • ${escapeHtml(item.time)} •
                  ${escapeHtml(String(item.delivered))} delivered
                </p>
              </div>
              <button class="btn btn-quiet" data-action="broadcast-delete"
                data-id="${escapeHtml(item.id)}" aria-label="Delete broadcast">
                <i class="fa-solid fa-trash" aria-hidden="true"></i>
              </button>
            </div>`
                  )
                  .join('')
              : emptyState('No broadcasts have been sent yet.', 'fa-bullhorn')
          }
        </div>
      </section>
    </div>
  `;
}

/* -------------------------------------------------------------------------- */
/* Tab 6 — Curation                                                            */
/* -------------------------------------------------------------------------- */

function renderCurationTab() {
  const state = store.getState();
  const published = store.listPublishedArticles();
  /*
   * The `<option>` list for ONE slot, with the article the store has saved for
   * that slot marked `selected`.
   *
   * The mark matters twice over: without it every select reset to the FIRST
   * published story on each repaint, so the form never showed what was actually
   * saved — and a Save then overwrote the real pick with whatever the dropdown
   * happened to be displaying.
   */
  const optionsFor = (savedId) =>
    published
      .map((article) => {
        const isSelected = savedId != null && article.id === savedId;
        return `<option value="${escapeHtml(article.id)}"${
          isSelected ? ' selected' : ''
        }>${escapeHtml(article.title)}</option>`;
      })
      .join('');

  const slot = (key, label) => `
    <div>
      <label class="field-label" for="slot-${key}">${escapeHtml(label)}</label>
      <select id="slot-${key}" class="field" data-slot="${key}">
        ${optionsFor(state.weeklySlots[key])}
      </select>
    </div>`;

  const performers = state.topPerformers;

  return `
    <div class="space-y-5">
      ${panelHeader(
        'Front-page curation',
        'Choose what leads the edition and the weekly features'
      )}

      <form id="curation-form" class="panel-raised space-y-4 p-5" novalidate>
        <div class="flex flex-wrap items-center gap-4">
          <label class="switch" for="curation-show-week">
            <input id="curation-show-week" type="checkbox" ${
              state.showThisWeek ? 'checked' : ''
            } />
            <span class="switch-track"></span>
            <span class="switch-thumb"></span>
          </label>
          <label class="field-label mb-0" for="curation-show-week">
            Show &quot;This Week in the Wire&quot; on Homepage
          </label>
        </div>

        <p class="ink-muted text-xs">
          Controls the three curated columns beneath Latest Coverage. The cards
          themselves are kept either way, so switching it back on restores them
          exactly as curated.
        </p>

        <div>
          <label class="field-label" for="slot-todays-pick">Today's pick</label>
          <select id="slot-todays-pick" class="field" data-slot="todaysPick">
            ${optionsFor(state.todaysPickId)}
          </select>
        </div>

        <div class="grid gap-4 sm:grid-cols-3">
          ${slot('article', 'Weekly article feature')}
          ${slot('event', 'Weekly event feature')}
          ${slot('picture', 'Weekly picture feature')}
        </div>

        <div class="flex flex-wrap justify-end gap-2">
          <button type="button" class="btn btn-ghost" data-action="reroll-pick">
            <i class="fa-solid fa-shuffle" aria-hidden="true"></i> Reroll pick
          </button>
          <button type="submit" class="btn btn-accent">Save curation</button>
        </div>
      </form>

      <section>
        <h3 class="font-headline text-lg font-black tracking-wide uppercase">
          Top performers
        </h3>
        ${
          performers.length
            ? `<div class="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          ${performers
            .map(
              (person) => `
            <div class="panel-raised p-4">
              <p class="font-headline text-base font-bold">${escapeHtml(person.name)}</p>
              <p class="ink-muted text-xs">${escapeHtml(person.role)}</p>
              <p class="mt-2 text-sm font-semibold">
                ${escapeHtml(String(person.articlesCount))} dispatches
              </p>
            </div>`
            )
            .join('')}
        </div>`
            : emptyState('No performance data has been compiled.', 'fa-chart-simple')
        }
      </section>
    </div>
  `;
}

/* -------------------------------------------------------------------------- */
/* Tab 7 — Staff                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The roles a staffer profile may carry.
 *
 * These MUST match auth.ROLES exactly. This list used to offer five values
 * ('Assignment Manager', 'Staff Writer', 'Contributor') that no CHECK
 * constraint in the database accepts and that normaliseRole() collapsed to
 * Writer anyway. The Owner picked one, the row was written, and the account
 * then carried a role nothing else in the app could rank -- which is the
 * "added a staffer but it does not save" report.
 */
export const STAFF_ROLES = ['Owner', 'Writer', 'Board Manager'];

/**
 * The roster's account-status vocabulary, and the only two values the Staff
 * editor may write. Defined once because two things must agree on it: the
 * <select> in staffEditorDialog() and the save in saveStaffFromForm(). A status
 * the dropdown cannot represent is a status the save must never invent.
 */
export const STAFF_STATUSES = ['Active', 'Suspended'];

/**
 * Fold a stored status onto one the editor's dropdown can represent, or ''.
 *
 * The roster is read straight from Postgres and the column has no CHECK
 * constraint, so a row can carry 'active', 'Active' or nothing at all. A
 * <select> assigned a value that matches none of its <option>s reports '' -- and
 * that empty string then went straight into the save, blanking the status the
 * Owner had set. Anything this function cannot recognise must be left alone by
 * the caller, never written back.
 *
 * @param {unknown} value
 * @returns {string} one of STAFF_STATUSES, or '' when unrecognised
 */
function normaliseStaffStatus(value) {
  const status = String(value || '').trim().toLowerCase();
  return STAFF_STATUSES.find((option) => option.toLowerCase() === status) || '';
}

/**
 * Index the staff roster's approved portraits by name.
 *
 * This is the whole reason it lives here rather than in `primePortraits()`:
 * `primePortraits()` reads `credits_people`, the hand-picked public Credits page,
 * which is not the staff roster. Until this runs, a byline can only be answered
 * from the Credits page, so a staffer who approved a portrait but was never added
 * to that page renders as plain text while somebody who WAS added gets a photo --
 * for the same kind of author. The Staff tab is where the roster lives, so the
 * Staff tab is what indexes it.
 *
 * There is no account lookup here, deliberately. An earlier version joined
 * `staff` to `staff_accounts` on username so it could key portraits by
 * `articles.author_account_id`; that column records who may edit the row, not who
 * wrote it, so keying a FACE by it put the Owner's portrait beside a reporter's
 * byline. The byline name is the only key a portrait should answer to.
 *
 * The roster is hashed into `staffPortraitIndexKey` so the index is rebuilt once
 * per roster change rather than on every repaint of the tab.
 *
 * It mirrors the roster exactly as the store holds it, which is the same limit
 * `primePortraits()` has always had: a portrait decided through the review
 * buttons lands in Postgres and the credits cache is re-read, but the in-memory
 * staff row keeps its old `portrait_status` until the next hydrate. So a freshly
 * approved portrait reaches readers on the next page load.
 */
let staffPortraitIndexKey = '';

function primeStaffPortraits(staff) {
  const key = staff
    .map((member) => `${member.name}|${member.portrait_status}|${member.portrait_url}`)
    .join('\n');
  if (key === staffPortraitIndexKey) return;
  staffPortraitIndexKey = key;

  indexStaffPortraits(
    staff.map((member) => ({
      name: member.name,
      portrait_url: member.portrait_url,
      portrait_status: member.portrait_status
    }))
  );
}

function renderStaffTab() {
  const staff = store.listStaff();

  primeStaffPortraits(staff);

  return `
    <div class="space-y-5">
      ${panelHeader(
        'Staff directory',
        'Roles here are authoritative — they gate the Newsroom Panel',
        `<button class="btn btn-accent" data-action="staff-new">
           <i class="fa-solid fa-user-plus" aria-hidden="true"></i> Add staffer
         </button>`
      )}

      <div class="panel-raised overflow-x-auto">
        <table class="staff-table w-full text-left text-sm">
          <thead class="rule-soft border-b">
            <tr class="ink-muted text-[0.65rem] tracking-[0.12em] uppercase">
              <th scope="col" class="px-4 py-3">Portrait</th>
              <th scope="col" class="px-4 py-3">Name</th>
              <th scope="col" class="px-4 py-3">E-mail</th>
              <th scope="col" class="px-4 py-3">Role</th>
              <th scope="col" class="px-4 py-3">Status</th>
              <th scope="col" class="px-4 py-3"><span class="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody class="divide-y rule-soft">
            ${
              staff.length
                ? staff
                    .map(
                      (member) => `
              <tr>
                <td class="px-4 py-3">
                  ${
                    safeUrl(member.portrait_url)
                      ? `<span class="staff-portrait">
                           <img class="byline-sticker" src="${escapeHtml(
                            safeUrl(member.portrait_url)
                          )}" ${imageFallbackAttr()} alt="" width="48" height="48" loading="lazy" decoding="async" />
                         </span>`
                      : `<span class="staff-portrait">
                           <span class="byline-sticker byline-sticker-empty" aria-hidden="true">
                             <i class="fa-solid fa-user"></i>
                           </span>
                         </span>`
                  }
                </td>
                <td class="px-4 py-3 font-semibold">
                  ${escapeHtml(member.name)}
                  <span class="ink-muted block text-[0.7rem] font-normal">
                    @${escapeHtml(member.username)}
                  </span>
                </td>
                <td class="ink-muted px-4 py-3">${escapeHtml(member.email || '—')}</td>
                <td class="px-4 py-3">${escapeHtml(member.role)}</td>
                <td class="px-4 py-3">${statusBadge(member.status)}</td>
                <td class="px-4 py-3">
                  <div class="flex flex-wrap items-center justify-end gap-2">
                    ${renderPortraitReview(member)}
                    <button class="btn btn-quiet" data-action="staff-edit"
                      data-id="${escapeHtml(member.id)}" aria-label="Edit staffer">
                      <i class="fa-solid fa-pen" aria-hidden="true"></i>
                    </button>
                    <button class="btn btn-quiet" data-action="staff-delete"
                      data-id="${escapeHtml(member.id)}"
                      data-name="${escapeHtml(member.name)}"
                      aria-label="Remove staffer"
                      ${member.role === 'Owner' ? 'disabled' : ''}>
                      <i class="fa-solid fa-trash" aria-hidden="true"></i>
                    </button>
                  </div>
                </td>
              </tr>`
                    )
                    .join('')
                : `<tr><td colspan="6" class="px-4 py-8 text-center">
                     ${emptyState('No staff records yet.', 'fa-users')}
                   </td></tr>`
            }
          </tbody>
        </table>
      </div>

      <p class="ink-muted text-xs">
        <i class="fa-solid fa-circle-info" aria-hidden="true"></i>
        Adding a staffer here creates their newsroom account directly. They sign
        in with their <strong>username</strong> and the password you set in
        Accounts, and their portrait is published with every story they file.
        To feature them on the public Credits page, open the
        <strong>Credits</strong> tab.
      </p>
    </div>
  `;
}


/* -------------------------------------------------------------------------- */
/* Tab 9 — Media Library                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The Owner's portrait decision for one staffer.
 *
 * This is about IDENTITY, not the Credits page: it decides whether this
 * person's photo may appear beside their bylines anywhere on the site. Until
 * it is approved the portrait is invisible to readers, so the staffer sees
 * nothing happen and has no idea what to do next -- hence the explicit
 * "awaiting your review" state rather than a silent photo.
 *
 * Only the Owner may approve, and only the Owner ever sees these controls, so
 * the gate is not merely hidden: it is also enforced by
 * wire_set_portrait_status in 014_portrait_approval.sql.
 *
 * @param {{id: string, name: string, portrait_url?: string,
 *          portrait_status?: string}} member
 * @returns {string} HTML
 */
function renderPortraitReview(member) {
  if (!isOwner()) return '';

  const status = String(member.portrait_status || 'none').toLowerCase();
  const hasPhoto = Boolean(safeUrl(member.portrait_url));

  if (status === 'pending' && hasPhoto) {
    return `
      <div class="flex items-center gap-2">
        <span class="badge badge-amber" title="Uploaded, waiting on you">
          <i class="fa-solid fa-clock" aria-hidden="true"></i> To review
        </span>
        <button class="btn btn-accent" data-action="portrait-approve"
          data-id="${escapeHtml(member.id)}"
          data-name="${escapeHtml(member.name)}"
          aria-label="Approve ${escapeHtml(member.name)}'s portrait">
          <i class="fa-solid fa-check" aria-hidden="true"></i> Approve
        </button>
        <button class="btn btn-quiet" data-action="portrait-reject"
          data-id="${escapeHtml(member.id)}"
          data-name="${escapeHtml(member.name)}"
          aria-label="Reject ${escapeHtml(member.name)}'s portrait">
          <i class="fa-solid fa-xmark" aria-hidden="true"></i>
        </button>
      </div>`;
  }

  if (status === 'approved' && hasPhoto) {
    return `<span class="badge badge-emerald">
              <i class="fa-solid fa-check" aria-hidden="true"></i> Portrait live
            </span>
            ${renderResetButton(member)}`;
  }

  if (status === 'rejected') {
    return `<span class="badge badge-amber" title="Waiting on a new upload">
              <i class="fa-solid fa-rotate" aria-hidden="true"></i> Rejected
            </span>
            ${renderResetButton(member)}`;
  }

  return '';
}

/**
 * The "Reset portrait" button: clear the photo entirely and let the staffer
 * submit a properly cropped replacement.
 *
 * Rendered for a live OR rejected portrait but never for a pending one. A
 * pending upload is already awaiting a decision, so clearing it would destroy
 * the submission the Owner is about to judge for no gain — the Approve and
 * Reject buttons already sit right there and cover that case.
 *
 * Owner only, like the rest of this block. `renderPortraitReview` bails before
 * reaching here for anyone else, and the RPC re-checks is_owner() in Postgres,
 * so the client gate is a convenience rather than the enforcement.
 *
 * @param {{id: string, name: string, portrait_status?: string}} member
 * @returns {string} HTML
 */
function renderResetButton(member) {
  const who = escapeHtml(member.name);
  return `<button class="btn btn-quiet" data-action="portrait-reset"
            data-id="${escapeHtml(member.id)}"
            data-name="${who}"
            title="Delete this photo and let ${who} submit a new one"
            aria-label="Reset ${who}'s portrait">
            <i class="fa-solid fa-eraser" aria-hidden="true"></i> Reset
          </button>`;
}


function renderMediaTab() {
  const media = store.listMedia();
  const categories = store.listGalleryCategories();

  return `
    <div class="space-y-5">
      ${panelHeader(
        'Media library',
        'Shared image shelf used across the publication'
      )}

      <form id="media-form" class="panel-raised grid gap-4 p-5 sm:grid-cols-[2fr_2fr_auto]" novalidate>
        <div>
          <label class="field-label" for="media-file">Images from your device</label>
          <input
            id="media-file"
            class="field"
            type="file"
            multiple
            accept="image/jpeg,image/png,image/webp,image/gif,image/avif"
          />
          <p class="ink-muted mt-1 text-xs">
            Select as many as you like. They are uploaded one at a time.
          </p>
        </div>
        <div>
          <label class="field-label" for="media-url">...or an image URL</label>
          <input id="media-url" class="field" type="text" placeholder="https://…" />
        </div>
        <div>
          <label class="field-label" for="media-caption">Caption</label>
          <input id="media-caption" class="field" type="text" placeholder="Council session, Tuesday" />
          <p class="ink-muted mt-1 text-xs">
            With several images, the caption is used only for the first.
          </p>
        </div>
        <div>
          <label class="field-label" for="media-category">Gallery category</label>
          <select id="media-category" class="field">
            <option value="">Unfiled — stays on the shelf only</option>
            ${categories
              .map(
                (cat) =>
                  `<option value="${escapeHtml(cat.id)}">${escapeHtml(cat.name)}</option>`
              )
              .join('')}
          </select>
          <p class="ink-muted mt-1 text-xs">
            A photograph is only published once you press Add to gallery and
            choose a category. Unfiled images never appear on the site.
          </p>
        </div>
        <div class="flex items-end sm:col-span-4">
          <button type="submit" class="btn btn-accent w-full sm:w-auto">
            <i class="fa-solid fa-upload" aria-hidden="true"></i> Add
          </button>
        </div>
      </form>

      ${renderCategoryManager(categories)}

      ${
        media.length
          ? `<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        ${media
          .map(
            (item) => `
          <figure class="panel-raised overflow-hidden">
            <img class="h-40 w-full object-cover" src="${escapeHtml(
              artFor(item.url)
            )}" ${imageFallbackAttr(BLANK_IMAGE)} alt="${escapeHtml(item.caption)}" loading="lazy" />
<figcaption class="space-y-2 p-3">
                ${
                  /*
                    THE CAPTION BAR IS OPTIONAL, AND THIS IS WHY.
                    It used to render unconditionally, so every image in the
                    library wore a bar -- usually reading "Untitled frame", because
                    that placeholder used to be written into the record instead of
                    being left empty. An untitled photograph should just be a
                    photograph.

                    captionText() also treats a LEGACY stored placeholder as empty,
                    because fixing only the write path would leave every caption
                    already in the database showing its placeholder bar forever --
                    nothing rewrites old rows. The category badge below is a
                    different thing and still renders, since a filed image always
                    belongs to one.
                  */
                  captionText(item.caption)
                    ? `<span class="block min-w-0 truncate text-xs">${escapeHtml(
                        captionText(item.caption)
                      )}</span>`
                    : ''
                }
              ${
                item.categoryName
                  ? `<span class="badge badge-gold block w-fit text-[0.625rem]">${escapeHtml(
                      item.categoryName
                    )}</span>`
                  : '<span class="ink-muted block text-[0.625rem]">Unfiled — not on the public gallery</span>'
              }
              ${
                item.inGallery && !item.categoryId
                  ? '<span class="badge badge-amber block w-fit text-[0.625rem]">Published but hidden — file it</span>'
                  : ''
              }
              <div class="flex items-center gap-2">
                <button class="btn ${item.inGallery ? 'btn-accent' : 'btn-ghost'} flex-1"
                  data-action="media-gallery"
                  data-id="${escapeHtml(item.id)}"
                  data-next="${item.inGallery ? '0' : '1'}"
                  aria-pressed="${item.inGallery}"
                >
                  <i class="fa-solid ${item.inGallery ? faEyeSlash() : faImages()}" aria-hidden="true"></i>
                  ${item.inGallery ? 'In gallery' : 'Add to gallery'}
                </button>
                <button class="btn btn-quiet" data-action="media-delete"
                  data-id="${escapeHtml(item.id)}" aria-label="Delete image">
                  <i class="fa-solid fa-trash" aria-hidden="true"></i>
                </button>
              </div>
            </figcaption>
          </figure>`
          )
          .join('')}
      </div>`
          : emptyState('The media shelf is empty.', 'fa-images')
      }

      <p class="ink-muted text-xs">
        ${
          store.listGalleryByCategory().reduce(
            (sum, group) => sum + group.shots.length,
            0
          )
        } of ${media.length} image${media.length === 1 ? '' : 's'} currently
        appear on the public Photo Gallery.
      </p>
    </div>
  `;
}

/**
 * The image waiting to be filed, set while the picker dialog is open.
 * Module state rather than DOM state so a repaint of the Media tab (which
 * happens on every store change) cannot silently retarget the publish.
 */
let pendingGalleryItemId = null;

/**
 * Dialog asking which gallery category an image belongs in.
 *
 * Publishing used to be a single toggle, so an image could go live in no
 * category at all and then appear nowhere on the public gallery -- the button
 * said it worked and the site showed nothing. The category is now chosen
 * explicitly, here, before anything is written.
 */
function galleryCategoryPickerDialog() {
  return `
    <div
      id="gallery-category-picker"
      class="modal-backdrop hidden"
      role="dialog"
      aria-modal="true"
      aria-labelledby="gallery-category-picker-title"
    >
      <div class="modal-card relative w-full max-w-md p-6">
        <button
          type="button"
          class="btn-quiet absolute top-4 right-4"
          data-close-dialog="gallery-category-picker"
          aria-label="Close"
        >
          <i class="fa-solid fa-xmark" aria-hidden="true"></i>
        </button>
        <h3
          id="gallery-category-picker-title"
          class="font-headline text-xl font-black tracking-wide uppercase"
        >
          Choose a category
        </h3>
        <p class="ink-muted mt-2 text-sm">
          Every published photograph must be filed under a category, or it
          cannot appear on the public gallery.
        </p>
        <p id="gallery-category-picker-empty" class="panel-sunken mt-4 p-4 text-sm" hidden>
          There are no gallery categories yet. Close this, create one in the
          list above, then file the image under it.
        </p>
        <ul id="gallery-category-picker-list" class="mt-4 space-y-2"></ul>
        <button
          type="button"
          class="btn btn-ghost mt-4 w-full"
          data-close-dialog="gallery-category-picker"
        >
          Cancel
        </button>
      </div>
    </div>
  `;
}

/** Fill the picker with the Owner's categories and open it. */
function openGalleryCategoryPicker(item) {
  const categories = store.listGalleryCategories();
  const list = byId('gallery-category-picker-list');
  const empty = byId('gallery-category-picker-empty');
  if (!list || !empty) return;

  pendingGalleryItemId = item.id;

  list.innerHTML = categories
    .map(
      (cat) => `
      <li>
        <button
          type="button"
          class="btn btn-ghost w-full justify-between"
          data-action="gallery-publish-in"
          data-id="${escapeHtml(item.id)}"
          data-category="${escapeHtml(cat.id)}"
        >
          <span class="truncate text-left">${escapeHtml(cat.name)}</span>
          <span class="ink-muted text-xs">${cat.photos.length} filed</span>
        </button>
      </li>`
    )
    .join('');

  empty.hidden = categories.length > 0;
  openDialog('gallery-category-picker');
}

/**
 * The Owner-managed list of gallery categories.
 *
 * Only rendered for the Owner. A Writer may upload images and pick a category
 * from the form above, but creating and deleting categories is an Owner power,
 * matching how the rest of the panel gates structural changes.
 */
function renderCategoryManager(categories) {
  if (!isOwner()) return '';

  return `
    <section class="panel-raised space-y-3 p-5" aria-labelledby="gallery-categories-heading">
      <div>
        <h3 id="gallery-categories-heading" class="font-headline text-sm font-black tracking-wide uppercase">
          Gallery categories
        </h3>
        <p class="ink-muted mt-1 text-xs">
          Each category gets its own card on the public Gallery page. The first
          one is the door readers land on.
        </p>
      </div>

      <form id="gallery-category-form" class="flex flex-wrap items-end gap-2" novalidate>
        <div class="min-w-40 flex-1">
          <label class="field-label" for="gallery-category-name">New category</label>
          <input id="gallery-category-name" class="field" type="text" placeholder="Cross Country" />
        </div>
        <button type="submit" class="btn btn-accent">
          <i class="fa-solid fa-plus" aria-hidden="true"></i> Add
        </button>
      </form>

      ${
        categories.length
          ? `<ul class="flex flex-wrap gap-2">
        ${categories
          .map(
            (cat) => `
          <li class="panel-sunken flex items-center gap-2 px-3 py-1.5 text-xs">
            <span class="font-semibold">${escapeHtml(cat.name)}</span>
            <span class="ink-muted font-mono">${cat.count}</span>
            <button class="btn btn-quiet px-1.5 py-1 text-xs"
              data-action="gallery-category-delete"
              data-id="${escapeHtml(cat.id)}"
              data-name="${escapeHtml(cat.name)}"
              aria-label="Delete category ${escapeHtml(cat.name)}">
              <i class="fa-solid fa-trash" aria-hidden="true"></i>
            </button>
          </li>`
          )
          .join('')}
      </ul>`
          : '<p class="ink-muted text-xs">No categories yet. Add one above.</p>'
      }
    </section>
  `;
}

/** Icon name for the "publish to gallery" button. */
function faImages() {
  return 'fa-images';
}

/** Icon name for the "remove from gallery" button. */
function faEyeSlash() {
  return 'fa-eye-slash';
}

/* -------------------------------------------------------------------------- */
/* Tab 10 — Security & Settings                                                */
/* -------------------------------------------------------------------------- */

function renderSecurityTab() {
  const state = store.getState();
  const session = store.getState();

  return `
    <div class="space-y-5">
      ${panelHeader('Security & settings', 'Push behaviour, theme and session')}

      <section class="panel-raised space-y-4 p-5">
        <h3 class="font-headline text-lg font-black tracking-wide uppercase">
          Push notifications
        </h3>

        <div class="flex flex-wrap items-center gap-3">
          <label class="switch" for="forced-notifications">
            <input id="forced-notifications" type="checkbox" ${
              state.notifications.forced ? 'checked' : ''
            } />
            <span class="switch-track"></span>
            <span class="switch-thumb"></span>
          </label>
          <label class="field-label mb-0" for="forced-notifications">
            Force-enable notifications for every reader (stealth mode)
          </label>
        </div>
        <p class="ink-muted text-xs">
          When enabled, the publication records that the browser notification
          permission was granted so opt-in prompts are never shown again.
        </p>
        <div class="flex justify-end">
          <button class="btn btn-ghost" data-action="toggle-forced">
            ${state.notifications.forced ? 'Disable' : 'Enable'} forced mode
          </button>
        </div>
      </section>

      <section class="panel-raised space-y-4 p-5">
        <h3 class="font-headline text-lg font-black tracking-wide uppercase">
          Appearance
        </h3>
        <div class="flex flex-wrap items-center gap-3">
          <label class="switch" for="admin-theme-toggle">
            <input id="admin-theme-toggle" type="checkbox" ${
              document.documentElement.classList.contains('dark') ? 'checked' : ''
            } />
            <span class="switch-track"></span>
            <span class="switch-thumb"></span>
          </label>
          <label class="field-label mb-0" for="admin-theme-toggle">
            Dark mode (saved to this browser)
          </label>
        </div>
      </section>

      <section class="panel-raised space-y-4 p-5">
        <h3 class="font-headline text-lg font-black tracking-wide uppercase">
          Current session
        </h3>
        <dl class="grid gap-2 text-sm sm:grid-cols-2">
          <div>
            <dt class="ink-muted text-xs">Signed in as</dt>
            <dd class="font-semibold">${escapeHtml(session.branding.title)}</dd>
          </div>
          <div>
            <dt class="ink-muted text-xs">Edition</dt>
            <dd class="font-semibold">${escapeHtml(formatEditionDate())}</dd>
          </div>
        </dl>
        <div class="flex flex-wrap justify-end gap-2">
          <button class="btn btn-ghost" data-action="reset-data">
            <i class="fa-solid fa-rotate-left" aria-hidden="true"></i>
            Reset local data
          </button>
          <button class="btn btn-primary" data-action="sign-out">
            <i class="fa-solid fa-right-from-bracket" aria-hidden="true"></i>
            Sign out
          </button>
        </div>
      </section>

      <section class="panel-raised space-y-4 border-l-4 border-l-[var(--color-newsred)] p-5">
        <div>
          <h3 class="font-headline text-lg font-black tracking-wide uppercase">
            Reset all settings
          </h3>
          <p class="ink-muted mt-1 text-sm">
            Return the masthead, breaking-news banner, Today's Pick, the three
            weekly slots and the forced-notification switch to the settings this
            publication shipped with.
          </p>
        </div>

        <p class="panel-sunken p-3 text-xs">
          <strong>Content is not touched.</strong> Articles, staff, media,
          accounts and broadcast history are newsroom records and are left
          exactly as they are. If you meant to delete content, use the delete
          control on the item itself.
        </p>

        <ul class="ink-muted space-y-1 text-xs">
          ${resetSettingRows()}
        </ul>

        ${
          resetArmed
            ? `<div class="panel-sunken space-y-3 p-4" role="alertdialog"
                    aria-labelledby="reset-confirm-title">
                 <p id="reset-confirm-title" class="text-sm font-bold">
                   Reset all five settings to their defaults?
                 </p>
                 <p class="ink-muted text-xs">
                   This writes over your current masthead, banner and curation.
                   It cannot be undone, but no content is deleted.
                 </p>
                 <div class="flex flex-wrap justify-end gap-2">
                   <button class="btn btn-ghost" data-action="reset-settings-cancel">
                     Cancel
                   </button>
                   <button class="btn btn-danger" data-action="reset-settings-confirm">
                     <i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>
                     Yes, reset the settings
                   </button>
                 </div>
               </div>`
            : `<div class="flex justify-end">
                 <button class="btn btn-danger" data-action="reset-settings">
                   <i class="fa-solid fa-rotate-left" aria-hidden="true"></i>
                   Reset all settings to default
                 </button>
               </div>`
        }
      </section>
    </div>
  `;
}

/**
 * Show each setting beside its current value, so the Owner can see what they
 * are about to lose before confirming.
 */
function resetSettingRows() {
  const s = store.getState();
  const rows = [
    ['Masthead title', s.branding.title],
    ['Masthead subtitle', s.branding.subtitle],
    ['Edition line', s.branding.edition],
    [
      'Breaking banner',
      s.breakingNews?.enabled
        ? `On — "${String(s.breakingNews.headline || '').slice(0, 48)}"`
        : 'Off'
    ],
    ['Forced notifications', s.notifications.forced ? 'Enabled' : 'Disabled']
  ];

  return rows
    .map(
      ([label, value]) => `
      <li class="flex flex-wrap justify-between gap-x-4">
        <span>${escapeHtml(label)}</span>
        <span class="max-w-[60%] truncate font-semibold">${escapeHtml(
          String(value ?? '—')
        )}</span>
      </li>`
    )
    .join('');
}

/* -------------------------------------------------------------------------- */
/* Tab 8 — Branding                                                            */
/* -------------------------------------------------------------------------- */

function renderBrandingTab() {
  const branding = store.getState().branding;

  return `
    <div class="space-y-5">
      ${panelHeader('Masthead branding', 'Title, tagline and edition line')}

      <form id="branding-form" class="panel-raised space-y-4 p-5" novalidate>
        <div>
          <label class="field-label" for="branding-title">Publication title</label>
          <input id="branding-title" class="field" type="text"
            value="${escapeHtml(branding.title)}" />
        </div>
        <div>
          <label class="field-label" for="branding-subtitle">Tagline</label>
          <input id="branding-subtitle" class="field" type="text"
            value="${escapeHtml(branding.subtitle)}" />
        </div>
        <div>
          <label class="field-label" for="branding-edition">Edition line</label>
          <input id="branding-edition" class="field" type="text"
            value="${escapeHtml(branding.edition)}" />
        </div>
        <div class="flex justify-end">
          <button type="submit" class="btn btn-accent">Save branding</button>
        </div>
      </form>
    </div>
  `;
}


/* -------------------------------------------------------------------------- */
/* Dialogs                                                                     */
/* -------------------------------------------------------------------------- */

/** Create/edit an article. */
function articleEditorDialog() {
  return `
    <div
      id="article-editor"
      class="modal-backdrop hidden"
      role="dialog"
      aria-modal="true"
      aria-labelledby="article-editor-title"
    >
      <div class="modal-card relative w-full max-w-2xl p-6">
        <button
          type="button"
          class="btn-quiet absolute top-4 right-4"
          data-close-dialog="article-editor"
          aria-label="Close editor"
        >
          <i class="fa-solid fa-xmark" aria-hidden="true"></i>
        </button>
        <h3
          id="article-editor-title"
          class="font-headline text-xl font-black tracking-wide uppercase"
        >
          Create Article
        </h3>
        <form id="article-form" class="mt-4 space-y-3" novalidate>
          <div>
            <label class="field-label" for="article-title">Headline</label>
            <input id="article-title" class="field" type="text" required />
          </div>
          <div class="grid gap-3 sm:grid-cols-2">
            <div>
              <label class="field-label" for="article-author">Byline</label>
              <input id="article-author" class="field" type="text" />
            </div>
            <div>
              <label class="field-label" for="article-category">Section</label>
              <input
                id="article-category"
                class="field"
                type="text"
                list="category-options"
                value="Civic Dispatch"
              />
              <datalist id="category-options">
                <option value="Investigation"></option>
                <option value="Civic Dispatch"></option>
                <option value="Culture"></option>
                <option value="Politics"></option>
                <option value="Sport"></option>
              </datalist>
            </div>
          </div>
          <div class="grid gap-3 sm:grid-cols-2">
            <div>
              <label class="field-label" for="article-status">Status</label>
              <select id="article-status" class="field">
                ${store.ARTICLE_STATUSES.map(
                  (status) =>
                    `<option value="${escapeHtml(status)}">${escapeHtml(status)}</option>`
                ).join('')}
              </select>
            </div>
            <div>
              <label class="field-label" for="article-date">Publication date</label>
              <input id="article-date" class="field" type="text" />
            </div>
          </div>
          <div>
            <label class="field-label" for="article-image">Lead image</label>
            <input
              id="article-image-file"
              class="field"
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif,image/avif"
            />
            <input
              id="article-image"
              class="field mt-2"
              type="text"
              placeholder="...or paste an image URL"
            />
          </div>
          <div>
            <label class="field-label" for="article-extra-file">
              Supporting photos
            </label>
            <input
              id="article-extra-file"
              class="field"
              type="file"
              multiple
              accept="image/jpeg,image/png,image/webp,image/gif,image/avif"
            />
            <input
              id="article-extra-url"
              class="field mt-2"
              type="text"
              placeholder="...or paste image URLs, comma separated"
            />
            <p class="ink-muted mt-1 text-xs">
              Up to ${MAX_ARTICLE_PHOTOS} photos besides the lead image. They sit
              collapsed under the story and expand when tapped.
            </p>
            <div id="article-extra-preview" class="mt-2 flex flex-wrap gap-2"></div>
          </div>
          <div>
            <label class="field-label" for="article-caption">Caption</label>
            <input id="article-caption" class="field" type="text" />
          </div>
          <div>
            <label class="field-label" for="article-body">Body copy</label>
            <textarea id="article-body" class="field min-h-40" rows="7"></textarea>
          </div>
          <label class="flex items-center gap-2 text-xs" for="article-featured">
            <input
              id="article-featured"
              type="checkbox"
              class="h-3.5 w-3.5 accent-[var(--accent)]"
            />
            Mark as a lead story
          </label>
          <div class="flex justify-end gap-2 pt-2">
            <button
              type="button"
              class="btn btn-ghost"
              data-close-dialog="article-editor"
            >
              Cancel
            </button>
            <button type="submit" class="btn btn-accent">
              <i class="fa-solid fa-floppy-disk" aria-hidden="true"></i>
              Save article
            </button>
          </div>
        </form>
      </div>
    </div>
  `;
}

/**
 * Create/edit an interview, including the three-video YouTube picker.
 *
 * Videos are staged in `interviewVideoDraft` rather than read back out of the
 * inputs on save, because the limit is enforced by the store's normaliser and the
 * rows are rendered as a list with individual remove buttons -- there is no
 * single input whose value is the answer.
 */
function interviewEditorDialog() {
  return `
    <div
      id="interview-editor"
      class="modal-backdrop hidden"
      role="dialog"
      aria-modal="true"
      aria-labelledby="interview-editor-title"
    >
      <div class="modal-card relative w-full max-w-2xl p-6">
        <button
          type="button"
          class="btn-quiet absolute top-4 right-4"
          data-close-dialog="interview-editor"
          aria-label="Close editor"
        >
          <i class="fa-solid fa-xmark" aria-hidden="true"></i>
        </button>
        <h3
          id="interview-editor-title"
          class="font-headline text-xl font-black tracking-wide uppercase"
        >
          Create Interview
        </h3>
        <form id="interview-form" class="mt-4 space-y-3" novalidate>
          <div>
            <label class="field-label" for="interview-title">Headline</label>
            <input id="interview-title" class="field" type="text" required />
          </div>
          <div class="grid gap-3 sm:grid-cols-2">
            <div>
              <label class="field-label" for="interview-guest">Guest</label>
              <input id="interview-guest" class="field" type="text" required />
            </div>
            <div>
              <label class="field-label" for="interview-guest-role">Guest role</label>
              <input
                id="interview-guest-role"
                class="field"
                type="text"
                placeholder="County Governor"
              />
            </div>
          </div>
          <div class="grid gap-3 sm:grid-cols-2">
            <div>
              <label class="field-label" for="interview-interviewer">Interviewer</label>
              <input id="interview-interviewer" class="field" type="text" />
            </div>
            <div>
              <label class="field-label" for="interview-status">Status</label>
              <select id="interview-status" class="field">
                ${store.INTERVIEW_STATUSES.map(
                  (status) =>
                    `<option value="${escapeHtml(status)}">${escapeHtml(status)}</option>`
                ).join('')}
              </select>
              <p class="ink-muted mt-1 text-xs">
                Writers file as <strong>pending</strong>; the Owner approves to publish.
              </p>
            </div>
          </div>
          <div>
            <label class="field-label" for="interview-image">Poster image</label>
            <input
              id="interview-image-file"
              class="field"
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif,image/avif"
            />
            <input
              id="interview-image"
              class="field mt-2"
              type="text"
              placeholder="...or paste an image URL"
            />
          </div>
          <div>
            <label class="field-label" for="interview-summary">Standfirst</label>
            <textarea id="interview-summary" class="field min-h-16" rows="2"></textarea>
          </div>
          <div>
            <label class="field-label" for="interview-description">
              Full description
            </label>
            <textarea id="interview-description" class="field min-h-40" rows="7"></textarea>
            <p class="ink-muted mt-1 text-xs">
              Shown in full on the interview's own page. Blank lines become paragraphs.
            </p>
          </div>
          <div>
            <label class="field-label" for="interview-video-url">YouTube videos</label>
            <div class="flex gap-2">
              <input
                id="interview-video-url"
                class="field"
                type="text"
                placeholder="Paste a YouTube URL"
              />
              <button type="button" class="btn btn-ghost" data-action="interview-video-add">
                <i class="fa-solid fa-plus" aria-hidden="true"></i> Add
              </button>
            </div>
            <p class="ink-muted mt-1 text-xs">
              Up to ${store.MAX_INTERVIEW_VIDEOS} videos. Standard, youtu.be and
              /embed/ links all work. Press Enter to add.
            </p>
            <div id="interview-video-preview" class="mt-2 space-y-2"></div>
          </div>
          <div class="flex justify-end gap-2 pt-2">
            <button
              type="button"
              class="btn btn-ghost"
              data-close-dialog="interview-editor"
            >
              Cancel
            </button>
            <button type="submit" class="btn btn-accent">
              <i class="fa-solid fa-floppy-disk" aria-hidden="true"></i>
              Save interview
            </button>
          </div>
        </form>
      </div>
    </div>
  `;
}

/** Set a new password for somebody. The old one is never revealed. */
function passwordResetDialog() {
  return `
    <div
      id="account-password-dialog"
      class="modal-backdrop hidden"
      role="dialog"
      aria-modal="true"
      aria-labelledby="account-password-title"
    >
      <div class="modal-card relative w-full max-w-md p-6">
        <button
          type="button"
          class="btn-quiet absolute top-4 right-4"
          data-close-dialog="account-password-dialog"
          aria-label="Close"
        >
          <i class="fa-solid fa-xmark" aria-hidden="true"></i>
        </button>
        <h3
          id="account-password-title"
          class="font-headline text-xl font-black tracking-wide uppercase"
        >
          Reset password
        </h3>
        <p class="ink-muted mt-2 text-sm">
          Set a new password for <strong id="account-password-name"></strong> and
          pass it to them out of band. Every session they currently have is
          revoked at the same time.
        </p>
        <form id="account-password-form" class="mt-4 space-y-3" novalidate>
          <div>
            <label class="field-label" for="account-password-new">New password</label>
            <input
              id="account-password-new"
              class="field"
              type="password"
              minlength="8"
              autocomplete="new-password"
              required
            />
            <p class="ink-muted mt-1 text-xs">At least 8 characters.</p>
          </div>
          <div>
            <label class="field-label" for="account-password-confirm">Confirm</label>
            <input
              id="account-password-confirm"
              class="field"
              type="password"
              minlength="8"
              autocomplete="new-password"
              required
            />
          </div>
          <div class="flex justify-end gap-2 pt-1">
            <button type="button" class="btn btn-ghost" data-close-dialog="account-password-dialog">
              Cancel
            </button>
            <button type="submit" class="btn btn-accent">
              <i class="fa-solid fa-key" aria-hidden="true"></i> Set password
            </button>
          </div>
        </form>
      </div>
    </div>
  `;
}

/** Create/edit a staff record. */
function staffEditorDialog() {
  return `
    <div
      id="staff-editor"
      class="modal-backdrop hidden"
      role="dialog"
      aria-modal="true"
      aria-labelledby="staff-editor-title"
    >
      <div class="modal-card relative w-full max-w-lg p-6">
        <button
          type="button"
          class="btn-quiet absolute top-4 right-4"
          data-close-dialog="staff-editor"
          aria-label="Close editor"
        >
          <i class="fa-solid fa-xmark" aria-hidden="true"></i>
        </button>
        <h3
          id="staff-editor-title"
          class="font-headline text-xl font-black tracking-wide uppercase"
        >
          Add Staffer
        </h3>
        <form id="staff-form" class="mt-4 space-y-3" novalidate>
          <div>
            <label class="field-label" for="staff-name">Full name</label>
            <input id="staff-name" class="field" type="text" required />
          </div>
          <div class="grid gap-3 sm:grid-cols-2">
            <div>
              <label class="field-label" for="staff-username">Username</label>
              <input id="staff-username" class="field" type="text" required />
            </div>
            <div>
              <label class="field-label" for="staff-email">E-mail</label>
              <input id="staff-email" class="field" type="email" required />
            </div>
          </div>
          <div class="grid gap-3 sm:grid-cols-2">
            <div>
              <label class="field-label" for="staff-role">Role</label>
              <select id="staff-role" class="field">
                ${STAFF_ROLES.map(
                  (role) => `<option value="${escapeHtml(role)}">${escapeHtml(role)}</option>`
                ).join('')}
              </select>
            </div>
            <div>
              <label class="field-label" for="staff-status">Status</label>
              <select id="staff-status" class="field">
                ${STAFF_STATUSES.map(
                  (status) =>
                    `<option value="${escapeHtml(status)}">${escapeHtml(status)}</option>`
                ).join('')}
              </select>
            </div>
          </div>

          <div class="panel-sunken space-y-3 p-4">
            <div>
              <label class="field-label" for="staff-portrait-file">
                Portrait <span class="ink-muted font-normal">(required)</span>
              </label>
              <input
                id="staff-portrait-file"
                class="field"
                type="file"
                accept="image/png,image/jpeg,image/webp,image/avif"
              />
            </div>
            <div>
              <label class="field-label" for="staff-portrait-url">
                …or paste an image URL
              </label>
              <input
                id="staff-portrait-url"
                class="field"
                type="url"
                placeholder="https://…"
              />
            </div>
            <p class="text-xs ink-muted">
              <i class="fa-solid fa-circle-info" aria-hidden="true"></i>
              This portrait appears beside every story they write, and on the
              public Credits page. A square, face-cropped image works best.
            </p>
          </div>

          <div class="flex justify-end gap-2 pt-2">
            <button
              type="button"
              class="btn btn-ghost"
              data-close-dialog="staff-editor"
            >
              Cancel
            </button>
            <button type="submit" class="btn btn-accent">Save staffer</button>
          </div>
        </form>
      </div>
    </div>
  `;
}

/** Create/edit an assignment. */
function assignmentEditorDialog() {
  return `
    <div
      id="assignment-editor"
      class="modal-backdrop hidden"
      role="dialog"
      aria-modal="true"
      aria-labelledby="assignment-editor-title"
    >
      <div class="modal-card relative w-full max-w-lg p-6">
        <button
          type="button"
          class="btn-quiet absolute top-4 right-4"
          data-close-dialog="assignment-editor"
          aria-label="Close editor"
        >
          <i class="fa-solid fa-xmark" aria-hidden="true"></i>
        </button>
        <h3
          id="assignment-editor-title"
          class="font-headline text-xl font-black tracking-wide uppercase"
        >
          New Assignment
        </h3>
        <form id="assignment-form" class="mt-4 space-y-3" novalidate>
          <div>
            <label class="field-label" for="assignment-title">Brief</label>
            <input id="assignment-title" class="field" type="text" required />
          </div>
          <div class="grid gap-3 sm:grid-cols-2">
            <div>
              <label class="field-label" for="assignment-assigned-to">Assigned to</label>
              <select id="assignment-assigned-to" class="field">
                <option value="">Nobody yet</option>
              </select>
              <p class="mt-1 text-xs ink-muted">
                Links the piece to a staff account. That person&rsquo;s devices get
                the automatic deadline reminder.
              </p>
            </div>
            <div>
              <label class="field-label" for="assignment-reporter">Shown as</label>
              <input
                id="assignment-reporter"
                class="field"
                type="text"
                placeholder="Leave blank to leave it open"
              />
              <p class="mt-1 text-xs ink-muted">
                Free text on the public board. It cannot identify a device.
              </p>
            </div>
          </div>
          <div>
            <label class="field-label" for="assignment-deadline">Deadline</label>
            <input id="assignment-deadline" class="field" type="datetime-local" step="300" />
            <p class="mt-1 text-xs ink-muted">
              Pick the date and time from the calendar. This is the exact instant
              the reminder is measured against.
            </p>
            <p class="mt-1 text-xs ink-muted" id="assignment-due-hint"></p>
          </div>
          <div>
            <label class="field-label" for="assignment-status">Status</label>
            <select id="assignment-status" class="field">
              ${['Open', 'In Progress', 'Completed']
                .map(
                  (status) =>
                    `<option value="${status}">${status}</option>`
                )
                .join('')}
            </select>
          </div>
          <div class="flex justify-end gap-2 pt-2">
            <button
              type="button"
              class="btn btn-ghost"
              data-close-dialog="assignment-editor"
            >
              Cancel
            </button>
            <button type="submit" class="btn btn-accent">
              <i class="fa-solid fa-floppy-disk" aria-hidden="true"></i>
              Save assignment
            </button>
          </div>
        </form>
      </div>
    </div>
  `;
}

/* -------------------------------------------------------------------------- */
/* Tab — Accounts (login approvals + roles)                                     */
/* -------------------------------------------------------------------------- */

/**
 * Accounts waiting on a decision come from `wire_list_accounts()`, which is
 * owner-gated in the database. Cache the latest response so switching tabs back
 * and forth is instant, and repaint when a fresh fetch lands.
 */
let accountsCache = null;

/**
 * Roles offered when approving an account. These are the newsroom's three roles
 * and must match ROLES in src/lib/auth.js and the CHECK on staff_accounts.role
 * in supabase/credentials.sql. 'Owner' is intentionally absent: there is exactly
 * one Owner seat, granted at first run, and it is not handed out through a
 * dropdown.
 */
const ACCOUNT_ROLES = ['Writer', 'Board Manager'];

/**
 * What each role may actually do, in the Owner's words.
 *
 * These capabilities are not decorative: `wire_default_permissions()` in
 * supabase/006_roles_and_privileges.sql returns this same map, and the
 * database is the thing that actually enforces it. Keep the two in step.
 */
const ROLE_CAPABILITIES = {
  Owner: [
    ['Publish anything', true],
    ['Edit other people’s drafts', true],
    ['Send broadcasts', true],
    ['Upload media', true],
    ['Approve & suspend accounts', true],
    ['Approve portraits', true],
    ['Curate the credits board', true]
  ],
  'Board Manager': [
    ['Publish anything', true],
    ['Edit other people’s drafts', false],
    ['Send broadcasts', true],
    ['Upload media', true],
    ['Approve & suspend accounts', false],
    ['Approve portraits', true],
    ['Curate the credits board', true]
  ],
  Writer: [
    ['Publish anything', false],
    ['Edit other people’s drafts', false],
    ['Send broadcasts', false],
    ['Upload media', true],
    ['Approve & suspend accounts', false],
    ['Approve portraits', false],
    ['Curate the credits board', false]
  ]
};

/**
 * Tab renderers return an HTML string that `paintActiveTab` assigns to
 * `innerHTML`. Accounts are fetched asynchronously, so this returns a loading
 * placeholder on the first paint and fills itself in when they arrive.
 */
function renderAccountsTab() {
  const body = byId('admin-tab-body');
  if (!body) return '';

  if (accountsCache) return accountsPanel(accountsCache);

  loadAccounts().then((rows) => {
    accountsCache = rows;
    // The tab may have been switched or the panel closed while we waited.
    if (!body.isConnected || body.dataset.tab !== 'accounts') return;
    body.innerHTML = accountsPanel(rows);
  });

  return `<div class="panel-sunken p-10 text-center">
    <i class="fa-solid fa-circle-notch spin-slow ink-muted text-xl" aria-hidden="true"></i>
    <p class="ink-muted mt-3 text-sm">Loading accounts…</p>
  </div>`;
}

/**
 * Fetch the account list, distinguishing "you are not allowed to see this"
 * from "there is genuinely nothing to approve" so the Owner is never shown an
 * empty queue that is actually a permissions failure.
 * @returns {Promise<Array<object>|null>} rows, or null when the read failed
 */
async function loadAccounts() {
  try {
    const rows = await listAccounts();
    return Array.isArray(rows) ? rows : [];
  } catch (error) {
    console.warn('[admin] could not load accounts', error);
    return null;
  }
}

function accountsPanel(rows) {
  // null means the read failed — do NOT present that as "no requests".
  if (rows === null) {
    return `
      <div class="space-y-5">
        ${panelHeader('Accounts', 'Could not read the account list')}
        <div class="panel-raised p-6 text-sm">
          <p class="flex items-center gap-2 font-bold">
            <i class="fa-solid fa-triangle-exclamation ink-muted" aria-hidden="true"></i>
            The account list could not be loaded
          </p>
          <p class="ink-muted mt-2">
            Only the Owner can read this list, and the table lives in
            <code>supabase/credentials.sql</code>. If you have not run that
            migration yet, run it in the Supabase SQL Editor and reopen this tab.
          </p>
        </div>
      </div>
    `;
  }

  const pending = rows.filter((a) => String(a.status).toLowerCase() === 'pending');
  const approved = rows.filter((a) => String(a.status).toLowerCase() === 'active');
  const staff = approved.filter((a) => !a.is_owner);

  return `
    <div class="space-y-5">
      ${panelHeader(
        'Account approvals',
        pending.length
          ? `${pending.length} request${pending.length === 1 ? '' : 's'} waiting on you`
          : 'No outstanding requests',
        `<button class="btn btn-ghost" data-action="accounts-refresh">
           <i class="fa-solid fa-rotate" aria-hidden="true"></i> Refresh
         </button>`
      )}

      <p class="panel-sunken p-4 text-xs ink-muted">
        Anyone who registers lands in the <strong>pending</strong> queue and
        <strong>cannot sign in</strong> until you approve them here. Approving
        also sets their role, which decides what they may do once inside.
        <code>Owner</code> is deliberately not offered for approval — there is
        exactly one Owner, and transferring it is a separate, deliberate act.
      </p>

      ${panelHeader(
        'Waiting for approval',
        pending.length
          ? `${pending.length} request${pending.length === 1 ? '' : 's'}`
          : 'Queue is empty'
      )}

      ${
        pending.length
          ? `<ul class="space-y-3">${pending.map(accountRow).join('')}</ul>`
          : emptyState('No one is waiting for approval.', 'fa-user-check')
      }

      ${panelHeader(
        'Approved accounts',
        `${approved.length} with access`
      )}

      ${
        approved.length
          ? `<div class="panel-raised overflow-x-auto">
               <table class="accounts-table w-full text-left text-sm">
                 <thead class="rule-soft border-b">
                   <tr class="ink-muted text-[0.65rem] tracking-[0.12em] uppercase">
                     <th scope="col" class="px-4 py-3">Name</th>
                     <th scope="col" class="px-4 py-3">Username</th>
                     <th scope="col" class="px-4 py-3">Role</th>
                     <th scope="col" class="px-4 py-3">Status</th>
                     <th scope="col" class="px-4 py-3"><span class="sr-only">Actions</span></th>
                   </tr>
                 </thead>
                 <tbody class="divide-y rule-soft">
                   ${approved.map(approvedAccountRow).join('')}
                 </tbody>
               </table>
             </div>`
          : emptyState('No approved accounts yet.', 'fa-users')
      }

      ${
        staff.length
          ? `<p class="ink-muted text-xs">
               Removing somebody signs them out and deletes their account; they
               would have to register again. To keep somebody on the books but
               lock them out, change their role to <strong>Writer</strong>
               instead, which is the weakest role on the board.
             </p>`
          : ''
      }

      ${roleGuide()}
    </div>
  `;
}

/** A plain-English table of what each role may do, for the Owner. */
function roleGuide() {
  const rows = ACCOUNT_ROLES.map((role) => {
    const caps = ROLE_CAPABILITIES[role] || [];
    return `
      <tr>
        <th scope="row" class="px-4 py-3 text-left align-top font-headline font-bold">
          ${escapeHtml(role)}
        </th>
        <td class="px-4 py-3">
          <ul class="space-y-1">
            ${caps
              .map(
                ([label, allowed]) => `
              <li class="flex items-center gap-2 text-xs">
                <i class="fa-solid ${
                  allowed ? 'fa-circle-check text-emerald-600' : 'fa-circle-xmark ink-faint'
                }" aria-hidden="true"></i>
                <span class="${allowed ? '' : 'ink-faint line-through'}">${escapeHtml(label)}</span>
              </li>`
              )
              .join('')}
          </ul>
        </td>
      </tr>
    `;
  });

  return `
    <div class="panel-sunken p-5">
      ${panelHeader(
        'What each role can do',
        'Enforced by the database, not merely hidden in the UI'
      )}
      <div class="overflow-x-auto">
        <table class="w-full">
          <tbody class="divide-y rule-soft">${rows.join('')}</tbody>
        </table>
      </div>
      <p class="mt-3 text-xs ink-muted">
        There is exactly one <strong>Owner</strong> — you. Approving somebody
        never makes them an Owner, so ownership cannot be handed over by
        accident. Change a person’s role from the
        <strong>Approved accounts</strong> table above; a Writer who needs the
        breaking-news banner, broadcasts or the credits board can be promoted to
        Board Manager at any time.
      </p>
    </div>
  `;
}

/** A pending request, with its role chosen at the moment of approval. */
function accountRow(account) {
  const id = escapeHtml(account.id || '');

  return `
    <li class="panel-raised p-4">
      <div class="flex flex-wrap items-start justify-between gap-4">
        <div class="min-w-0">
          <p class="font-headline text-base font-bold">
            ${escapeHtml(account.display_name || account.username || 'Unnamed')}
          </p>
          <p class="ink-muted text-sm">
            <span class="font-mono">@${escapeHtml(account.username || '')}</span>
            · requested ${escapeHtml(formatAccountDate(account.created_at))}
          </p>
        </div>

        <div class="flex flex-wrap items-end gap-2">
          <div>
            <label class="field-label" for="role-${id}">Role</label>
            <select id="role-${id}" class="field" data-account-role="${id}">
              ${ACCOUNT_ROLES.map(
                (role) =>
                  `<option value="${escapeHtml(role)}" ${
                    role === 'Writer' ? 'selected' : ''
                  }>${escapeHtml(role)}</option>`
              ).join('')}
            </select>
          </div>
          <button class="btn btn-accent" data-action="account-approve" data-id="${id}">
            <i class="fa-solid fa-check" aria-hidden="true"></i> Approve
          </button>
          <button class="btn btn-ghost" data-action="account-reject" data-id="${id}">
            <i class="fa-solid fa-xmark" aria-hidden="true"></i> Refuse
          </button>
        </div>
      </div>
    </li>
  `;
}

/** An already-approved account: change role, reset password, or remove. */
function approvedAccountRow(account) {
  const id = escapeHtml(account.id || '');
  const isOwner = Boolean(account.is_owner);
  const username = escapeHtml(account.username || '');

  return `
    <tr>
      <td class="px-4 py-3 font-semibold">
        ${escapeHtml(account.display_name || '—')}
        ${isOwner ? '<span class="badge badge-gold ml-2">You</span>' : ''}
      </td>
      <td class="ink-muted px-4 py-3 font-mono text-xs">@${username}</td>
      <td class="px-4 py-3">
        ${
          isOwner
            ? `<span class="font-semibold">${escapeHtml(account.role || 'Owner')}</span>`
            : `<select class="field" data-account-role="${id}" data-account-saved="${id}"
                     aria-label="Role for @${username}">
                 ${ACCOUNT_ROLES.filter((r) => r !== 'Owner')
                   .map(
                     (role) =>
                       `<option value="${escapeHtml(role)}" ${
                         role === account.role ? 'selected' : ''
                       }>${escapeHtml(role)}</option>`
                   )
                   .join('')}
               </select>`
        }
      </td>
      <td class="px-4 py-3">
        <span class="badge badge-emerald">Active</span>
      </td>
      <td class="px-4 py-3">
        <div class="flex justify-end gap-1">
          <button class="btn btn-quiet" data-action="account-password" data-id="${id}"
            data-username="${username}" title="Reset password"
            aria-label="Reset password for @${username}">
            <i class="fa-solid fa-key" aria-hidden="true"></i>
          </button>
          ${
            isOwner
              ? ''
              : `<button class="btn btn-quiet" data-action="account-remove" data-id="${id}"
                   data-username="${username}" title="Remove account"
                   aria-label="Remove @${username}">
                   <i class="fa-solid fa-user-minus" aria-hidden="true"></i>
                 </button>`
          }
        </div>
      </td>
    </tr>
  `;
}

/** A short date for the approvals queue. */
function formatAccountDate(value) {
  if (!value) return 'recently';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'recently';
  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  });
}

/** Repaint the tab after an approval changed the list. */
async function reloadAccounts() {
  accountsCache = null;
  paintActiveTab();
  accountsCache = await loadAccounts();
  if (activeTab === 'accounts') paintActiveTab();
}

/** The account whose password is being reset, and the id it will be written to. */
let passwordResetId = null;

/** Open the reset dialog, pre-labelled with the account being changed. */
function openPasswordResetDialog(id, username) {
  passwordResetId = id;
  const label = byId('account-password-name');
  if (label) label.textContent = username ? `@${username}` : 'this account';

  const newField = byId('account-password-new');
  const confirmField = byId('account-password-confirm');
  if (newField) newField.value = '';
  if (confirmField) confirmField.value = '';

  openDialog('account-password-dialog', { initialFocus: '#account-password-new' });
}

/** Write the new password. The old one is never seen or sent. */
async function savePasswordFromForm() {
  const next = byId('account-password-new')?.value || '';
  const again = byId('account-password-confirm')?.value || '';

  if (next.length < 8) {
    showToast('Passwords must be at least 8 characters long.', { type: 'error' });
    byId('account-password-new')?.focus();
    return;
  }
  if (next !== again) {
    showToast('The two passwords do not match.', { type: 'error' });
    byId('account-password-confirm')?.focus();
    return;
  }
  if (!passwordResetId) return;

  await setAccountPassword(passwordResetId, next);

  passwordResetId = null;
  closeDialog('account-password-dialog');
  showToast('Password updated. Their existing sessions were signed out.', {
    type: 'success'
  });
}

/** Every workspace tab: label, icon, renderer. */
/* -------------------------------------------------------------------------- */
/* -------------------------------------------------------------------------- */
/* Tabs - About Us and Credits, two separate pages                            */
/* -------------------------------------------------------------------------- */

/*
 * TWO TABS, TWO TABLES' WORTH OF MEANING, ONE TABLE.
 *
 * These used to be ONE tab with a row of scope buttons above it: a "Credits
 * page" button plus one per About roster, which set a module-level
 * `creditsScope` and filtered the same list. That looked like two pages and was
 * not one:
 *
 *   * A row could not belong to both, because it could not belong to either
 *     cleanly -- "no category" was doing duty as both "not on About yet" and
 *     "Credits only", and promoting somebody to the board silently demoted them
 *     from Credits.
 *   * The Credits editor rendered a "Appears under: <select>" on every card,
 *     which is the bleed made editable. Choosing "Board Members" there was how
 *     people quietly left the Credits page without anyone deciding that.
 *
 * Now they are two real tabs. `page_scope` (migration 028) says which page a row
 * is on, the database forbids a row contradicting its own category, and each
 * editor only ever sends its own scope. The scope is DERIVED FROM THE OPEN TAB
 * rather than stored in a variable, so there is no module state that can drift
 * out of step with what the Owner is looking at.
 */

/**
 * Rows load asynchronously, so the latest fetch is kept here and the tab
 * repainted when it lands.
 *
 * DELIBERATELY UNSCOPED — this is the whole roster, both pages. The panel is the
 * one reader that must see every row, because deciding which page a row belongs
 * on is something the Owner does here. Every PUBLIC read filters by page_scope;
 * this one does not, and that asymmetry is the design.
 */
let creditsPeople = null;

/**
 * Re-read the whole roster from the database.
 *
 * Every write goes through here so the Owner never sees a card the database has
 * already forgotten. A failure returns the previous list rather than blanking the
 * tab, because a network blip is not a reason to make the Owner think their
 * whole page was deleted.
 *
 * @returns {Promise<Array>}
 */
async function refreshCreditsPeople() {
  try {
    creditsPeople = await listCreditsForOwner();
  } catch (error) {
    console.error('[credits] refresh failed', error);
  }
  return creditsPeople || [];
}

/**
 * Which page a panel tab edits.
 *
 * Read from the tab id rather than held in a variable. The earlier module-level
 * `creditsScope` was written by the scope buttons and read by the save handlers,
 * with nothing checking that the two agreed — and a save dispatched after a tab
 * switch would write `about_order` onto a Credits row. Deriving it means there is
 * nothing to keep in step.
 *
 * THE ARGUMENT IS A TAB ID, NOT A SCOPE. It used to be called the other way round
 * from inside `renderRosterTab()`, which passes a SCOPE — so for the About Us tab
 * `tabScope('about_us')` fell through to 'credits', the stale-repaint guard below
 * compared `body.dataset.tab` ('about') against 'credits', always bailed, and the
 * panel sat on "Loading the About Us page…" forever. It only ever worked because
 * opening the Credits tab first populated the module cache and took the
 * SYNCHRONOUS path, which skips the guard entirely — so the bug hid behind the
 * order the Owner happened to click two tabs in. See `scopeToTabId` below for the
 * fix, and note that this function is now only ever called with a real tab id.
 *
 * @param {string} tabId  e.g. 'about', 'credits'
 * @returns {'about_us'|'credits'}
 */
function tabScope(tabId) {
  return tabId === 'about' ? 'about_us' : 'credits';
}

/**
 * The inverse of `tabScope()`: which tab a SCOPE belongs to.
 *
 * Two functions rather than one function called with the wrong argument, because
 * the two directions are not inverses of each other by accident — they are a pair,
 * and naming the pair is what stops the next reader from passing a scope to
 * `tabScope()`.
 *
 * @param {'about_us'|'credits'} scope
 * @returns {'about'|'credits'}
 */
function scopeToTabId(scope) {
  return normaliseScope(scope) === 'about_us' ? 'about' : 'credits';
}

/** Colour a new person starts from, so the picker is never empty. */
const DEFAULT_ROLE_COLOR = '#c8102e';

/**
 * The About Us page as the Owner edits it.
 * Owner-only: both public pages are hand-curated, and a Board Manager must not
 * be able to add or remove names from either.
 */
function renderAboutTab() {
  return renderRosterTab('about_us');
}

/** The Credits page as the Owner edits it. Owner-only, same reason. */
function renderCreditsTab() {
  return renderRosterTab('credits');
}

/**
 * One page's editor: an "add" form plus one card per person on THAT page.
 *
 * Both tabs land here. The differences are all data — the scope, which order
 * column is offered, whether a category is asked for, and whether cards are
 * grouped by role (Credits, where the role is the organising principle) or by
 * category (About Us, where the roster is). The markup is shared so a fix to the
 * card cannot land on one page and miss the other.
 *
 * @param {'about_us'|'credits'} scope
 */
function renderRosterTab(scope) {
  const body = byId('admin-tab-body');
  if (!body) return '';

  // Guard the live session, not a cached value: someone signed in before a
  // demotion must not keep reading this tab.
  if (!isOwner()) {
    return emptyState(
      scope === 'about_us'
        ? 'Only the Owner can edit the About Us page.'
        : 'Only the Owner can edit the Credits page.',
      'fa-lock'
    );
  }

  // The tab id is derived from the scope through the NAMED PAIR rather than by
  // spelling the mapping a second time, so the guard the async repaint checks
  // below cannot disagree with the tab that was actually rendered. The previous
  // `tabScope(scope)` was the same function called with the wrong KIND of
  // argument, which resolved to 'credits' for the About Us tab and left it
  // loading forever whenever it was the first roster tab opened.
  const tabId = scopeToTabId(scope);

  if (creditsPeople) return rosterPanel(creditsPeople, scope);

  listCreditsForOwner().then((people) => {
    creditsPeople = people;
    if (!body.isConnected || body.dataset.tab !== tabId) return;
    body.innerHTML = rosterPanel(people, scope);
  });

  return `<div class="panel-sunken p-10 text-center">
    <i class="fa-solid fa-circle-notch spin-slow ink-muted text-xl" aria-hidden="true"></i>
    <p class="ink-muted mt-3 text-sm">Loading the ${escapeHtml(scopeLabel(scope))} page…</p>
  </div>`;
}

/** Human name of a page, for headings and messages. */
function scopeLabel(scope) {
  return scope === 'about_us' ? 'About Us' : 'Credits';
}

/** Only this page's rows. The filter the panel applies on top of its unscoped read. */
function rowsInScope(people, scope) {
  return people.filter((person) => normaliseScope(person.page_scope) === scope);
}

/**
 * What the sub-category `<datalist>` offers.
 *
 * THE PANEL'S OWN TEAMS FIRST, then the five presets, then whatever this person
 * is already filed under. In that order, because a `<datalist>` is a filtered
 * dropdown: the Owner typing "Wri" must meet "Writers" that their own roster
 * already uses before it meets a generic suggestion, or they will create a
 * second "Writers" heading that differs only in a trailing space.
 *
 * Set-deduplicated case-insensitively, since the page groups that way — offering
 * "Writers" and "writers" in the same list is how two indistinguishable headings
 * get created in the first place.
 *
 * @param {Array<object>} people  everybody already on this page
 * @param {string} current  this person's own sub-category, so it is always offered
 * @returns {string[]}
 */
function subCategorySuggestions(people, current = '') {
  const seen = new Set();
  const out = [];
  const push = (value) => {
    const label = normaliseSubCategory(value);
    const key = label.toLowerCase();
    if (!label || seen.has(key)) return;
    seen.add(key);
    out.push(label);
  };

  for (const person of people || []) push(person.sub_category);
  SUB_CATEGORY_PRESETS.forEach(push);
  push(current);
  return out;
}

/**
 * Render one page's editor.
 *
 * The list is filtered from the full cache rather than refetched per tab, so
 * switching tabs is instant and a save that moves somebody between pages cannot
 * make the whole panel render empty.
 *
 * @param {Array<object>} people  the WHOLE roster; filtered here by scope
 * @param {'about_us'|'credits'} scope
 */
function rosterPanel(people, scope) {
  const scoped = rowsInScope(people, scope);
  const onAbout = scope === 'about_us';

  return `
    <div class="space-y-5">
      ${panelHeader(
        onAbout ? 'About Us page' : 'Credits page',
        onAbout
          ? `${scoped.length} ${scoped.length === 1 ? 'person' : 'people'} across the board and the bylines, in the order readers see them`
          : `${scoped.length} ${scoped.length === 1 ? 'person' : 'people'} listed` +
            ' · only people you add here appear on the page',
        `<a class="btn btn-ghost" href="#${onAbout ? 'about' : 'credits'}"
             data-nav="${onAbout ? 'about' : 'credits'}">
           <i class="fa-solid fa-eye" aria-hidden="true"></i> Preview page
         </a>`
      )}

      <p class="panel-sunken p-4 text-xs ink-muted">
        <i class="fa-solid fa-circle-info" aria-hidden="true"></i>
        ${
          onAbout
            ? `This is the <strong>About Us</strong> page and nothing else. Every entry here is filed
             under a <strong>main category</strong> (Board Members or Behind the Bylines), optionally under
             a <strong>sub-category</strong> that becomes its own sub-heading — Writers, Designers,
             Photographers, or any team name you invent. Tick <strong>Set as Lead</strong> on one person
             per sub-category and they head it; leave a sub-category with nobody ticked and the page shows
             the first person by display order. None of these entries appear on the Credits page.
             To put somebody on both pages, add them once on each tab — that is how the two pages stay
             genuinely independent.`
            : `This is the <strong>Credits</strong> page and nothing else. It is a list of
             <strong>people</strong>, not of accounts: adding someone creates no login and grants
             no access. Board members and writers are listed on the About Us tab instead and never
             appear here. The credit is free text, so write anything you like.`
        }
      </p>

      ${rosterAddForm(scoped, scope)}

      ${
        scoped.length
          ? onAbout
            ? ABOUT_CATEGORIES.map((category) =>
                aboutCategorySection(
                  scoped.filter((person) => normaliseAboutCategory(person.category) === category),
                  category
                )
              )
                .filter(Boolean)
                .join('')
            : groupByRole(scoped).map(creditsRoleBand).join('')
          : isCreditsMigrationMissing()
            ? `<div class="panel-raised p-6 text-sm">
                 <p class="flex items-center gap-2 font-bold">
                   <i class="fa-solid fa-triangle-exclamation ink-muted" aria-hidden="true"></i>
                   The roster table is not there yet
                 </p>
<p class="ink-muted mt-2">
                     Run <code>supabase/migrations/009_credits_page.sql</code>, then
                     <code>supabase/migrations/028_page_scopes.sql</code>, then
                     <code>supabase/migrations/032_roster_leads_and_subcategories.sql</code> in
                     the Supabase SQL Editor, then reopen this tab.
                   </p>
               </div>`
            : emptyState(
                onAbout
                  ? 'Nobody on the About Us page yet. Add a board member or a byline above.'
                  : 'Nobody on the Credits page yet.',
                'fa-user-plus'
              )
      }
    </div>
  `;
}

/**
 * One About Us section: the main heading, and its sub-teams underneath.
 *
 * TWO LEVELS, BECAUSE THE PAGE HAS TWO LEVELS. The grouping is imported from the
 * data layer rather than reimplemented here, for the reason `creditsRoleBand()`
 * gives about importing `groupByRole()`: a second copy would drift, and the
 * failure mode would be invisible. The Owner would arrange the panel one way and
 * the page would render another, with nothing in between reporting a problem.
 *
 * Each sub-team shows its resolved lead and says so. The hint under a team with
 * no tick is not nagging — it is the Owner being told the difference between "I
 * chose this person" and "the page picked the first row because I chose nobody",
 * which is the one piece of this feature the Owner cannot otherwise see.
 *
 * An empty sub-team is NOT rendered, and neither is an empty main heading.
 * "Nobody listed under Behind the Bylines" in a panel the Owner has simply not
 * filled in reads as a broken panel.
 *
 * @param {Array<object>} people
 * @param {string} category
 * @returns {string} '' when nobody is filed here
 */
function aboutCategorySection(people, category) {
  if (!people.length) return '';

  const { loose, groups } = groupBySubCategory(people);
  const colour =
    normaliseColour(people.find((person) => person.role_color)?.role_color) || DEFAULT_ROLE_COLOR;

  const subSection = (title, members, headingId) => {
    const { lead, designated } = resolveLead(members);
    return `
      <div class="credits-band-editor__sub">
        <span id="${escapeHtml(headingId)}">${escapeHtml(title)}</span>
        <span class="opacity-70">· ${members.length} ${
          members.length === 1 ? 'person' : 'people'
        } · lead: ${escapeHtml(lead?.name || '—')}${
          designated ? '' : ' (first by order)'
        }</span>
      </div>
      <ul class="space-y-4">
        ${members.map((person) => rosterPersonCard(person, 'about_us')).join('')}
      </ul>
    `;
  };

  return `
    <section class="credits-band-editor" style="--band:${colour}"
      data-about-section="${escapeHtml(category)}">
      <div class="credits-band-editor__head">
        <span class="credits-band-editor__name">${escapeHtml(category)}</span>
        <span class="credits-band-editor__count">
          ${people.length} ${people.length === 1 ? 'person' : 'people'}
        </span>
      </div>

      ${
        loose.length
          ? subSection('No sub-category', loose, `about-panel-${slugFor(category)}-loose`)
          : ''
      }
      ${groups
        .map((group) =>
          subSection(
            group.subCategory,
            group.people,
            `about-panel-${slugFor(category)}-${slugFor(group.subCategory)}`
          )
        )
        .join('')}
    </section>
  `;
}

/** An id-safe fragment from a heading. Mirrors `slug()` in lib/credits.js. */
function slugFor(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * One role band in the Credits editor: the role heading with its two move
 * buttons, and the editable cards for everyone holding that role.
 *
 * This is deliberately the SAME grouping the public page uses, imported rather
 * than reimplemented. A second copy would drift, and the failure mode would be
 * invisible: the Owner arranges the page one way, and it renders another.
 *
 * @param {{role: string, members: Array<object>}} band
 * @param {number} index
 * @param {number} total
 */
function creditsRoleBand(band, index, total) {
  const role = escapeHtml(band.role);
  const colour =
    normaliseColour(band.members.find((m) => m.role_color)?.role_color) || DEFAULT_ROLE_COLOR;

  return `
    <section class="credits-band-editor" style="--band:${colour}" data-credits-band="${role}">
      <div class="credits-band-editor__head">
        <span class="credits-band__rail" aria-hidden="true"></span>
        <span class="credits-band-editor__name">${role}</span>
        <span class="credits-band-editor__count">
          ${band.members.length} ${band.members.length === 1 ? 'person' : 'people'}
        </span>

        <span class="credits-band-editor__moves">
          <button type="button" class="btn btn-ghost"
            data-action="credits-role-up" data-role="${role}"
            ${index === 0 ? 'disabled' : ''}
            aria-label="Move the ${band.role} role up">
            <i class="fa-solid fa-arrow-up" aria-hidden="true"></i>
            <span class="sr-only">Move up</span>
          </button>
          <button type="button" class="btn btn-ghost"
            data-action="credits-role-down" data-role="${role}"
            ${index === total - 1 ? 'disabled' : ''}
            aria-label="Move the ${band.role} role down">
            <i class="fa-solid fa-arrow-down" aria-hidden="true"></i>
            <span class="sr-only">Move down</span>
          </button>
        </span>
      </div>

      <ul class="space-y-4">
        ${band.members.map((person) => rosterPersonCard(person, 'credits')).join('')}
      </ul>
    </section>
  `;
}

/**
 * One person's editable card.
 *
 * The FIELDS DEPEND ON THE PAGE, and that is the point of the split:
 *
 *   About Us  — Name, Main category, Sub-category, Role title, Set-as-Lead,
 *               Accent colour, One-line note, Display order (about_order), Photo.
 *   Credits   — Name, Sub-category, Credit role, Accent colour, Description,
 *               Display order (sort_order), Photo.
 *
 * "Main category" is a LABEL, not a column. The value written is
 * `credits_people.category`, which already stores exactly the two main headings
 * and is already CHECK-constrained to them; adding a second `main_category`
 * column would store one fact twice and give every read a question about which
 * copy wins.
 *
 * SUB-CATEGORY AND LEAD APPEAR ON BOTH TABS, on purpose. The Credits page groups
 * by role and renders neither, so they are inert there — but the columns exist
 * for both scopes and the Owner should not have to remember that a control they
 * can see on one tab is silently unavailable on the other.
 *
 * There is deliberately NO "appears under" select on either one any more. That
 * field is how a person used to be moved off one page by editing a card on the
 * other; the page you are editing decides the page, and the scope travels with
 * the save so the server can enforce it.
 *
 * The order field that is EDITED depends on the page — `about_order` on About Us,
 * `sort_order` on Credits — and BOTH values are always carried, so saving one
 * page cannot reset the other page's order. `data-roster-scope` is what the save
 * handler reads instead of a module variable.
 *
 * @param {object} person
 * @param {'about_us'|'credits'} scope
 */
function rosterPersonCard(person, scope) {
  const id = escapeHtml(person.id || '');
  const colour = normaliseColour(person.role_color) || DEFAULT_ROLE_COLOR;
  const name = escapeHtml(person.name || 'Unnamed');
  const onAbout = scope === 'about_us';
  const category = normaliseAboutCategory(person.category);
  const subCategory = normaliseSubCategory(person.sub_category);
  const isLead = person.is_lead === true || person.is_lead === 1 || person.is_lead === 'true';
  const order = onAbout ? Number(person.about_order) : Number(person.sort_order);
  const palette = rolePalette(person.role_color);

  return `
    <li class="panel-raised p-4" data-roster-row="${id}">
      <form class="space-y-3" data-credits-form="${id}"
        data-roster-scope="${onAbout ? 'about_us' : 'credits'}" novalidate>
        <div class="flex items-start gap-3">
          ${avatar(person, 56)}

          <div class="min-w-0 flex-1">
            <label class="field-label" for="credits-name-${id}">Name</label>
            <input id="credits-name-${id}" class="field" type="text" maxlength="80"
              data-credits-name value="${name}" />
          </div>

          <button type="button" class="btn btn-ghost shrink-0 text-rose-600"
            data-action="credits-remove" data-id="${id}"
            aria-label="Remove ${name} from the ${escapeHtml(scopeLabel(scope))} page">
            <i class="fa-solid fa-trash" aria-hidden="true"></i>
          </button>
        </div>

        <div class="grid gap-3 sm:grid-cols-2">
          <div>
            <label class="field-label" for="credits-role-${id}">
              ${onAbout ? 'Role title' : 'Credit / contribution'}
            </label>
            <input id="credits-role-${id}" class="field" type="text" maxlength="60"
              data-credits-role
              value="${escapeHtml(person.role_label || '')}"
              placeholder="${onAbout ? 'Assistant President/Coordinator' : 'Special Thanks'}" />
          </div>
          ${
            onAbout
              ? `<div>
                   <label class="field-label" for="credits-category-${id}">Main category</label>
                   <select id="credits-category-${id}" class="field" data-credits-category required>
                     ${ABOUT_CATEGORIES.map(
                       (option) =>
                         `<option value="${escapeHtml(option)}" ${
                           category === option ? 'selected' : ''
                         }>${escapeHtml(option)}</option>`
                     ).join('')}
                   </select>
                 </div>`
              : `<div>
                   <p class="field-label">Page</p>
                   <p class="field pointer-events-none opacity-70">Credits page</p>
                   <p class="mt-1 text-[0.6875rem] ink-muted">
                     Board members and writers are added on the About Us tab.
                   </p>
                 </div>`
          }
        </div>

        <div>
          <label class="field-label" for="credits-sub-${id}">Sub-category / department</label>
          <input id="credits-sub-${id}" class="field" type="text" maxlength="60"
            list="credits-sub-suggestions-${id}" data-credits-sub-category
            value="${escapeHtml(subCategory)}"
            placeholder="${onAbout ? 'Writers' : 'Photographers'}" />
          <datalist id="credits-sub-suggestions-${id}">
            ${subCategorySuggestions(subCategory).map(
              (option) => `<option value="${escapeHtml(option)}"></option>`
            ).join('')}
          </datalist>
          <p class="mt-1 text-[0.6875rem] ink-muted">
            Any team name you like — it becomes a heading on the page. Leave it
            empty and ${escapeHtml(
              onAbout ? 'this person sits under the main heading' : 'this person is filed by their credit'
            )} alone.
          </p>
        </div>

        <div>
          <label class="roster-lead" for="credits-lead-${id}">
            <input id="credits-lead-${id}" type="checkbox" data-credits-is-lead
              ${isLead ? 'checked' : ''} />
            <span>Set as Lead of this Sub-Category</span>
          </label>
          <p class="mt-1 text-[0.6875rem] ink-muted">
            One lead per sub-category. Ticking somebody else moves the lead; if
            nobody is ticked, the page shows the first person by display order.
          </p>
        </div>

        <div class="grid gap-3 sm:grid-cols-2">
          <div>
            <label class="field-label" for="credits-order-${id}">
              ${onAbout ? 'Order on the About Us page' : 'Order on the Credits page'}
            </label>
            <input id="credits-order-${id}" class="field" type="number" min="1"
              max="999" ${
                onAbout ? 'data-credits-about-order' : 'data-credits-order'
              } value="${Number(order) > 0 ? Number(order) : 100}" />
          </div>
          <p class="self-end text-[0.7rem] ink-muted">
            Lower numbers appear first. Each page is ordered on its own, so
            changing one does not move the person on the other.
          </p>
        </div>

        <div>
          <label class="field-label" for="credits-blurb-${id}">
            ${onAbout ? 'One-line note' : 'Description'}
          </label>
          <textarea id="credits-blurb-${id}" class="field" rows="2" maxlength="220"
            data-credits-blurb>${escapeHtml(person.blurb || '')}</textarea>
        </div>

        <div class="flex flex-wrap items-center gap-2">
          <input id="credits-color-${id}" type="color"
            class="h-10 w-12 shrink-0 cursor-pointer rounded-lg border
              border-ink/20 bg-transparent p-1"
            data-credits-color value="${colour}"
            aria-label="Accent colour for ${name}" />

          <span class="role-pill role-pill--preview"${palette ? paletteVars(palette) : ''}>
            ${escapeHtml(person.role_label || 'Contributor')}
          </span>

          <button type="button" class="btn btn-ghost"
            data-action="credits-copy-colour" data-target="credits-color-${id}"
            data-source="">
            <i class="fa-solid fa-copy" aria-hidden="true"></i> Copy accent colour
          </button>
        </div>

        <div class="pt-1">
          ${
            person.portrait_url
              ? `<button type="button" class="btn btn-ghost"
                  data-action="credits-clear-photo" data-id="${id}">
                  <i class="fa-solid fa-image-portrait" aria-hidden="true"></i>
                  Remove photo
                </button>`
              : `<label class="btn btn-ghost cursor-pointer">
                  <i class="fa-solid fa-camera" aria-hidden="true"></i> Add photo
                  <input type="file" class="sr-only" data-credits-photo
                    accept="image/jpeg,image/png,image/webp" />
                </label>`
          }
        </div>

        <button type="submit" class="btn btn-accent">
          <i class="fa-solid fa-floppy-disk" aria-hidden="true"></i> Save
        </button>
      </form>
    </li>
  `;
}

/**
 * The "add someone" form for one page.
 *
 * The two forms share a skeleton but ask different questions, because the pages
 * answer different ones. About Us must ask for a roster, because an About Us row
 * without a heading renders under nothing; Credits has no such field, and adding
 * one back as a disabled-looking dropdown would be the bleed returning in
 * disguise.
 *
 * @param {Array<object>} people  entries already on this page, for the datalist
 * @param {'about_us'|'credits'} scope
 */
function rosterAddForm(people, scope) {
  const onAbout = scope === 'about_us';
  const used = [...new Set(people.map((p) => p.role_label).filter(Boolean))];

  // Offered as suggestions only. The Credits page credits photographers,
  // patrons and a one-off school athletic association, none of which are staff
  // roles, so a fixed list would be wrong more often than it was right.
  const presets = [
    'Special Thanks',
    'Former Editor',
    'Lead Contributor',
    'Photographer',
    'Designer',
    'Patron'
  ];
  const suggestions = [...new Set([...used, ...(onAbout ? [] : presets)])];
  const subs = subCategorySuggestions(people);

  return `
    <form id="credits-add-form" class="panel-raised space-y-4 p-4"
      data-roster-scope="${onAbout ? 'about_us' : 'credits'}" novalidate>
      <div class="flex items-center gap-2">
        <i class="fa-solid fa-user-plus ink-accent" aria-hidden="true"></i>
        <h3 class="text-sm font-black tracking-tight">
          Add to the ${escapeHtml(scopeLabel(scope))} page
        </h3>
      </div>

      <div class="grid gap-3 sm:grid-cols-2">
        <div>
          <label class="field-label" for="credits-add-name">Name</label>
          <input id="credits-add-name" class="field" type="text" maxlength="80"
            placeholder="Amina Mohamed" required />
        </div>
        <div>
          <label class="field-label" for="credits-add-role">
            ${onAbout ? 'Role title' : 'Credit / contribution'}
          </label>
          <input id="credits-add-role" class="field" type="text" maxlength="60"
            list="credits-role-suggestions" required
            placeholder="${onAbout ? 'Assistant President/Coordinator' : 'Special Thanks'}" />
          <datalist id="credits-role-suggestions">
            ${suggestions.map((role) => `<option value="${escapeHtml(role)}"></option>`).join('')}
          </datalist>
          <p class="mt-1 text-[0.6875rem] ink-muted">
            ${
              onAbout
                ? 'Any wording you like. It does not have to match a staff role.'
                : 'Free text. These are suggestions, not a fixed list.'
            }
          </p>
        </div>
      </div>

      ${
        onAbout
          ? `<div>
               <label class="field-label" for="credits-add-category">Main category</label>
               <select id="credits-add-category" class="field" required>
                 ${ABOUT_CATEGORIES.map(
                   (option) => `<option value="${escapeHtml(option)}">${escapeHtml(option)}</option>`
                 ).join('')}
               </select>
               <p class="mt-1 text-[0.6875rem] ink-muted">
                 Board Members or Behind the Bylines. Everyone here appears on
                 About Us only — never on the Credits page.
               </p>
             </div>`
          : ''
      }

      <div>
        <label class="field-label" for="credits-add-sub">Sub-category / department</label>
        <input id="credits-add-sub" class="field" type="text" maxlength="60"
          list="credits-add-sub-suggestions" placeholder="Writers" />
        <datalist id="credits-add-sub-suggestions">
          ${subs.map((option) => `<option value="${escapeHtml(option)}"></option>`).join('')}
        </datalist>
        <p class="mt-1 text-[0.6875rem] ink-muted">
          Optional. Any team name becomes a sub-heading on the page; leave it empty
          and this person sits directly under the ${escapeHtml(
            onAbout ? 'main category' : 'Credits page'
          )}.
        </p>
      </div>

      <div>
        <label class="roster-lead" for="credits-add-lead">
          <input id="credits-add-lead" type="checkbox" data-credits-add-is-lead />
          <span>Set as Lead of this Sub-Category</span>
        </label>
        <p class="mt-1 text-[0.6875rem] ink-muted">
          Only one lead per sub-category. If you leave it unticked, the page shows
          the first person in that team by display order.
        </p>
      </div>

      <div class="grid gap-3 sm:grid-cols-2">
        <div>
          <label class="field-label" for="credits-add-photo">
            ${onAbout ? 'Photo' : 'Photo / avatar'}
          </label>
          <input id="credits-add-photo" class="field" type="file"
            accept="image/jpeg,image/png,image/webp" />
        </div>
        <div>
          <label class="field-label" for="credits-add-color">Accent colour</label>
          <div class="flex items-center gap-2">
            <input id="credits-add-color" type="color"
              class="h-11 w-14 shrink-0 cursor-pointer rounded-lg border
                border-ink/20 bg-transparent p-1"
              value="${DEFAULT_ROLE_COLOR}" />
            <button type="button" class="btn btn-ghost shrink-0"
              data-action="credits-copy-colour" data-target="credits-add-color"
              data-source="">
              <i class="fa-solid fa-copy" aria-hidden="true"></i> Copy accent colour
            </button>
          </div>
        </div>
      </div>

      <div>
        <label class="field-label" for="credits-add-order">Display order</label>
        <input id="credits-add-order" class="field" type="number" min="1"
          max="999" value="100"
          ${onAbout ? 'data-credits-about-order' : 'data-credits-order'} />
        <p class="mt-1 text-[0.6875rem] ink-muted">
          Lower numbers appear first, on this page only.
        </p>
      </div>

      <details class="text-xs">
        <summary class="cursor-pointer ink-muted">Or paste a photo URL</summary>
        <input id="credits-add-url" class="field mt-2" type="url"
          placeholder="https://example.com/photo.jpg" />
      </details>

      <div>
        <label class="field-label" for="credits-add-blurb">
          ${onAbout ? 'One-line note' : 'Description'}
        </label>
        <input id="credits-add-blurb" class="field" type="text" maxlength="300"
          placeholder="Covers local government and civic affairs." />
      </div>

      <button type="submit" class="btn btn-accent w-full sm:w-auto">
        <i class="fa-solid fa-plus" aria-hidden="true"></i>
        Add to ${escapeHtml(scopeLabel(scope))}
      </button>
    </form>
  `;
}

/**
 * Circular avatar for a roster card, falling back to initials.
 *
 * `safeUrl` rejects anything that is not an http(s) or data image, so a hostile
 * `portrait_url` cannot become a javascript: link.
 *
 * @param {{name: string, portrait_url: string}} person
 * @param {number} size  rendered edge in px
 */
function avatar(person, size) {
  const url = safeUrl(person.portrait_url);
  const style = `width:${size}px;height:${size}px`;

  if (url) {
    // escapeHtml on the URL too: safeUrl() accepts any root-relative path, and
    // a stored value like `/x" onerror="…` would otherwise break out of the
    // attribute. The initials branch below is what a MISSING url renders; this
    // branch is what a url that 404s falls back to.
    return `<img src="${escapeHtml(url)}" ${imageFallbackAttr()} alt="${escapeHtml(
      person.name || ''
    )}" loading="lazy"
      class="shrink-0 rounded-full object-cover" style="${style}" />`;
  }

  return `<span aria-hidden="true"
    class="grid shrink-0 place-items-center rounded-full bg-ink/10 font-black ink-muted"
    style="${style}">${escapeHtml(initialsOf(person.name))}</span>`;
}

/** First letters of the first and last name, e.g. "Amina Mohamed" -> "AM". */
function initialsOf(name) {
  const parts = String(name || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/* -------------------------------------------------------------------------- */
/* Changelog — Owner only                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The Owner's running record of what changed.
 *
 * Rendered straight from CHANGELOG.md, so this can never drift from the file in
 * the repository. Only the Owner sees this tab; other elevated roles can open
 * the Newsroom Panel but not read it.
 */
function renderChangelogTab() {
  const releases = getReleases();
  const outstanding = pendingCount();

  if (!releases.length) {
    return `
      <div class="space-y-5">
        ${panelHeader('Changelog', 'No entries yet')}
        ${emptyState('CHANGELOG.md has no releases in it yet.', 'fa-clock-rotate-left')}
      </div>
    `;
  }

  return `
    <div class="space-y-5">
      ${panelHeader(
        'Changelog',
        `Every change pushed to production${outstanding ? ` · ${outstanding} item${outstanding === 1 ? '' : 's'} still outstanding` : ' · nothing outstanding'}`
      )}

      ${
        outstanding
          ? `<div class="panel-raised border-l-4 border-l-[var(--color-newsred)] p-4">
               <p class="flex items-center gap-2 text-sm font-bold">
                 <i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>
                 Work is waiting on you
               </p>
               <p class="ink-muted mt-1 text-xs">
                 Items under <strong>Pending</strong> are built but not yet live.
                 They usually need a migration run in the Supabase SQL Editor.
               </p>
             </div>`
          : ''
      }

      ${releases
        .map(
          (release) => `
        <section class="space-y-4">
          <div class="rule-soft flex flex-wrap items-baseline gap-3 border-b pb-3">
            <h3 class="font-headline text-xl font-black tracking-wide uppercase">
              ${escapeHtml(release.version)}
            </h3>
            ${
              release.date
                ? `<span class="ink-muted text-xs">${escapeHtml(release.date)}</span>`
                : ''
            }
            ${
              release.version === 'Unreleased'
                ? '<span class="badge badge-amber">Not yet deployed</span>'
                : '<span class="badge badge-emerald">Live</span>'
            }
          </div>

          ${release.sections
            .map(
              (section) => `
            <div class="panel-raised p-5">
              <h4 class="font-headline flex items-center gap-2 text-sm font-bold tracking-wide uppercase">
                <i class="fa-solid ${sectionIcon(section.title)} ink-muted" aria-hidden="true"></i>
                ${escapeHtml(section.title)}
              </h4>
              <ul class="mt-3 space-y-2">
                ${section.items
                  .map(
                    (item) => `
                  <li class="flex gap-2 text-sm leading-relaxed">
                    <i class="fa-solid fa-circle-dot mt-1.5 shrink-0 text-[0.4rem] ink-muted"
                       aria-hidden="true"></i>
                    <span class="min-w-0">${inlineMarkdown(item)}</span>
                  </li>`
                  )
                  .join('')}
              </ul>
            </div>`
            )
            .join('')}
        </section>`
        )
        .join('')}

      <p class="ink-muted text-xs">
        Sourced from <code>CHANGELOG.md</code> in the repository. Edit that file
        and this panel updates with the next deploy — the two cannot fall out of
        step.
      </p>
    </div>
  `;
}

/**
 * Render the small amount of inline markdown the changelog actually uses:
 * `**bold**` and `` `code` ``. Everything is escaped first, so this can only
 * ever add emphasis — it can never introduce markup from the file.
 */
function inlineMarkdown(text) {
  return escapeHtml(text)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

/**
 * The workspace tabs, each tagged with the weakest role allowed to see it.
 *
 * `minRole` is checked against auth.roleAtLeast(), so a tab appears for its
 * role and for every role above it. `ownerOnly` is retained only where the gate
 * must be exactly the single Owner seat (Accounts, Security) rather than a
 * ranking — see visibleTabs().
 */
/* -------------------------------------------------------------------------- */
/* Podcasts — approvals (Owner) + submission (any staffer)                    */
/* -------------------------------------------------------------------------- */

/** The queue is fetched once per visit and re-fetched after every decision. */
let podcastQueue = null;

/**
 * THE WRITER VIEW OF THE PODCASTS TAB: submit, and see your own queue.
 *
 * Deliberately NOT the review queue. A Writer who can see pending episodes sees
 * who else filed what and can gauge the queue, which is not theirs to know; and
 * the Approve/Reject buttons would sit one click from a decision the database
 * refuses them anyway.
 *
 * The form is inline rather than in the Owner's dialog because this is the whole
 * tab: a panel whose only content is behind a "Upload" button is two clicks to do
 * the one thing the tab exists for.
 *
 * The success banner names who has to act and what happens next, because
 * "submitted successfully" alone leaves a writer wondering whether it is live.
 */
function podcastSubmitPanel() {
  return `
    <div class="space-y-5">
      ${panelHeader(
        'Submit a podcast',
        'Your episode is filed for review. It appears on the site once the Owner or a Board Manager approves it.',
        ''
      )}

      <p class="panel-sunken p-4 text-xs ink-muted">
        <i class="fa-solid fa-circle-info" aria-hidden="true"></i>
        Everything you file here starts as <strong>pending</strong>. You cannot
        approve your own episode, and neither can anyone else without the Owner or
        Board Manager seat � that is deliberate, and it is what stops an unreviewed
        recording going live by accident.
      </p>

      <form id="podcast-submit-form" class="panel-raised space-y-4 p-4" novalidate>
        <div class="grid gap-3 sm:grid-cols-2">
          <div>
            <label class="field-label" for="podcast-sub-title">Title</label>
            <input id="podcast-sub-title" class="field" type="text" maxlength="120" required />
          </div>
          <div>
            <label class="field-label" for="podcast-sub-host">Speaker / host name</label>
            <input id="podcast-sub-host" class="field" type="text" maxlength="80"
              placeholder="Defaults to your name" />
          </div>
        </div>

        <div>
          <label class="field-label" for="podcast-sub-description">Description</label>
          <textarea id="podcast-sub-description" class="field" rows="3"
            maxlength="${PODCAST_DESCRIPTION_LIMIT}"></textarea>
          <p class="mt-1 text-[0.6875rem] ink-muted">
            <span data-podcast-sub-count>0</span>/${PODCAST_DESCRIPTION_LIMIT} characters.
          </p>
        </div>

        <div class="grid gap-3 sm:grid-cols-2">
          <div>
            <label class="field-label" for="podcast-sub-file">Audio file</label>
            <input id="podcast-sub-file" class="field" type="file" accept=".mp3,audio/mpeg" />
            <p class="mt-1 text-[0.6875rem] ink-muted">
              MP3, up to 25 MB. The length is worked out from the file.
            </p>
          </div>
          <div>
            <label class="field-label" for="podcast-sub-audio-url">�or an audio link</label>
            <input id="podcast-sub-audio-url" class="field" type="url"
              placeholder="https://example.com/episode.mp3" />
            <p class="mt-1 text-[0.6875rem] ink-muted">
              Use one or the other. A link is useful when the audio is not on this device.
            </p>
          </div>
        </div>

        <div>
          <label class="field-label" for="podcast-sub-cover">Cover image URL</label>
          <input id="podcast-sub-cover" class="field" type="url"
            placeholder="https://example.com/cover.jpg" />
          <p class="mt-1 text-[0.6875rem] ink-muted">
            Optional. Left empty the card renders without artwork.
          </p>
        </div>

        <button type="submit" class="btn btn-accent w-full sm:w-auto">
          <i class="fa-solid fa-paper-plane" aria-hidden="true"></i> Submit for review
        </button>
      </form>

      <p class="panel-sunken p-4 text-xs ink-muted">
        <i class="fa-solid fa-hourglass-half" aria-hidden="true"></i>
        You will see the episode on the public podcast page only after it is
        approved. Nothing here is published the moment you press submit.
      </p>
    </div>
  `;
}

/**
 * The Owner's podcast manager: upload, review, edit, delete.
 *
 * This tab is the ONLY place podcasts are managed. It used to be reachable only
 * as a submission form sitting on the Interviews tab, which read as though
 * uploading an episode filed it as an interview -- the two are separate tables
 * with separate approval flows, and the Owner's own upload belongs here beside
 * the queue it skips.
 */
function renderPodcastsTab() {
const body = byId('admin-tab-body');
    if (!body) return '';

    /*
      WRITERS GET A SUBMIT-ONLY VIEW, NOT AN EMPTY ONE.

      This tab used to be `ownerOnly` and returned a lock message for anyone
      else, so a Writer could not file an episode at all -- which is why the door
      for that was on the Interviews tab. The brief asks Writers to submit, and
      the database has permitted it all along: `podcasts_staff_submit` allows any
      staffer to insert, and pins status = 'pending' so a crafted request cannot
      self-approve. Nothing server-side was blocking this; only the tab was.

      What a Writer is NOT given, and this is the whole point:

        - the review queue (Owner and Board Manager see it)
        - Approve / Reject on anything, including their own
        - the role-band reordering, which is a front-page layout control
        - delete on anybody's episode

      So the tab is `minRole: 'Writer'` in TABS and this function branches on
      role. Hiding the queue is not enforcement -- podcasts_owner_all and
      podcasts_delete still require their own checks -- it just stops a Writer
      being offered a decision they cannot make.
    */
    const canReview = store.canApprove();

    if (!canReview) {
      // A Writer's tab is submit-only. `podcastSubmitPanel` is a full replacement,
      // not a panel above the queue, because the queue itself must not be in the
      // document for someone who has no business reading it.
      return podcastSubmitPanel();
    }

    if (podcastQueue) return podcastQueuePanel(podcastQueue);

  // Two reads, run together: the approval queue and everything already
  // published. An Owner needs to see both at once -- approving something while
  // unable to find the episode they published last week is the failure mode of
  // two separate screens.
  Promise.all([listPendingPodcasts(), listPodcasts()])
    .then(([pending, published]) => {
      podcastQueue = { pending, published };
      if (!body.isConnected || body.dataset.tab !== 'podcasts') return;
      body.innerHTML = podcastQueuePanel(podcastQueue);
    })
    .catch((error) => {
      console.warn('[admin] podcasts tab failed to load', error);
      if (!body.isConnected) return;
      body.innerHTML = `
        <div class="panel-raised p-6 text-sm">
          <p class="flex items-center gap-2 font-bold">
            <i class="fa-solid fa-triangle-exclamation ink-muted" aria-hidden="true"></i>
            The podcast list could not be loaded
          </p>
          <p class="ink-muted mt-2">
            Run <code>supabase/migrations/024_about_podcasts_and_layout.sql</code> in the
            Supabase SQL Editor, then reopen this tab.
          </p>
        </div>`;
    });

  return `<div class="panel-sunken p-10 text-center">
    <i class="fa-solid fa-circle-notch spin-slow ink-muted text-xl" aria-hidden="true"></i>
    <p class="ink-muted mt-3 text-sm">Loading podcasts…</p>
  </div>`;
}

function podcastQueuePanel({ pending, published }) {
  return `
    <div class="space-y-6">
      ${panelHeader(
        'Podcasts',
        `${pending.length} waiting on you · ${published.length} published`,
        `<div class="flex flex-wrap gap-2">
           <button class="btn btn-accent" data-action="podcast-upload">
             <i class="fa-solid fa-upload" aria-hidden="true"></i> Upload an episode
           </button>
           <a class="btn btn-ghost" href="#podcasts" data-nav="podcasts">
             <i class="fa-solid fa-eye" aria-hidden="true"></i> Preview page
           </a>
         </div>`
      )}

      <p class="panel-sunken p-4 text-xs ink-muted">
        <i class="fa-solid fa-circle-info" aria-hidden="true"></i>
        An episode you upload here is <strong>published immediately</strong> — you are
        the Owner, so there is nobody left to approve it. Episodes a
        <strong>writer</strong> files arrive in the queue below and stay off the public
        page until you approve them. Refusing or deleting purges the MP3 from storage.
      </p>

      <section aria-labelledby="podcast-upload-heading">
        <h3 id="podcast-upload-heading" class="mb-3 text-sm font-black tracking-tight">
          Waiting for approval
        </h3>
        ${
          pending.length
            ? `<ul class="space-y-4">${pending.map(podcastQueueRow).join('')}</ul>`
            : emptyState('No episode is waiting for approval.', 'fa-headphones')
        }
      </section>

      <section aria-labelledby="podcast-live-heading">
        <h3 id="podcast-live-heading" class="mb-3 text-sm font-black tracking-tight">
          Published episodes
        </h3>
        ${
          published.length
            ? `<ul class="space-y-4">${published.map(podcastLiveRow).join('')}</ul>`
            : emptyState('Nothing published yet. Upload the first episode above.', 'fa-circle-play')
        }
      </section>
    </div>
  `;
}

function podcastQueueRow(episode) {
  const id = escapeHtml(episode.id || '');
  const title = escapeHtml(episode.title || 'Untitled episode');
  const playable = Boolean(episode.audio_url);
  const submitted = episode.created_at
    ? new Date(episode.created_at).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric'
      })
    : 'recently';

  return `
    <li class="panel-raised p-4" data-podcast-row="${id}">
      <div class="flex flex-wrap items-start gap-3">
        <div class="min-w-0 flex-1">
          <p class="font-headline text-base font-bold">${title}</p>
          <p class="ink-muted mt-1 text-xs">
            ${escapeHtml(episode.author_name || 'A contributor')}
            &#8226; submitted ${escapeHtml(submitted)}
            ${
              Number.isFinite(episode.duration_seconds)
                ? `&#8226; ${escapeHtml(podcastDuration(episode.duration_seconds))}`
                : ''
            }
          </p>
          ${
            episode.description
              ? `<p class="mt-2 text-sm">${escapeHtml(episode.description)}</p>`
              : ''
          }
        </div>

        <div class="flex shrink-0 gap-2">
          <button type="button" class="btn btn-accent" data-action="podcast-approve"
            data-id="${id}">
            <i class="fa-solid fa-check" aria-hidden="true"></i> Approve
          </button>
          <button type="button" class="btn btn-ghost text-rose-600"
            data-action="podcast-reject" data-id="${id}" data-title="${title}">
            <i class="fa-solid fa-trash" aria-hidden="true"></i> Refuse
          </button>
        </div>
      </div>

      ${
        playable
          ? `<audio class="podcast-card__audio mt-3" controls preload="metadata"
              src="${escapeHtml(episode.audio_url)}"></audio>`
          : `<p class="mt-3 text-sm ink-muted">
               <i class="fa-solid fa-triangle-exclamation me-2" aria-hidden="true"></i>
               No audio file is attached to this submission, so there is nothing
               to listen to. Refusing it will simply remove the record.
             </p>`
      }
    </li>
  `;
}

/** `M:SS` for the panel. The public page has its own, richer, formatter. */
function podcastDuration(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * A published episode, with its text editable in place.
 *
 * The form is per-row rather than behind an "edit" click so the Owner can fix a
 * typo without a modal round trip, and Save is disabled until something actually
 * changed -- the same reason the layout Save is: a button that is always live
 * teaches people to ignore it.
 *
 * The AUDIO is deliberately not editable here. Swapping the file would orphan the
 * old object in the bucket, and the row cannot tell which object is live
 * without a second write. Replacing audio means publishing a new episode.
 */
function podcastLiveRow(episode) {
  const id = escapeHtml(episode.id || '');
  const title = escapeHtml(episode.title || 'Untitled episode');
  const description = escapeHtml(episode.description || '');
  const published = episode.created_at
    ? new Date(episode.created_at).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric'
      })
    : 'recently';

  return `
    <li class="panel-raised p-4" data-podcast-row="${id}">
      <form class="space-y-3" data-podcast-edit-form="${id}" novalidate>
        <div class="flex flex-wrap items-start gap-3">
          <div class="min-w-0 flex-1">
            <label class="field-label" for="podcast-edit-title-${id}">Title</label>
            <input id="podcast-edit-title-${id}" class="field" type="text"
              maxlength="120" data-podcast-edit-title value="${title}" />
          </div>
          <div class="min-w-0 flex-1">
            <label class="field-label" for="podcast-edit-author-${id}">Author</label>
            <input id="podcast-edit-author-${id}" class="field" type="text"
              maxlength="80" data-podcast-edit-author
              value="${escapeHtml(episode.author_name || 'The Pulse Staff')}" />
          </div>
        </div>

        <div>
          <label class="field-label" for="podcast-edit-desc-${id}">Description</label>
          <textarea id="podcast-edit-desc-${id}" class="field" rows="2"
            maxlength="${PODCAST_DESCRIPTION_LIMIT}"
            data-podcast-edit-desc>${description}</textarea>
        </div>

        <p class="ink-muted text-xs">
          ${escapeHtml(episode.author_name || 'The Pulse Staff')} &#8226;
          published ${escapeHtml(published)}
          ${
            Number.isFinite(episode.duration_seconds)
              ? `&#8226; ${escapeHtml(podcastDuration(episode.duration_seconds))}`
              : ''
          }
        </p>

        ${
          episode.audio_url
            ? `<audio class="podcast-card__audio" controls preload="metadata"
                src="${escapeHtml(episode.audio_url)}"></audio>`
            : ''
        }

        <div class="flex flex-wrap items-center gap-2">
          <!-- No data-action here on purpose. This is a plain submit control:
               the form branch in the delegated submit listener is the route that
               saves it, and a data-action with no matching handler reads as a
               delegated button that was wired up and then lost its route. -->
          <button type="submit" class="btn btn-accent">
            <i class="fa-solid fa-floppy-disk" aria-hidden="true"></i> Save changes
          </button>
          <button type="button" class="btn btn-ghost text-rose-600"
            data-action="podcast-delete" data-id="${id}" data-title="${title}">
            <i class="fa-solid fa-trash" aria-hidden="true"></i> Delete
          </button>
          <span class="ink-muted text-[0.7rem]">
            Deleting also purges the MP3 from storage.
          </span>
        </div>
      </form>
    </li>
  `;
}

/** The Owner's direct-upload dialog. Publishes on submit; never queues. */
function podcastUploadDialog() {
  return `
    <div
      id="podcast-upload"
      class="modal-backdrop hidden"
      role="dialog"
      aria-modal="true"
      aria-labelledby="podcast-upload-title"
    >
      <div class="modal-card relative w-full max-w-lg p-6">
        <button
          type="button"
          class="btn-quiet absolute top-4 right-4"
          data-close-dialog="podcast-upload"
          aria-label="Close"
        >
          <i class="fa-solid fa-xmark" aria-hidden="true"></i>
        </button>

        <h3 id="podcast-upload-title" class="font-headline text-xl font-black tracking-wide uppercase">
          Upload an episode
        </h3>
        <p class="ink-muted mt-2 text-xs">
          This publishes immediately. Writers' submissions arrive in the queue below
          instead.
        </p>

        <form id="podcast-upload-form" class="mt-4 space-y-3" novalidate>
          <div>
            <label class="field-label" for="podcast-up-title">Episode title</label>
            <input id="podcast-up-title" class="field" type="text" maxlength="120" required />
          </div>

          <div>
            <label class="field-label" for="podcast-up-description">
              One-line description
            </label>
            <textarea id="podcast-up-description" class="field" rows="2"
              maxlength="${PODCAST_DESCRIPTION_LIMIT}"></textarea>
            <p class="mt-1 text-[0.6875rem] ink-muted">
              <span data-podcast-up-count>0</span>/${PODCAST_DESCRIPTION_LIMIT} characters.
            </p>
          </div>

          <div>
            <label class="field-label" for="podcast-up-host">Speaker / host name</label>
            <input id="podcast-up-host" class="field" type="text" maxlength="80"
              placeholder="Defaults to your name" />
            <p class="mt-1 text-[0.6875rem] ink-muted">
              Whoever the episode is about. This is the byline readers see, so use a
              guest's name when they are not you.
            </p>
          </div>

          <div>
            <label class="field-label" for="podcast-up-file">MP3 file</label>
            <input id="podcast-up-file" class="field" type="file" accept=".mp3,audio/mpeg" />
            <p class="mt-1 text-[0.6875rem] ink-muted" data-podcast-up-note>
              MP3 only, up to 25 MB. The length is worked out from the file.
            </p>
          </div>

          <div>
            <label class="field-label" for="podcast-up-cover">Cover image URL</label>
            <input id="podcast-up-cover" class="field" type="url"
              placeholder="https://example.com/cover.jpg" />
            <p class="mt-1 text-[0.6875rem] ink-muted">
              Artwork for the episode card. The same field the Writer's submission
              form offers -- without it, an episode published here and the same
              episode filed by a Writer looked like two different episodes.
            </p>
          </div>

          <div class="flex justify-end gap-2 pt-2">
            <button type="button" class="btn btn-ghost" data-close-dialog="podcast-upload">
              Cancel
            </button>
            <button type="submit" class="btn btn-accent">
              <i class="fa-solid fa-upload" aria-hidden="true"></i> Publish
            </button>
          </div>
        </form>
      </div>
    </div>
  `;
}

async function openPodcastUpload() {
  // Pre-flight the bucket before the dialog opens, so a misconfigured bucket is
  // reported here rather than after the Owner has picked a 25 MB file.
  const ready = await checkPodcastStorage();
  if (!ready.ok) {
    showToast(ready.message, { type: 'error', duration: 12000 });
    return;
  }

  byId('podcast-up-title').value = '';
  byId('podcast-up-description').value = '';
  byId('podcast-up-file').value = '';
  const note = byId('podcast-upload')?.querySelector('[data-podcast-up-note]');
  if (note) {
    note.classList.remove('text-rose-600');
    note.textContent = 'MP3 only, up to 25 MB. The length is worked out from the file.';
  }
  openDialog('podcast-upload', { initialFocus: '#podcast-up-title' });
}

/**
 * A WRITER files an episode for review.
 *
 * Separate from `savePodcastUploadFromForm()`, which is the Owner's dialog and
 * publishes straight to 'approved'. Keeping them apart is deliberate: this is the
 * path a Writer can reach, and it must not be possible to widen it by passing a
 * parameter into a shared handler.
 *
 * `submitPodcast()` in src/lib/podcasts.js always writes status = 'pending', and
 * the INSERT policy pins that independently, so "publish straight through" is not
 * reachable from here even by editing this function.
 *
 * @param {HTMLFormElement} form
 */
async function submitPodcastFromWriterForm(form) {
  const title = byId('podcast-sub-title')?.value.trim() || '';
  if (!title) {
    showToast('Give the episode a title.', { type: 'error' });
    byId('podcast-sub-title')?.focus();
    return;
  }

  const file = byId('podcast-sub-file')?.files?.[0] || null;
  const audioUrl = byId('podcast-sub-audio-url')?.value.trim() || '';

  if (!file && !audioUrl) {
    showToast('Choose an MP3 or paste a link to the audio.', { type: 'error' });
    return;
  }

  const result = await submitPodcast({
    title,
    description: byId('podcast-sub-description')?.value.trim() || '',
    file,
    audioUrl,
    // `podcast-sub-host` was rendered by this form from the beginning and never
    // read. `podcasts.author_name` IS the public byline, so this is where a
    // guest's name goes -- a podcast about somebody the writer did not record.
    authorName: byId('podcast-sub-host')?.value.trim() || '',
    coverUrl: byId('podcast-sub-cover')?.value.trim() || ''
  });

  if (!result.ok) {
    showToast(result.message, { type: 'error' });
    return;
  }

  form.reset();
  showToast(
    'Podcast submitted successfully and is awaiting Owner/Board Manager approval.',
    { type: 'success', duration: 8000 }
  );
  paintActiveTab();
}

async function savePodcastUploadFromForm() {
  const title = byId('podcast-up-title')?.value.trim() || '';
  const description = byId('podcast-up-description')?.value.trim() || '';
  const file = byId('podcast-up-file')?.files?.[0];

  if (!title) {
    showToast('Give the episode a title.', { type: 'error' });
    return;
  }
  if (!file) {
    showToast('Choose an MP3 to upload.', { type: 'error' });
    return;
  }

  const busy = showToast('Uploading the episode…', { type: 'info', duration: 0 });
  try {
    const durationSeconds = await readAudioDuration(file);
    const result = await publishPodcast({
      title,
      description,
      file,
      durationSeconds,
      authorName: byId('podcast-up-host')?.value.trim() || '',
      coverUrl: byId('podcast-up-cover')?.value.trim() || ''
    });

    if (!result.ok) {
      showToast(result.message, { type: 'error', duration: 12000 });
      return;
    }

    closeDialog('podcast-upload');
    podcastQueue = null;
    showToast(`"${title}" is published.`, { type: 'success' });
    paintActiveTab();
  } finally {
    busy.remove();
  }
}

async function savePodcastEditFromForm(form) {
  const id = form.dataset.podcastEditForm;
  if (!id) return;

  const result = await updatePodcastText(id, {
    title: form.querySelector('[data-podcast-edit-title]')?.value.trim() ?? '',
    authorName: form.querySelector('[data-podcast-edit-author]')?.value.trim() ?? '',
    description: form.querySelector('[data-podcast-edit-desc]')?.value.trim() ?? ''
  });

  if (!result.ok) {
    showToast(result.message, { type: 'error' });
    return;
  }

  podcastQueue = null;
  showToast('Episode updated.', { type: 'success' });
  paintActiveTab();
}

/**
 * Read an MP3's duration with the browser's own decoder.
 *
 * No library, and no frame parsing: an off-DOM <audio> pointed at an object URL
 * reports `duration` from `loadedmetadata`. The object is revoked in a `finally`,
 * because leaking one per submission would pin the whole file in memory for the
 * life of the tab.
 *
 * @returns {Promise<number|null>} whole seconds, or null when it cannot be read
 */
function readAudioDuration(file) {
  return new Promise((resolve) => {
    let url = null;
    let audio = null;
    try {
      url = URL.createObjectURL(file);
      audio = new Audio();
      audio.preload = 'metadata';
      audio.addEventListener('loadedmetadata', () => {
        const seconds = Number(audio.duration);
        resolve(Number.isFinite(seconds) ? Math.round(seconds) : null);
      });
      audio.addEventListener('error', () => resolve(null));
      // A file the browser cannot decode has no duration to show, but it is still
      // worth submitting if the server accepts it -- so this resolves null rather
      // than rejecting, and the form says the duration is unknown.
      setTimeout(() => resolve(null), 8000);
      audio.src = url;
    } catch {
      resolve(null);
    } finally {
      // Deliberately NOT revoking here: `loadedmetadata` has not fired yet, and
      // revoking now would abort the very read this is waiting on. The timeout
      // below revokes once the read has settled.
      setTimeout(() => {
        if (url) URL.revokeObjectURL(url);
      }, 9000);
    }
  });
}

/**
 * The writer's submission dialog.
 *
 * Reachable from the Content tab, which every staffer can open. It is NOT on the
 * Podcasts tab: that tab is Owner-only, so a writer would have no door at all --
 * and putting the form on the Interviews tab, as it briefly was, made an episode
 * look like it was filing as an interview. Neither table is the other.
 */
function podcastEditorDialog() {
  return `
    <div
      id="podcast-editor"
      class="modal-backdrop hidden"
      role="dialog"
      aria-modal="true"
      aria-labelledby="podcast-editor-title"
    >
      <div class="modal-card relative w-full max-w-lg p-6">
        <button
          type="button"
          class="btn-quiet absolute top-4 right-4"
          data-close-dialog="podcast-editor"
          aria-label="Close"
        >
          <i class="fa-solid fa-xmark" aria-hidden="true"></i>
        </button>

        <h3 id="podcast-editor-title" class="font-headline text-xl font-black tracking-wide uppercase">
          Submit a podcast
        </h3>

        <form id="podcast-form" class="mt-4 space-y-3" novalidate>
          <div>
            <label class="field-label" for="podcast-title">Episode title</label>
            <input id="podcast-title" class="field" type="text" maxlength="120" required />
          </div>

          <div>
            <label class="field-label" for="podcast-description">
              One-line description
            </label>
            <textarea id="podcast-description" class="field" rows="2"
              maxlength="${PODCAST_DESCRIPTION_LIMIT}" required></textarea>
            <p class="mt-1 text-[0.6875rem] ink-muted">
              <span data-podcast-count>0</span>/${PODCAST_DESCRIPTION_LIMIT} characters.
            </p>
          </div>

          <div>
            <label class="field-label" for="podcast-file">MP3 file</label>
            <input id="podcast-file" class="field" type="file" accept=".mp3,audio/mpeg" />
            <p class="mt-1 text-[0.6875rem] ink-muted" data-podcast-duration>
              MP3 only, up to 25 MB. The length is worked out from the file.
            </p>
          </div>

          <div class="flex justify-end gap-2 pt-2">
            <button type="button" class="btn btn-ghost" data-close-dialog="podcast-editor">
              Cancel
            </button>
            <button type="submit" class="btn btn-accent">
              <i class="fa-solid fa-paper-plane" aria-hidden="true"></i> Submit
            </button>
          </div>
        </form>
      </div>
    </div>
  `;
}

/** The description limit lives in one place, imported rather than retyped. */
const PODCAST_DESCRIPTION_LIMIT = MAX_DESCRIPTION;

function openPodcastEditor() {
  const title = byId('podcast-title');
  if (title) title.value = '';
  const description = byId('podcast-description');
  if (description) description.value = '';
  const file = byId('podcast-file');
  if (file) file.value = '';
  const note = byId('podcast-editor')?.querySelector('[data-podcast-duration]');
  if (note) {
    note.textContent = 'MP3 only, up to 25 MB. The length is worked out from the file.';
  }
  openDialog('podcast-editor', { initialFocus: '#podcast-title' });
}

async function savePodcastFromForm(form) {
  const title = byId('podcast-title')?.value.trim() || '';
  const description = byId('podcast-description')?.value.trim() || '';
  const file = byId('podcast-file')?.files?.[0];

  if (!title) {
    showToast('Give the episode a title.', { type: 'error' });
    return;
  }
  if (description.length > PODCAST_DESCRIPTION_LIMIT) {
    showToast(
      `The description is ${description.length} characters. The limit is ${PODCAST_DESCRIPTION_LIMIT}.`,
      { type: 'error' }
    );
    return;
  }

  const busy = showToast('Uploading the episode…', { type: 'info', duration: 0 });
  try {
    // Read the duration BEFORE uploading: it costs a local file read, so doing it
    // first means the wait is spent on the upload that actually needs the network.
    const durationSeconds = file ? await readAudioDuration(file) : null;

    const result = await submitPodcast({ title, description, file, durationSeconds });

    if (!result.ok) {
      showToast(result.message || 'The episode could not be submitted.', {
        type: 'error',
        duration: 8000
      });
      return;
    }

    closeDialog('podcast-editor');
    podcastQueue = null;
    showToast('Submitted. It is waiting on the Owner to approve it.', { type: 'success' });
  } finally {
    busy.remove();
  }
}

import {
  listPendingPodcasts,
  listPodcasts,
  decidePodcast,
  submitPodcast,
  publishPodcast,
  updatePodcastText,
  deletePodcast,
  checkPodcastStorage,
  describeStorageError,
  validateAudioFile,
  MAX_DESCRIPTION
} from '../lib/podcasts.js';

/**
 * Every tab the Newsroom Panel offers, with the role that can see it.
 *
 * `ownerOnly` means the gate must be exactly the single Owner seat rather than a
 * ranking -- see visibleTabs().
 */
const TABS = [
  { id: 'overview', label: 'Overview', icon: 'fa-gauge-high', render: renderOverview, minRole: 'Writer' },
  { id: 'content', label: 'Content', icon: 'fa-newspaper', render: renderContent, minRole: 'Writer' },
  { id: 'interviews', label: 'Interviews', icon: 'fa-circle-play', render: renderInterviewsTab, minRole: 'Writer' },
  // The submission queue is open to any staffer, but the DECISION is not: a tab a
  // writer can open but not act in is a dead end, so the gate is the Owner seat
  // and not a role ranking.
  /*
    OPEN TO WRITERS, SUBMIT-ONLY.

    This was `ownerOnly`, so a Writer saw a lock message and could not file an
    episode at all. The database has permitted staff submissions all along --
    `podcasts_staff_submit` allows any staffer to insert and pins status='pending'
    so the row cannot self-approve -- so only the tab was in the way.

    `renderPodcastsTab` branches on `canApprove()`: a Writer gets the submission
    form and no review queue. A Board Manager now gets the queue too, which is the
    approver tier from migration 030.

    The "approve" decision is Owner or Board Manager and nothing else: no tab
    change grants a Writer the queue, and podcasts_delete still needs the Owner
    seat.
  */
  { id: 'podcasts', label: 'Podcasts', icon: 'fa-headphones', render: renderPodcastsTab, minRole: 'Writer' },
  { id: 'accounts', label: 'Accounts', icon: 'fa-user-check', render: renderAccountsTab, ownerOnly: true },
  /*
    Assignments is BOARD MANAGER, not Writer.

    It was minRole 'Writer', so a Writer could open the assignment board and
    create, reassign and close other people's work. The brief is explicit that a
    Writer cannot manage assignments, and the board is a management surface, not
    a filing surface: it decides who owes what.

    This is a ROLE change on the tab, not a new gate. TABS already filters by
    minRole, and tests/roles.mjs walks every tab for every role, so the change is
    visible in the next suite run rather than needing a new test.
  */
  { id: 'assignments', label: 'Assignments', icon: 'fa-clipboard-list', render: renderAssignmentsTab, minRole: 'Board Manager' },
  { id: 'breaking', label: 'Breaking', icon: 'fa-bolt', render: renderBreakingTab, minRole: 'Board Manager' },
  { id: 'broadcasts', label: 'Broadcasts', icon: 'fa-paper-plane', render: renderBroadcastsTab, minRole: 'Board Manager' },
  { id: 'curation', label: 'Curation', icon: 'fa-star', render: renderCurationTab, minRole: 'Board Manager' },
  { id: 'staff', label: 'Staff', icon: 'fa-users', render: renderStaffTab, minRole: 'Board Manager' },
  // Owner only, and TWO tabs rather than one with a filter above it. About Us and
  // Credits are separate pages with separate purposes, `page_scope` decides which
  // page a row is on, and the database refuses a row whose category contradicts
  // its scope. A view filter over one shared list made all three of those things
  // editable from the wrong page.
  { id: 'about', label: 'About Us', icon: 'fa-address-book', render: renderAboutTab, ownerOnly: true },
  // The Credits page is a hand-curated public page, not a view of the staff
  // roster: anybody the Owner chooses to list appears, and nobody listed by an
  // account gets in automatically. A Board Manager must not be able to add or
  // remove names from it.
  { id: 'credits', label: 'Credits', icon: 'fa-id-badge', render: renderCreditsTab, ownerOnly: true },
  { id: 'changelog', label: 'Changelog', icon: 'fa-clock-rotate-left', render: renderChangelogTab, ownerOnly: true },
  { id: 'branding', label: 'Branding', icon: 'fa-font', render: renderBrandingTab, ownerOnly: true },
  { id: 'media', label: 'Media', icon: 'fa-images', render: renderMediaTab, minRole: 'Writer' },
  { id: 'security', label: 'Security', icon: 'fa-shield-halved', render: renderSecurityTab, ownerOnly: true }
];

/**
 * The tabs this session may actually see.
 *
 * A tab is dropped unless the signed-in account satisfies its `minRole`, and
 * `ownerOnly` tabs are additionally reserved for the single Owner seat. Every
 * consumer reads this list rather than TABS itself, so a gated tab is absent
 * from the nav, unreachable via selectTab(), and never rendered — there is no
 * separate check anywhere to forget. That is the fix for Editors previously
 * walking straight into the Newsroom Panel.
 */
function visibleTabs() {
  const owner = isOwner();
  const role = currentRole();
  return TABS.filter((tab) => {
    if (tab.ownerOnly) return owner;
    return roleAtLeast(role, tab.minRole || 'Writer');
  });
}

/** The workspace name this role sees. Not every account is the Owner. */
function workspaceTitle() {
  if (isOwner()) return 'Newsroom Panel';
  if (roleAtLeast(currentRole(), 'Board Manager')) return 'Board Manager Desk';
  return 'Writer Desk';
}

/** Repaint the active tab and sync the tab buttons. */
function paintActiveTab() {
  const body = byId('admin-tab-body');
  if (!body) return;

  const tabs = visibleTabs();
  const tab = tabs.find((entry) => entry.id === activeTab) || tabs[0];

  // Tabs that load data asynchronously (Credits) check this before painting a
  // late response, so it must be stamped for every tab, not just that one.
  body.dataset.tab = tab.id;
  body.innerHTML = tab.render();
  body.classList.remove('animate-rise');
  void body.offsetWidth; // restart the entrance animation
  body.classList.add('animate-rise');

  document.querySelectorAll('[data-admin-tab]').forEach((button) => {
    const isActive = button.dataset.adminTab === activeTab;
    button.setAttribute('aria-current', isActive ? 'page' : 'false');
    button.classList.toggle('is-active', isActive);
  });

  // The tab body is re-rendered wholesale, so the file inputs are brand new
  // elements and their listeners must be re-attached on every paint. Guarded
  // by `dataset.bound` so a re-render of the same node cannot double-bind.
  bindFilePickers();

  // Same story for the layout list's drag handlers. `wireLayoutDrag` guards
  // itself, and it is safe to call on every tab: it finds nothing outside the
  // Content desk.
  wireLayoutDrag();
}

/** Attach the device-upload pickers to whatever is currently on screen. */
function bindFilePickers() {
  const pairs = [
    ['media-file', 'media-url'],
    ['article-image-file', 'article-image'],
    // The interview poster picker. Without this pair the file input rendered but
    // carried no listener, so choosing a photo from the device did nothing at
    // all -- while the "paste an image URL" text box beside it saved normally,
    // which makes the field look half-broken rather than missing. Same dead
    // control class as the interview video Add button.
    ['interview-image-file', 'interview-image']
  ];

  pairs.forEach(([fileId, urlId]) => {
    const fileInput = byId(fileId);
    const urlInput = byId(urlId);
    if (!fileInput || !urlInput) return;
    if (fileInput.dataset.bound === 'true') return;
    fileInput.dataset.bound = 'true';
    bindImagePicker(fileInput, urlInput);
  });
/*
    THE WRITER PODCAST PAIR IS AUDIO, NOT IMAGE, so it does not go through
    bindImagePicker: that helper UPLOADS the chosen file to storage and writes the
    resulting URL into the text box, which is right for a poster image and wrong
    for an MP3 -- the episode's audio is uploaded at submit time, not at pick time,
    and an image upload pipeline would reject the file.

    What the pair actually needs is mutual exclusion. Picking a file and keeping
    a pasted URL is a contradiction the form has to resolve one way or the other,
    and silently preferring one is how a writer ends up submitting the wrong
    episode. Choosing either clears the other, so the submitted audio is always
    the one they last pointed at.
  */
  const podcastFile = byId('podcast-sub-file');
  const podcastUrl = byId('podcast-sub-audio-url');
  if (podcastFile && podcastUrl && podcastFile.dataset.bound !== 'true') {
    podcastFile.dataset.bound = 'true';
    podcastFile.addEventListener('change', () => {
      if (podcastFile.files?.length) podcastUrl.value = '';
    });
    podcastUrl.addEventListener('input', () => {
      if (podcastUrl.value.trim()) podcastFile.value = '';
    });
  }

  // The supporting-photo picker is bound separately because it is a multi-file
  // input feeding the thumbnail strip, not a file+URL pair: bindImagePicker
  // writes one uploaded URL into a text input, which is the wrong shape here.
  const extraInput = byId('article-extra-file');
  if (extraInput && extraInput.dataset.bound !== 'true') {
    extraInput.dataset.bound = 'true';
    extraInput.addEventListener('change', async () => {
      const files = [...extraInput.files].slice(
        0,
        Math.max(0, MAX_ARTICLE_PHOTOS - articleExtras.length)
      );
      extraInput.value = '';
      if (!files.length) {
        showToast(
          articleExtras.length >= MAX_ARTICLE_PHOTOS
            ? `That is the ${MAX_ARTICLE_PHOTOS}-photo limit. Remove one first.`
            : 'Choose at least one photo.',
          { type: 'error' }
        );
        return;
      }

      const busy = showToast(`Uploading ${files.length} photo(s)...`, {
        type: 'info',
        duration: 0
      });
      const { uploaded, failed } = await uploadImages(files, {
        onProgress: (done, total) =>
          busy.setMessage(`Uploading photo ${done} of ${total}...`)
      });
      busy.remove();

      addArticleExtras(uploaded.map((item) => item.url));
      if (failed.length) {
        showToast(`${failed.length} photo(s) failed: ${failed[0].reason}`, {
          type: 'error'
        });
      }
    });
  }
}

/** Switch tabs, guarding against an unknown id. */
export function selectTab(tabId) {
  if (!visibleTabs().some((tab) => tab.id === tabId)) return;
  // Leaving the Security tab must disarm the reset, so a later click on the
  // plain button can never silently skip the confirmation step.
  if (tabId !== 'security') resetArmed = false;
  activeTab = tabId;
  paintActiveTab();
}
/* -------------------------------------------------------------------------- */
/* Shell                                                                       */
/* -------------------------------------------------------------------------- */

/** Full-page markup for the Newsroom Panel. */
function shellMarkup() {
  const tabButtons = visibleTabs().map(
    (tab) => `
      <button
        class="admin-tab"
        data-admin-tab="${tab.id}"
        aria-current="false"
      >
        <i class="fa-solid ${tab.icon}" aria-hidden="true"></i>
        <span>${escapeHtml(tab.label)}</span>
      </button>`
  ).join('');

  return `
    <div id="admin-root" class="admin-shell">
      <header class="admin-topbar no-print">
        <div class="admin-topbar__left">
          <span class="badge badge-live">
            <i class="fa-solid fa-lock" aria-hidden="true"></i> Newsroom Panel
          </span>
          <button class="btn btn-ghost" data-action="close-admin">
            <i class="fa-solid fa-arrow-left" aria-hidden="true"></i> Back to site
          </button>
        </div>
        <div class="admin-topbar__right">
          <button class="btn btn-ghost" data-action="sign-out">
            <i class="fa-solid fa-right-from-bracket" aria-hidden="true"></i> Sign out
          </button>
        </div>
      </header>

      <div class="admin-layout">
        <nav class="admin-nav no-print" aria-label="Workspace sections">
          <!--
          The tab strip lives in its own element so the stylesheet can make it a
          single horizontally-scrolling row on a phone. Without this wrapper the
          tabs are direct children of a block-level <nav> and stack full-width,
          which pushed the panel content off-screen.
          -->
          <div class="admin-nav__list" role="tablist">${tabButtons}</div>
        </nav>
        <main id="admin-tab-body" class="admin-body" tabindex="-1"></main>
      </div>

      ${articleEditorDialog()}
      ${interviewEditorDialog()}
      ${staffEditorDialog()}
      ${podcastEditorDialog()}
      ${podcastUploadDialog()}
      ${assignmentEditorDialog()}
      ${passwordResetDialog()}
      ${galleryCategoryPickerDialog()}
    </div>
  `;
}

/* -------------------------------------------------------------------------- */
/* Shell mount / unmount                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Open the workspace. Refuses to mount for non-admins, so a visitor can never
 * reach admin UI by any route — not by hash, not by devtools, not by a stale
 * render. Every call re-checks `isAdmin()` first.
 */
export function openAdmin() {
  if (!isAdmin()) {
    showToast('You do not have access to the Newsroom Panel.', {
      type: 'error'
    });
    return false;
  }

  const host = byId('admin-view');
  if (!host) return false;

  if (isMounted) {
    paintActiveTab();
    return true;
  }

  /*
  Close any viewer/dialog the Owner left open on the public site before the panel
  mounts. The gallery lightbox is a body-level `.modal-backdrop` at z-index 60 and
  the panel's own dialogs also live at 60, so a lightbox that survived the switch
  would sit over the workspace with no way to reach the control that closes it.
  Closing it here means the panel never has to out-z-index a stale overlay.
  */
  if (isOpen('lightbox')) closeDialog('lightbox');

  host.innerHTML = shellMarkup();
  host.classList.remove('hidden');
  host.classList.add('admin-mode');
  rememberReaderView();
  // Hide every reader view by class as well as by CSS. The CSS alone only sets
  // `visibility`, which the smoke test (correctly) does not accept as "hidden",
  // and an explicit class also stops the views from being measured or painted.
  //
  // Selected by `[data-reader-view]`, NOT by a list of ids. This list used to be
  // written out by hand and #interviews-view was missing from it, so opening the
  // panel from the Interviews feed left the feed on screen and stacked under the
  // panel headers. The attribute is the single source of truth, shared with
  // showReaderView() in app.js and the body.admin-active rule in styles.css.
  document.querySelectorAll('[data-reader-view]').forEach((view) => {
    view.classList.add('hidden');
    // An inline `display` outranks every stylesheet rule, so a view left with
    // one by any earlier code path would stay visible through the class alone.
    view.style.removeProperty('display');
  });
  document.body.classList.add('admin-active');
  isMounted = true;

  /*
    The workspace is a full-screen app shell that must be scrollable, so clear
    any modal scroll lock still registered from the sign-in dialog. Without this
    the shell inherited a stale `overflow: hidden` and the page could not be
    scrolled at all on Android.
  */
  releaseDialogLocks();

  attachAdminListeners();

  // Repaint the active tab whenever the store changes, so a write made in one
  // tab is reflected everywhere (and on the public site) immediately.
  unsubscribeStore = store.subscribe(() => {
    if (isMounted) paintActiveTab();
  });

  paintActiveTab();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  return true;
}

/**
 * Remember which reader view the Owner was looking at, so closeAdmin() restores
 * that one instead of always snapping back to the publication view. Without this,
 * closing the panel after opening it from the gallery dropped them on the front
 * page — which read as "the gallery closed itself".
 *
 * The CSS hides every reader view with `visibility: hidden` while the panel is
 * mounted, so nothing needs to be removed here; we only need to know which one to
 * bring back afterwards.
 */
function rememberReaderView() {
  const views = [...document.querySelectorAll('[data-reader-view]')];
  lastReaderView =
    views.find((el) => !el.classList.contains('hidden'))?.id || 'publication-view';
}

/** Tear the workspace down and restore the public site. */
export function closeAdmin() {
  if (!isMounted) return;

  resetArmed = false;
  unsubscribeStore?.();
  unsubscribeStore = null;
  isMounted = false;

  const host = byId('admin-view');
  if (host) {
    host.innerHTML = '';
    host.classList.add('hidden');
    host.classList.remove('admin-mode');
  }

  // Restore exactly the view the Owner came from. Every other reader view stays
  // hidden, so the panel can never leave two views stacked behind it. Selecting
  // by attribute keeps a newly added reader view covered here automatically.
  document.querySelectorAll('[data-reader-view]').forEach((view) => {
    view.classList.toggle('hidden', view.id !== lastReaderView);
    view.style.removeProperty('display');
  });
  lastReaderView = 'publication-view';
  document.body.classList.remove('admin-active');
  window.scrollTo({ top: 0, behavior: 'auto' });

  // Settings edited inside the workspace bypass the store's repaint (it skips
  // work while the workspace is open), so nudge the public site to catch up.
  window.dispatchEvent(new Event('wire:settings-changed'));
}

/** True while the Newsroom Panel is on screen. */
export function isAdminOpen() {
  return isMounted;
}

/* -------------------------------------------------------------------------- */
/* Delegated event handling                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Attach the delegated listeners the workspace needs. Guarded so re-opening the
 * Newsroom Panel never stacks duplicate handlers.
 *
 * A single `click` listener on the document handles every `data-action` button,
 * so tabs and dialogs rendered after mount are covered automatically.
 */
function attachAdminListeners() {
  if (listenersAttached) return;
  listenersAttached = true;

  document.addEventListener('click', handleClick);

  // Forms inside the three editor dialogs.
  document.addEventListener('submit', (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;

    if (form.id === 'article-form') {
      event.preventDefault();
      guard(() => saveArticleFromForm(form));
    } else if (form.id === 'interview-form') {
      // Without this branch the dialog did a native GET submit and reloaded the
      // page, so saving an interview looked like it worked and then discarded
      // every field. The handler existed; nothing routed to it.
      event.preventDefault();
      guard(() => saveInterviewFromForm(form));
    } else if (form.id === 'staff-form') {
      event.preventDefault();
      guard(() => saveStaffFromForm(form));
    } else if (form.id === 'podcast-form') {
      event.preventDefault();
      guard(() => savePodcastFromForm(form));
    } else if (form.id === 'podcast-upload-form') {
      event.preventDefault();
      guard(() => savePodcastUploadFromForm());
    } else if (form.id === 'podcast-submit-form') {
      // The WRITER's own submission, a different function from
      // savePodcastUploadFromForm() and not a flag on it: the Owner's dialog
      // publishes straight to 'approved', and the one path a Writer can reach
      // must not be widenable by adding a parameter to a shared handler.
      event.preventDefault();
      guard(() => submitPodcastFromWriterForm(form));
    } else if (form.dataset.podcastEditForm) {
      event.preventDefault();
      guard(() => savePodcastEditFromForm(form));
    } else if (form.id === 'assignment-form') {
      event.preventDefault();
      guard(() => saveAssignmentFromForm(form));
    } else if (form.id === 'breaking-form') {
      // The banner switches autosave on `change`, but the text fields only
      // commit when this form is actually submitted.
      event.preventDefault();
      guard(() => saveBreakingFromForm(form));
    } else if (form.id === 'broadcast-form') {
      event.preventDefault();
      guard(() => sendBroadcastFromForm(form));
    } else if (form.id === 'media-form') {
      event.preventDefault();
      guard(() => saveMediaFromForm(form));
    } else if (form.id === 'branding-form') {
      // The masthead fields carry no `change` handler, so without this branch
      // the Save button did a full page submit and silently reloaded.
      event.preventDefault();
      guard(() => saveBrandingFromForm(form));
    } else if (form.id === 'account-password-form') {
      event.preventDefault();
      guard(() => savePasswordFromForm(form));
    } else if (form.dataset.creditsForm) {
      // One form per person on the Credits tab, identified by the row id.
      event.preventDefault();
      guard(() => saveCreditsFromForm(form));
    } else if (form.id === 'credits-add-form') {
      event.preventDefault();
      guard(() => addCreditsPersonFromForm(form));
    } else if (form.id === 'gallery-category-form') {
      // Without this branch the form did a native GET submit and reloaded the
      // page, so adding a category looked like it worked and then silently
      // discarded the input. The handler existed; nothing routed to it.
      event.preventDefault();
      guard(() => saveGalleryCategoryFromForm(form));
    } else if (form.id === 'curation-form') {
      // The Curation tab's Save button. With no branch here the click fell
      // through to the browser's native GET submit: the page reloaded before
      // any save promise could resolve, the Owner's new arrangement was
      // discarded, and the front page never re-sorted.
      event.preventDefault();
      guard(() => saveCurationFromForm(form));
    }
  });

  // The article editor's own file input is NOT a submit button, so it never
  // reaches the delegated submit listener above. Bind it once here, lazily,
  // when the editor dialog is first opened.

  // "Keep me signed in"-style switches and inline selects.
  document.addEventListener('change', (event) => handleChange(event));

  /*
   * Enter in the YouTube box stages the video instead of saving the interview.
   *
   * The dialog's own help text promises "Press Enter to add", so the key has to
   * behave that way rather than quietly submitting the form and saving a
   * half-written interview. preventDefault() is what stops the submit; without
   * it the delegated submit listener above would save on every keystroke-batch.
   *
   * `!isComposing` guards the IME case: Enter is the confirmation key while
   * choosing candidates, and consuming it there would strand the writer.
   */
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.isComposing) return;
    const field = event.target;
    if (!(field instanceof HTMLElement) || field.id !== 'interview-video-url') return;
    event.preventDefault();
    if (stageInterviewVideo(field.value)) field.focus();
  });

  // The "Specific User" picker: filter the roster as the Owner types. `input`
  // rather than `change`, because `change` only fires on blur and the list
  // would never narrow while typing.
  document.addEventListener('input', (event) => {
    const field = event.target;
    if (!(field instanceof HTMLElement) || field.id !== 'broadcast-target') return;
    renderBroadcastTargetResults(field.value);
  });

  // Picking a row is a click, not a submit or a change, so the delegated submit
  // listener never sees it. `closest` covers the row and its inner spans.
  document.addEventListener('click', (event) => {
    const option = event.target instanceof Element
      ? event.target.closest('[data-target-id]')
      : null;
    if (!option) return;
    chooseBroadcastTarget(option.dataset.targetId, option.dataset.targetLabel);
  });
}

/* -------------------------------------------------------------------------- */
/* Form persistence                                                            */
/* -------------------------------------------------------------------------- */

/** CREATE or UPDATE an article from the editor dialog. */
/* --------------------------------------------------------------------------
   Supporting photos: up to MAX_ARTICLE_PHOTOS besides the lead image.
   -------------------------------------------------------------------------- */

/**
 * The authoritative list for the open editor. Module state rather than DOM
 * state, because the two inputs contribute differently: the file picker
 * uploads to URLs, the text field is typed URLs, and the thumbnails can be
 * reordered or deleted. Reading the truth back out of the DOM meant the
 * indices shown on the remove buttons could drift from the array being saved.
 */
let articleExtras = [];

/** Thumbnails of the extras already attached, drawn under the two inputs. */
function renderArticleExtraPreview() {
  const box = byId('article-extra-preview');
  if (!box) return;
  box.innerHTML = articleExtras
    .map(
      (url, i) => `
      <span class="relative inline-block">
        <img
          src="${escapeHtml(url)}"
          ${imageFallbackAttr(BLANK_IMAGE)}
          alt="Supporting photo ${i + 1}"
          class="h-16 w-16 rounded border border-ink object-cover"
          loading="lazy"
        />
        <button
          type="button"
          class="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-ink text-[10px] text-paper"
          aria-label="Remove supporting photo ${i + 1}"
          data-action="article-extra-remove"
          data-index="${i}"
        >&times;</button>
      </span>`
    )
    .join('');
}

/**
 * Merge freshly uploaded and freshly pasted URLs into the list, de-duplicated
 * and capped. Returns false (with a toast) if the cap would be exceeded, so
 * the writer is told rather than silently losing photos.
 */
function addArticleExtras(urls) {
  const fresh = urls.filter(Boolean);
  const merged = [...new Set([...articleExtras, ...fresh])];
  if (merged.length > MAX_ARTICLE_PHOTOS) {
    showToast(
      `Up to ${MAX_ARTICLE_PHOTOS} supporting photos per article. ${merged.length - MAX_ARTICLE_PHOTOS} were left out.`,
      { type: 'error' }
    );
  }
  articleExtras = merged.slice(0, MAX_ARTICLE_PHOTOS);
  renderArticleExtraPreview();
  return articleExtras.length;
}

/** Reset when the editor opens, so one article's photos never leak into the next. */
function setArticleExtras(urls) {
  articleExtras = [...new Set(urls.filter(Boolean))].slice(0, MAX_ARTICLE_PHOTOS);
  renderArticleExtraPreview();
}

/** URLs pasted into the text field, split on commas. */
function typedArticleExtraUrls() {
  return (byId('article-extra-url')?.value ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Push a "new article" alert to every opted-in device.
 *
 * The link is a hash anchor because this is a single-page site with no slug
 * router: `public.js` renders each card as `#article-<id>` on `/`, so the
 * service worker's notificationclick can navigate straight to the story.
 *
 * `summary` is the article's own text, trimmed to a single line. Push
 * notifications cannot wrap, so a full body would be truncated by the OS at an
 * arbitrary point; the fallback sentence is used when there is nothing usable.
 *
 * Fire and forget: the caller has already saved the article, so a push failure
 * is logged and otherwise ignored rather than surfaced as a failed publish.
 */
function notifyReadersOfArticle(article, body = '') {
  const excerpt = String(body || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140);

  push
    .dispatchWebPush({
      title: article.title,
      body: excerpt || 'A new article has just been published on The Pulse!',
      audience: 'Everyone',
      url: `/#article-${encodeURIComponent(article.id)}`
    })
    .then((result) => {
      console.log('[push] article announced', {
        id: article.id,
        delivered: result?.delivered ?? 0,
        reason: result?.reason || 'ok'
      });
    })
    .catch((error) => {
      console.warn('[push] article announcement failed', error);
    });
}

async function saveArticleFromForm(form) {
  // If the editor chose a file but had not finished the upload, finish it here
  // so an article is never saved with a blank image after they hit Save.
  const pending = byId('article-image-file')?.files?.[0];
  if (pending && !byId('article-image')?.value) {
    const busy = showToast('Uploading your image first...', {
      type: 'info',
      duration: 0
    });
    try {
      const { url } = await uploadImage(pending);
      byId('article-image').value = url;
    } catch (error) {
      busy.remove();
      showToast(error.message || 'Image upload failed.', { type: 'error' });
      return;
    }
    busy.remove();
  }

  // Supporting photos. The picker uploads here rather than at pick time so an
  // article is never saved with a half-finished multi-file upload, and so the
  // MAX_ARTICLE_PHOTOS cap is applied against what actually landed.
  const extraFiles = [...(byId('article-extra-file')?.files ?? [])];
  if (extraFiles.length) {
    const busy = showToast(
      `Uploading ${extraFiles.length} supporting photo(s)...`,
      { type: 'info', duration: 0 }
    );
    const { uploaded, failed } = await uploadImages(extraFiles, {
      onProgress: (done, total) =>
        busy.setMessage?.(`Uploading supporting photos ${done} of ${total}...`)
    });
    busy.remove();

    addArticleExtras(uploaded.map((item) => item.url));
    if (failed.length) {
      showToast(
        `${failed.length} photo(s) failed to upload: ${failed[0].reason}`,
        { type: 'error' }
      );
    }
    byId('article-extra-file').value = '';
  }

  // Pasted URLs count too, and dedupe against what is already attached.
  addArticleExtras(typedArticleExtraUrls());
  if (byId('article-extra-url')) byId('article-extra-url').value = '';

  const payload = {
    title: byId('article-title').value,
    author: byId('article-author').value,
    category: byId('article-category').value,
    status: byId('article-status').value,
    date: byId('article-date').value,
    image: byId('article-image').value.trim(),
    extraImages: articleExtras,
    caption: byId('article-caption').value,
    body: byId('article-body').value,
    featured: byId('article-featured').checked
  };

  if (!payload.title.trim()) {
    showToast('Every dispatch needs a headline.', { type: 'error' });
    byId('article-title').focus();
    return;
  }

  // Whether this save puts a story in front of readers, and whether it is doing
  // so for the first time. Re-saving a published article must not re-notify
  // everyone on every typo fix, so the trigger is the published *transition*.
  const goingLive = payload.status === 'Published';
  const wasAlreadyLive =
    Boolean(editingArticleId) &&
    store.getState().articles.some(
      (a) => a.id === editingArticleId && a.status === 'Published'
    );

  let saved = null;
  if (editingArticleId) {
    saved = await store.updateArticle(editingArticleId, payload);
    showToast('Article updated.', { type: 'success' });
  } else {
    saved = await store.createArticle(payload);
    showToast('Article created and added to the desk.', { type: 'success' });
  }

  // Announce the story. Failures here are deliberately swallowed: the article is
  // already saved, and a push that did not go out must not turn a successful
  // publish into a reported error.
  if (goingLive && !wasAlreadyLive && saved?.id) {
    notifyReadersOfArticle(saved, payload.body);
  }

  editingArticleId = null;
  closeDialog('article-editor');
  paintActiveTab();
}

/** CREATE or UPDATE a staff record from the editor dialog. */
async function saveStaffFromForm(form) {
  const payload = {
    name: byId('staff-name').value,
    username: byId('staff-username').value,
    email: byId('staff-email').value,
    role: byId('staff-role').value
  };

  // The status is the one field a save must never invent. This dialog is opened
  // and saved constantly -- to attach a portrait, to fix a typo in a name -- and
  // `status` was read straight off the <select>. A select assigned a value that
  // matches none of its options reports '', so any row whose stored status was
  // not exactly 'Active' or 'Suspended' (the column has no CHECK constraint, so
  // 'active' survives happily) had its status BLANKED by an unrelated save: the
  // row stopped being 'Active', which is what staff_credits_page() and every
  // byline filter on, so the staffer vanished from the public roster.
  //
  // So: write the dropdown's value only when it is one of STAFF_STATUSES, and
  // otherwise leave the key out of the patch entirely. `updateStaff` only writes
  // the columns it is given, so an absent key preserves whatever is stored.
  const chosenStatus = normaliseStaffStatus(byId('staff-status').value);
  if (chosenStatus) payload.status = chosenStatus;

  if (!payload.name.trim() || !payload.username.trim()) {
    showToast('A staffer needs at least a name and a username.', {
      type: 'error'
    });
    return;
  }

  // A portrait is mandatory for a new hire: it is what identifies their bylines
  // and credits entry. Editing an existing record may leave the field untouched,
  // so only the create path demands one.
  const isNew = !editingStaffId;
  const urlField = byId('staff-portrait-url');
  const pendingFile = byId('staff-portrait-file')?.files?.[0];

  if (isNew && !pendingFile && !urlField.value.trim()) {
    showToast('Add a portrait — it appears with everything they publish.', {
      type: 'error'
    });
    return;
  }

  let portraitUrl = urlField.value.trim();
  if (pendingFile) {
    const busy = showToast('Uploading the portrait…', { type: 'info', duration: 0 });
    try {
      // Square it first. Storing the raw upload left the portrait in
      // whatever shape it arrived, and the credits grid then centre-cropped it
      // with object-fit: cover -- which cuts the head off a wide photo and
      // leaves a band of background on a tall one. Every portrait in the
      // database is now the same 512 square, whichever route it came in by.
      const squared = new File([await squareUpImage(pendingFile)], "portrait.jpg", {
        type: "image/jpeg"
      });
      const { url, isLocal } = await uploadImage(squared);
      portraitUrl = url;
      busy.remove();
      if (isLocal) {
        showToast('Storage is offline, so the portrait stayed in this browser.', {
          type: 'info'
        });
      }
    } catch (error) {
      busy.remove();
      showToast(error.message || 'Portrait upload failed.', { type: 'error' });
      return;
    }
  }

  let member;
  if (editingStaffId) {
    member = await store.updateStaff(editingStaffId, payload);
    if (member && portraitUrl) {
      const result = await assignPortrait(editingStaffId, portraitUrl);
      if (!result.ok) showToast(result.message, { type: 'error' });
    }
    showToast('Staff record updated.', { type: 'success' });
  } else {
    member = await store.createStaff(payload);

    // Attach the portrait to the row the database just gave us. Without the id
    // returned by createStaff there is nothing to attach it to.
    if (member?.id && portraitUrl) {
      const result = await assignPortrait(member.id, portraitUrl);
      if (result.ok) {
        showToast('Staffer added, with portrait.', { type: 'success' });
      } else {
        showToast(`Staffer added, but the portrait failed: ${result.message}`, {
          type: 'error',
          duration: 6000
        });
      }
    } else {
      showToast('Staffer added, but no portrait was saved.', { type: 'error' });
    }

    // Keep the byline stickers in step without a page reload.
    await primePortraits();
  }

  editingStaffId = null;
  closeDialog('staff-editor');
  creditsPeople = null;
  paintActiveTab();
}

/**
 * Add one or more images to the shared shelf.
 *
 * The file input is `multiple`, so a writer can select a whole shoot at once.
 * `uploadImages` returns a result per file rather than throwing on the first
 * bad one: one unsupported file in a selection of twenty must not discard the
 * other nineteen. Failures are counted and reported, and the successes are
 * still saved.
 */
async function saveMediaFromForm(form) {
  const urlField = byId('media-url');
  const files = Array.from(byId('media-file')?.files || []);
  const caption = captionText(byId('media-caption')?.value);
  const categoryId = byId('media-category')?.value.trim() || '';

  // ---- Batch path: several files chosen at once ----
  if (files.length > 1) {
    const busy = showToast(`Uploading ${files.length} images...`, {
      type: 'info',
      duration: 0
    });
    const results = await uploadImages(files);
    busy.remove();

    let added = 0;
    let failed = 0;
    for (let i = 0; i < results.length; i += 1) {
      const result = results[i];
      if (!result?.url) {
        failed += 1;
        continue;
      }
      // Only the first image takes the typed caption; the rest get a numbered
      // one so a batch is not a wall of identical text in the gallery.
      const suffix = added > 0 ? ` (${added + 1})` : '';
      await store.createMedia({
        url: result.url,
        caption: `${caption}${suffix}`,
        categoryId
      });
      added += 1;
    }

    form.reset();
    if (added) {
      showToast(
        `Added ${added} image${added === 1 ? '' : 's'} to the media shelf.` +
          (failed ? ` ${failed} could not be uploaded.` : ''),
        { type: failed ? 'info' : 'success' }
      );
    } else {
      showToast('None of those images could be uploaded.', { type: 'error' });
    }
    return;
  }

  // ---- Single path: one file, or a pasted URL ----
  const pending = files[0];
  let url = urlField?.value.trim() || '';

  if (pending) {
    const busy = showToast('Uploading your image...', { type: 'info', duration: 0 });
    try {
      const result = await uploadImage(pending);
      url = result.url;
      busy.remove();
      if (result.isLocal) {
        showToast('Storage is offline, so the image stayed in this browser.', {
          type: 'info'
        });
      }
    } catch (error) {
      busy.remove();
      showToast(error.message || 'Image upload failed.', { type: 'error' });
      return;
    }
  }

  if (!url) {
    showToast('Choose a file from your device, or paste an image URL.', {
      type: 'error'
    });
    return;
  }

  await store.createMedia({ url, caption, categoryId });

  form.reset();
  showToast('Image added to the media shelf.', { type: 'success' });
}

/**
 * Create a gallery category. Owner-only: the server function refuses anyone
 * else, and the form is not rendered for them.
 */
async function saveGalleryCategoryFromForm(form) {
  const field = byId('gallery-category-name');
  const name = field?.value.trim() || '';

  if (!name) {
    showToast('Give the category a name first.', { type: 'error' });
    field?.focus();
    return;
  }

  await store.createGalleryCategory({ name });
  form.reset();
  showToast(`"${name}" added to the gallery.`, { type: 'success' });
  // Repaint so the new chip appears in the list AND in the media form's
  // category dropdown. Without this the save succeeded invisibly.
  paintActiveTab();
}

/**
 * Convert a Date into the exact string `datetime-local` expects:
 * `YYYY-MM-DDTHH:mm`, in the browser's LOCAL time.
 *
 * Two traps this avoids:
 *   - `.toISOString()` is UTC, so a London afternoon picked as 14:00 would be
 *     written as 13:00 (or worse, 15:00 in Nairobi) and silently shift the
 *     deadline by the UTC offset.
 *   - The value has no seconds and no zone marker; assigning that verbatim to a
 *     date input is invalid and the browser rejects it, blanking the field.
 */
function toDateTimeLocalValue(date) {
  if (!date || Number.isNaN(date.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/**
 * The human-readable deadline the public board renders.
 *
 * The board shows this string (`deadline`), while the cron compares `due_at`.
 * Storing a raw "2026-04-18T17:00" in the display column would put machine
 * syntax in front of readers, so the two are deliberately formatted differently.
 */
function formatDeadlineForBoard(dueAt) {
  if (!dueAt) return '';
  const date = new Date(dueAt);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short'
  });
}

/** CREATE or UPDATE an assignment from the editor dialog. */
async function saveAssignmentFromForm(form) {
  // The picker yields an exact instant, so there is no free text left to parse
  // and no way to enter something unreadable. `new Date('YYYY-MM-DDTHH:mm')` is
  // specified as LOCAL time, which is what we want: it is the same wall clock
  // the Owner just picked, not a UTC-shifted version of it.
  const picked = byId('assignment-deadline').value;
  const parsed = picked ? new Date(picked) : null;
  const dueAt = parsed && Number.isNaN(parsed.getTime()) ? null : parsed?.toISOString();

  if (picked && Number.isNaN(parsed.getTime())) {
    showToast('That deadline could not be read. Re-pick it in the calendar.', {
      type: 'error'
    });
    return;
  }

  const payload = {
    title: byId('assignment-title').value,
    reporter: byId('assignment-reporter').value,
    status: byId('assignment-status').value,
    // The board renders `deadline`, so it gets a formatted string; the cron
    // compares `due_at`, which stays the exact UTC instant.
    deadline: dueAt ? formatDeadlineForBoard(dueAt) : '',
    assigned_to: byId('assignment-assigned-to')?.value || null,
    due_at: dueAt
  };

  if (!payload.title.trim()) {
    showToast('Give the pitch a title before saving.', { type: 'error' });
    return;
  }

  // Warn rather than refuse: an owner may legitimately leave a piece unassigned.
  // Without an assignee the deadline is still tracked, just never pushed.
  if (!payload.assigned_to && payload.due_at) {
    showToast(
      'Saved, but nobody is assigned, so no deadline reminder will be sent.',
      { type: 'info' }
    );
  }

  const saved = editingAssignmentId
    ? await store.updateAssignment(editingAssignmentId, payload)
    : await store.createAssignment(payload);

  // Read the value back off the row we just wrote rather than reporting success
  // from the payload we intended to write. `createAssignment`/`updateAssignment`
  // return the stored object, so this catches a column that silently failed to
  // persist - the exact failure that made this look like "the picker reset
  // itself" when in fact the write was being dropped.
  if (payload.assigned_to && saved?.assigned_to !== payload.assigned_to) {
    console.warn('[admin] assigned_to did not persist', {
      expected: payload.assigned_to,
      got: saved?.assigned_to ?? null
    });
    showToast(
      'Saved, but the assignee did not stick. If the roster list is empty, check that Supabase migration 021 has been run.',
      { type: 'error' }
    );
  } else {
    showToast(
      editingAssignmentId ? 'Assignment updated.' : 'Assignment published to the board.',
      { type: 'success' }
    );
  }

  editingAssignmentId = null;
  closeDialog('assignment-editor');
  paintActiveTab();
}

/**
 * Non-button form controls: the breaking-news editor, the broadcast composer,
 * the curation selects, the branding form and the notification switches.
 */
function handleChange(event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;

  /* --- Broadcast audience -> reveal the "Specific User" picker ------------
     This is the only thing that reveals #broadcast-target-wrap. Without it the
     picker stays `hidden` for good and the Owner has no way to aim a
     broadcast, even though the option is in the dropdown. */
  if (target.id === 'broadcast-audience') {
    syncBroadcastTargetVisibility(target.value);
    if (target.value === 'Specific User') {
      prepareBroadcastTarget().catch((error) =>
        console.warn('[admin] could not load the staff directory', error)
      );
    }
    return;
  }

  /* --- Breaking news banner --------------------------------------------- */
  if (target.id === 'breaking-enabled') {
    guard(async () => {
      await store.saveBreakingNews({ enabled: target.checked });
      paintActiveTab();
    });
    return;
  }
  // `breaking-sticky` and `breaking-dismissible` used to autosave here. Those
  // toggles are gone from the form, so the branch was unreachable; removed
  // rather than left as dead code that looks like it still works.
  if (target.id === 'breaking-severity' || target.id === 'breaking-color') {
    guard(async () => {
      await store.saveBreakingNews({ [target.id.replace('breaking-', '')]: target.value });
      paintActiveTab();
    });
    return;
  }

  // The swatch mirrors into the hex box as it is dragged. It must not save on
  // its own: a native colour picker fires `input` continuously while the Owner
  // is still choosing, so persisting here would write dozens of half-picked
  // colours. The hex field it updates is saved by Save banner instead.
  if (target.id === 'breaking-color-picker') {
    const hex = byId('breaking-color');
    if (hex) hex.value = target.value;
    return;
  }

  /* --- Curation ---------------------------------------------------------- */
  if (target.id === 'curation-show-week') {
    guard(async () => {
      await store.saveCuration({ showThisWeek: target.checked });
      paintActiveTab();
    });
    return;
  }

  // The select branches below used to key off `curate-todays-pick` /
  // `curate-slot-*` ids that the renderer stopped emitting long ago, so NO
  // change on this tab ever reached the store from here. `data-slot` is the
  // attribute renderCurationTab actually stamps on every select; routing on it
  // keeps the handler and the renderer from drifting apart again behind a
  // silent id string.
  if (target instanceof HTMLSelectElement && target.dataset.slot) {
    const key = target.dataset.slot;
    guard(async () => {
      if (key === 'todaysPick') {
        await store.saveCuration({ todaysPickId: target.value || null });
      } else {
        await store.saveCuration({ weeklySlots: { [key]: target.value || null } });
      }
      paintActiveTab();
    });
    return;
  }

  /* --- podcast submission form --- */
  // Live feedback on the two fields that can be got wrong, rather than only on
  // submit. Validating a 30 MB file after the writer has typed a title and a
  // description and pressed the button is the worst moment to tell them the
  // format is wrong.
  if (target.id === 'podcast-file' || target.id === 'podcast-up-file') {
    const dialog = target.closest('[role="dialog"]');
    const note = dialog?.querySelector('[data-podcast-duration], [data-podcast-up-note]');
    if (!note) return;

    const file = target.files?.[0];
    if (!file) {
      note.textContent = 'MP3 only, up to 25 MB. The length is worked out from the file.';
      note.classList.remove('text-rose-600');
      return;
    }

    const problem = validateAudioFile(file);
    if (problem) {
      note.textContent = problem;
      note.classList.add('text-rose-600');
      return;
    }

    note.classList.remove('text-rose-600');
    note.textContent = 'Reading the length…';
    readAudioDuration(file).then((seconds) => {
      note.textContent =
        seconds === null
          ? 'That file is accepted, but its length could not be read.'
          : `${podcastDuration(seconds)} — ${(file.size / (1024 * 1024)).toFixed(1)} MB.`;
    });
  }

  if (target.id === 'podcast-description') {
    const counter = byId('podcast-editor')?.querySelector('[data-podcast-count]');
    if (counter) counter.textContent = String(target.value.length);
  }

  if (target.id === 'podcast-up-description') {
    const counter = byId('podcast-upload')?.querySelector('[data-podcast-up-count]');
    if (counter) counter.textContent = String(target.value.length);
  }

  // The Writer submission form's own counter. It lives on the tab body rather
  // than in a dialog, so it is looked up in the form itself.
  if (target.id === 'podcast-sub-description') {
    const counter = target.form?.querySelector('[data-podcast-sub-count]');
    if (counter) counter.textContent = String(target.value.length);
  }

  /* --- Account roles ------------------------------------------------------- */
  // Only a *saved* row (an approved account) writes immediately. On a pending
  // request the role is just the value to be used by the Approve button, so
  // changing it must not persist anything.
  //
  // `setAccountRole`, NOT `approveAccount`. Reusing the approval function here
  // meant every role edit re-ran the whole approval pipeline: it wrote
  // status='active' and a fresh approved_at on an account that was already
  // approved, and upserted the staffer's profile row with status='Active'. An
  // account the Owner had suspended re-activated itself the moment its role was
  // edited. A role edit writes the role and nothing else.
  if (target instanceof HTMLSelectElement && target.dataset.accountSaved) {
    const id = target.dataset.accountSaved;
    const role = target.value;
    guard(async () => {
      await setAccountRole(id, role);
      showToast(`Role updated to ${role}.`, { type: 'success' });
      await reloadAccounts();
    });
  }
}

/**
 * Persist every field of the banner in one write.
 *
 * Only the three fields readers actually see are saved: severity, headline and
 * supporting line, plus the colour and the live switch. `label`, `linkText` and
 * `linkUrl` used to be saved here and are gone from both the form and the
 * rendered banner - the inputs no longer exist, so `byId(...)?.value` returned
 * undefined and every save blanked them.
 *
 * The colour is read from the hex field, not the picker, so a value typed by
 * hand is honoured even when the two are momentarily out of step.
 */
async function saveBreakingFromForm() {
  const headline = byId('breaking-headline')?.value.trim() || '';
  const subtext = byId('breaking-subtext')?.value.trim() || '';
  const severity = byId('breaking-severity')?.value || 'Breaking';
  const color = byId('breaking-color')?.value.trim() || '';
  const enabled = byId('breaking-enabled')?.checked ?? false;

  if (enabled && !headline) {
    showToast('A live banner needs a headline, or readers will see an empty strip.', {
      type: 'error'
    });
    byId('breaking-headline')?.focus();
    return;
  }

  // Reject anything that is not a hex triplet before it reaches public.js. That
  // value is interpolated into a `style` attribute, so it is sanitised again on
  // render - but refusing it here means the Owner sees the refusal instead of
  // the banner silently reverting to the house red.
  if (color && !/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(color)) {
    showToast('Banner colour must be a hex value, e.g. #8C1D11.', { type: 'error' });
    byId('breaking-color')?.focus();
    return;
  }

  await store.saveBreakingNews({
    headline,
    subtext,
    severity,
    color,
    enabled
  });

  showToast(
    enabled ? 'Banner saved and live on the public site.' : 'Banner saved but hidden.',
    { type: 'success' }
  );
  paintActiveTab();
}

/**
 * Persist every slot on the Curation tab in one write.
 *
 * The payload is read out of the DOM at submit time, which is the point: the
 * four selects hold the Owner's new arrangement and nothing else in the panel
 * writes them. The homepage-band checkbox rides the same Save so the button
 * always writes the full arrangement the Owner is looking at. An empty select
 * is stored as null rather than '' — the column behind `todays_pick_id` is a
 * uuid, and Postgres rejects an empty string after the form has already been
 * stopped from reloading the page.
 *
 * `store.saveCuration` commits and notifies subscribers, so the active tab
 * repaints showing the saved values and closeAdmin() re-renders the public
 * feed from the same state — the front page re-sorts on the way out.
 */
async function saveCurationFromForm(form) {
  const pickSelect = form.querySelector('#slot-todays-pick');
  const todaysPickId = pickSelect?.value || null;
  const showToggle = form.querySelector('#curation-show-week');

  const weeklySlots = {};
  form.querySelectorAll('select[data-slot]').forEach((select) => {
    const key = select.dataset.slot;
    if (key !== 'todaysPick') weeklySlots[key] = select.value || null;
  });

  await store.saveCuration({
    todaysPickId,
    weeklySlots,
    // Only sent when the form actually carries the switch, so a Save can never
    // manufacture `showThisWeek: false` out of a missing element.
    ...(showToggle ? { showThisWeek: showToggle.checked } : {})
  });

  showToast('Front-page curation saved.', { type: 'success' });
  paintActiveTab();
}

/** UPDATE the masthead branding from the Branding tab's form. */
async function saveBrandingFromForm() {
  const title = byId('branding-title')?.value.trim() || '';
  const subtitle = byId('branding-subtitle')?.value.trim() || '';
  const edition = byId('branding-edition')?.value.trim() || '';

  if (!title) {
    showToast('The publication needs a title.', { type: 'error' });
    byId('branding-title')?.focus();
    return;
  }

  await store.saveBranding({ title, subtitle, edition });

  showToast('Branding saved and applied to the masthead.', { type: 'success' });
  paintActiveTab();
}

/**
 * Persist one person's Credits entry.
 *
 * Every field is read off the form rather than a cached row so a half-finished
 * edit is never silently discarded. The role is free text: whatever the Owner
 * types is what appears on the page, and the colour travels with it.
 *
 * @param {HTMLFormElement} form
 */
/**
 * Clamp a typed order into the range the form and the page both accept.
 *
 * The field is found WITHIN the form that asked for it. The earlier version used
 * `document.querySelector`, which returns the FIRST match on the page — so with
 * several cards rendered, every card's save read the top card's order number.
 *
 * @param {HTMLFormElement} form
 * @param {'about_us'|'credits'} scope
 */
function readOrderField(form, scope) {
  const selector = scope === 'about_us' ? '[data-credits-about-order]' : '[data-credits-order]';
  const raw = Number(form.querySelector(selector)?.value);
  return Number.isFinite(raw) ? Math.min(999, Math.max(1, Math.round(raw))) : 100;
}

async function saveCreditsFromForm(form) {
  const personId = form.dataset.creditsForm;
  if (!personId) return;

  // The page comes from the form that was submitted, not from module state and
  // not from "which tab is open". A save dispatched after a tab switch then wrote
  // `about_order` onto a Credits row; reading it off the form makes that
  // impossible, because the form only ever carries its own page's scope.
  const scope = normaliseScope(form.dataset.rosterScope);
  const onAbout = scope === 'about_us';

  const name = form.querySelector('[data-credits-name]')?.value.trim() || '';
  if (!name) {
    showToast('A person needs a name.', { type: 'error' });
    return;
  }

  if (onAbout && !form.querySelector('[data-credits-category]')?.value) {
    showToast('An About Us entry needs a main category: Board Members or Behind the Bylines.', {
      type: 'error'
    });
    return;
  }

  const orderKey = onAbout ? 'about_order' : 'sort_order';

  const result = await updatePerson(personId, {
    name,
    role_label: form.querySelector('[data-credits-role]')?.value.trim() || '',
    role_color: form.querySelector('[data-credits-color]')?.value || '',
    blurb: form.querySelector('[data-credits-blurb]')?.value.trim() || '',
    // Always sent, and always this page's own scope. The server derives the
    // category FROM the scope, so a Credits card cannot acquire an About heading
    // no matter what this form sends -- which is the whole reason the "appears
    // under" select is gone from the Credits card.
    page_scope: scope,
    category: onAbout ? form.querySelector('[data-credits-category]')?.value ?? '' : '',
    // ALWAYS SENT, INCLUDING WHEN IT IS EMPTY. That is the difference between
    // "leave this person in Writers" and "take this person out of Writers", and
    // only an explicit empty string can say the second one: `updatePerson()`
    // omits the RPC argument entirely when the caller never mentioned a
    // sub-category, and an omitted argument is a no-op by design.
    sub_category: form.querySelector('[data-credits-sub-category]')?.value.trim() ?? '',
    // A checkbox, so the unticked state is `false` and not `undefined`. Sending
    // it every time is what makes unticking work at all -- a form that only sent
    // `true` could never take the lead back off somebody.
    is_lead: form.querySelector('[data-credits-is-lead]')?.checked === true,
    [orderKey]: readOrderField(form, scope)
  });

  if (!result.ok) {
    showToast(result.message, { type: 'error' });
    return;
  }

  showToast(`${name} saved to the ${scopeLabel(scope)} page.`, { type: 'success' });
  await refreshCreditsPeople();
  paintActiveTab();
}

/**
 * Add a brand-new person to ONE page.
 *
 * Note what is NOT required here: an account, a username, an e-mail or a staff
 * role. The Owner types any credit they like and picks its accent colour. That
 * is the whole point of the page -- it credits contributors, who are not all
 * staff.
 *
 * @param {HTMLFormElement} form
 */
async function addCreditsPersonFromForm(form) {
  const scope = normaliseScope(form.dataset.rosterScope);
  const onAbout = scope === 'about_us';

  const name = byId('credits-add-name')?.value.trim() || '';
  const role = byId('credits-add-role')?.value.trim() || '';

  if (!name || !role) {
    showToast('A person needs both a name and a role.', { type: 'error' });
    return;
  }

  const category = byId('credits-add-category')?.value.trim() || '';
  if (onAbout && !category) {
    showToast('Choose a main category: Board Members or Behind the Bylines.', { type: 'error' });
    return;
  }

  // The file input takes priority over the pasted URL, because it is the
  // mobile path (a phone camera) and the one people actually use.
  let portrait = '';
  const pending = byId('credits-add-photo')?.files?.[0];
  if (pending) {
    const busy = showToast('Uploading the photo…', { type: 'info', duration: 0 });
    try {
      const { url, isLocal } = await uploadImage(pending);
      portrait = url;
      busy.remove();
      if (isLocal) {
        showToast('Storage is offline, so the photo stayed in this browser.', {
          type: 'info'
        });
      }
    } catch (error) {
      busy.remove();
      showToast(error.message || 'Photo upload failed.', { type: 'error' });
      return;
    }
  } else {
    portrait = byId('credits-add-url')?.value.trim() || '';
  }

  const order = readOrderField(form, scope);

  // FIELD NAMES MUST MATCH addPerson().
  //
  // This handler used to send { role_label, role_color, portrait_url } while
  // addPerson() destructures { role, color, portraitUrl }. Every one of the three
  // came through undefined, so the save silently fell back to "Contributor" with
  // the default blue and no photo — and the form looked like it had worked.
  // Same class of bug as the camelCase/snake_case drift, one layer further out.
  const result = await addPerson({
    name,
    role,
    color: byId('credits-add-color')?.value || '',
    blurb: byId('credits-add-blurb')?.value.trim() || '',
    portraitUrl: portrait,
    // The scope comes from the form, so an entry cannot land on the page the
    // Owner is not looking at. There is no longer a select that can contradict
    // it — the old `creditsScope` default plus "Appears under" dropdown is what
    // let a Credits entry quietly become a board member.
    pageScope: scope,
    category: onAbout ? category : '',
    // Sent on BOTH pages, and the key is always present even when the field was
    // left blank -- on an INSERT there is no stored value for the server to keep,
    // so '' is the only way to say "no sub-team" and it costs nothing.
    subCategory: byId('credits-add-sub')?.value.trim() ?? '',
    isLead: byId('credits-add-lead')?.checked === true,
    // One field, whichever page's order column this form renders.
    ...(onAbout ? { aboutOrder: order } : { order })
  });

  if (!result.ok) {
    showToast(result.message, { type: 'error' });
    return;
  }

  form.reset();
  await refreshCreditsPeople();
  paintActiveTab();
  showToast(`${name} added to the ${scopeLabel(scope)} page.`, { type: 'success' });
}

/**
 * Copy a role colour from one person onto another.
 *
 * Targets the colour input by id and fires a `change` event so the preview
 * badge repaints immediately -- without it the picker changes but the badge
 * keeps showing the old colour until the next save.
 *
 * @param {string} sourceId  id of the colour input to read from
 * @param {string} targetId  id of the colour input to write to
 */
function copyRoleColour(sourceId, targetId) {
  const source = byId(sourceId);
  const target = byId(targetId);
  if (!source || !target || source === target) return;

  target.value = normaliseColour(source.value) || DEFAULT_ROLE_COLOR;
  target.dispatchEvent(new Event('change', { bubbles: true }));
  target.focus();
  showToast('Role colour copied.', { type: 'info' });
}

/* -------------------------------------------------------------------------- */
/* Broadcast target picker — "Specific User" audience */
/* -------------------------------------------------------------------------- */

/**
 * The staff roster used by the picker, fetched once and reused for both the
 * search box and the "assigned to" dropdown.
 *
 * Suspended accounts are excluded: a targeted push to a suspended member is
 * never what the Owner means, and their devices should not be woken.
 */
let staffDirectory = null;

async function getStaffDirectory() {
  if (staffDirectory) return staffDirectory;
  const rows = await loadAccounts();
  staffDirectory = (rows || [])
    .filter((row) => String(row.status || '').toLowerCase() !== 'suspended')
    .map((row) => ({
      id: row.id,
      name: row.display_name || row.username || 'Unnamed',
      username: row.username || '',
      role: row.role || 'Writer'
    }));
  return staffDirectory;
}

function staffLabel(person) {
  return person.username && person.username !== person.name
    ? `${person.name} (${person.username})`
    : person.name;
}

/**
 * Show or hide the "Specific User" picker to match the audience dropdown.
 * Hiding it also clears the selection, so a broadcast cannot be aimed at
 * someone the Owner has just switched away from.
 */
export function syncBroadcastTargetVisibility(audience) {
  const wrap = byId('broadcast-target-wrap');
  if (!wrap) return;
  const specific = audience === 'Specific User';
  wrap.classList.toggle('hidden', !specific);
  if (!specific) {
    const hidden = byId('broadcast-target-id');
    if (hidden) hidden.value = '';
    const results = byId('broadcast-target-results');
    if (results) results.innerHTML = '';
  }
}

/** Filter the roster against what has been typed. An empty box lists everyone. */
export function renderBroadcastTargetResults(query = '') {
  const results = byId('broadcast-target-results');
  if (!results) return;

  const needle = String(query || '').trim().toLowerCase();
  const matches = staffDirectory
    ? staffDirectory.filter(
        (person) =>
          !needle ||
          person.name.toLowerCase().includes(needle) ||
          person.username.toLowerCase().includes(needle)
      )
    : [];

  if (!staffDirectory) {
    results.innerHTML = `<p class="ink-muted p-3 text-xs">Loading the staff list…</p>`;
    return;
  }

  if (matches.length === 0) {
    results.innerHTML = `<p class="ink-muted p-3 text-xs">No one matches “${escapeHtml(query)}”.</p>`;
    return;
  }

  // Cap the list so a large roster cannot render an unbounded menu.
  const shown = matches.slice(0, 50);
  results.innerHTML = shown
    .map(
      (person) => `
      <button
        type="button"
        class="block w-full px-3 py-2 text-left text-sm hover:bg-surface-2"
        role="option"
        data-target-id="${escapeHtml(person.id)}"
        data-target-label="${escapeHtml(staffLabel(person))}"
      >
        ${escapeHtml(staffLabel(person))}
        <span class="ink-muted text-xs">· ${escapeHtml(person.role)}</span>
      </button>`
    )
    .join('');

  if (matches.length > shown.length) {
    results.insertAdjacentHTML(
      'beforeend',
      `<p class="ink-muted border-t border-line p-3 text-xs">${
        matches.length - shown.length
      } more — keep typing to narrow it down.</p>`
    );
  }
}

/** Record the chosen member in the hidden field the submit handler reads. */
export function chooseBroadcastTarget(id, label) {
  const hidden = byId('broadcast-target-id');
  if (hidden) hidden.value = id || '';
  const chosen = byId('broadcast-target-chosen');
  if (chosen) {
    chosen.textContent = id ? `Will be sent to ${label} only.` : '';
  }
  const results = byId('broadcast-target-results');
  if (results) results.innerHTML = '';
}

/** Warm the roster when the picker is first revealed. */
async function prepareBroadcastTarget() {
  await getStaffDirectory();
  renderBroadcastTargetResults(byId('broadcast-target')?.value || '');
}

/**
 * Compose a broadcast and hand it to the delivery layer, which shows a real
 * notification popup on every opted-in device (and records the send in the
 * history table).
 */
export async function sendBroadcastFromForm(form) {
  const title = byId('broadcast-title')?.value.trim() || '';
  const message = byId('broadcast-message')?.value.trim() || '';
  const audience = byId('broadcast-audience')?.value || 'Everyone';

  // Only meaningful for a targeted send. Null means "every device", which is the
  // correct value for every other audience and must stay null rather than an
  // empty string - the sender treats a non-empty string as a uuid and would
  // reject the whole request.
  const targetStaffId =
    audience === 'Specific User' ? byId('broadcast-target-id')?.value.trim() || null : null;

  if (audience === 'Specific User' && !targetStaffId) {
    showToast('Pick who this broadcast is for, or change the audience.', {
      type: 'error'
    });
    byId('broadcast-target')?.focus();
    return;
  }

  if (!title) {
    showToast('Give the broadcast a subject so it is recognisable in the tray.', {
      type: 'error'
    });
    byId('broadcast-title')?.focus();
    return;
  }

  const button = form.querySelector('button[type="submit"]');
  if (button) {
    button.disabled = true;
    button.dataset.busy = 'true';
  }

  try {
    // The Owner almost never has permission granted on the machine they are
    // sending *from*, which used to make a successful send look like nothing
    // happened. Ask first, then send, so the owner sees the same popup a reader
    // would - this is the quickest proof the feature actually works.
    if (push.getPermission() !== 'granted') {
      const allowed = await ensureAlertPermission();
      if (!allowed) {
        showToast(
          'Allow notifications for The Pulse on this device, then send again — ' +
            'otherwise you cannot see the alert to confirm it works.',
          { type: 'info', duration: 9000 }
        );
        return;
      }
    }

    const result = await sendBroadcastToDevices({
      title,
      message,
      audience,
      targetStaffId
    });
    form.reset();
    // A form.reset() does not restore the hidden id input's value on every
    // browser path, and a stale uuid left behind would silently re-target the
    // NEXT broadcast the Owner sends. Clear it explicitly.
    const targetId = byId('broadcast-target-id');
    if (targetId) targetId.value = '';
    syncBroadcastTargetVisibility('Everyone');
    paintActiveTab();

    // Report what actually happened, and nothing more.
    //
    // `pushedOk` means the serverless sender really ran web-push and the push
    // service accepted at least one subscription. Only THEN can we say
    // "Delivered via Web Push to N devices" — the previous copy claimed in-app
    // only, which understated what now happens. If the push did not happen, say
    // why in terms the Owner can act on, rather than implying success.
    const devices = result.pushed;
    const viaPush = result.pushedOk && devices > 0;

    if (viaPush) {
      showToast(
        `Delivered via Web Push to ${devices} device${devices === 1 ? '' : 's'}.` +
          (result.popped ? '' : ' This device blocked its own popup.'),
        { type: 'success', duration: 7000 }
      );
      return;
    }

    // Not delivered by push. Explain the specific blocker instead of a vague
    // "in-app only", because each of these has a different fix.
    const targeted = Boolean(result.pushTargeted);
    const why = {
      no_vapid_key:
        'No VAPID public key is set in this build, so devices cannot be pushed to.',
      unauthorised: 'The push sender refused the request — sign in as the Owner and try again.',
      push_send_token_unset:
        'PUSH_SEND_TOKEN is not set in Vercel and the panel could not authenticate.',
      no_subscribers:
        'No device has a usable push subscription yet. Readers must turn on alerts first.',
      target_has_no_devices: targeted
        ? 'That account has no device registered for push. They must open The Pulse on ' +
          'that device, turn on alerts, and sign in — the subscription is linked to ' +
          'whoever is signed in when alerts are enabled.'
        : 'No device has a usable push subscription yet.',
      no_usable_subscriptions: targeted
        ? `That account has ${result.pushMatched} device(s) registered, but none carry usable ` +
          'push keys. They need to re-allow alerts on that device to generate a new subscription.'
        : 'Devices are registered but none carry usable push keys. Readers need to ' +
          're-allow alerts to generate a fresh subscription.',
      network: 'Could not reach the push sender. Check the connection and try again.'
    }[result.pushReason] || 'The push sender could not deliver this.';

    showToast(
      `Broadcast saved, in-app delivery only. ${why} Open devices will still see it on their next refresh.`,
      { type: 'info', duration: 10000 }
    );
  } finally {
    if (button) {
      button.disabled = false;
      delete button.dataset.busy;
    }
  }
}

/** Run an async action with uniform error toasts. */
async function guard(action) {
  try {
    await action();
  } catch (error) {
    console.error('[admin]', error);
    showToast(error?.message || 'That action could not be completed.', {
      type: 'error'
    });
  }
}

/** Delete confirmations, kept in one place. */
const CONFIRM_COPY = {
  article: 'Delete this article permanently? This cannot be undone.',
  interview:
    'Delete this interview permanently? Any published videos go with it. This cannot be undone.',
  assignment: 'Close and delete this assignment?',
  staff: 'Remove this staff member from the roster?',
  media: 'Remove this image from the media library?',
  broadcast: 'Remove this broadcast from the delivery history?',
  reset: 'Reset all locally stored data back to the seed content?'
};

function askToDelete(kind, extra = '') {
  const question = CONFIRM_COPY[kind] || 'Are you sure?';
  return window.confirm(extra ? `${question}\n\n"${extra}"` : question);
}

/** Open the article editor, either blank or pre-filled. */
function openArticleEditor(articleId) {
  const article = articleId ? store.getArticle(articleId) : null;
  editingArticleId = article?.id ?? null;

  byId('article-editor-title').textContent = article ? 'Edit Article' : 'Create Article';
  byId('article-title').value = article?.title ?? '';
  byId('article-author').value = article?.author ?? '';
  byId('article-category').value = article?.category ?? 'Civic Dispatch';
  byId('article-status').value = article?.status ?? 'Pending Review';
  byId('article-date').value = article?.date ?? '';
  byId('article-image').value = article?.image ?? '';
  // Repopulate the supporting photos on edit, or a round-trip through this
  // dialog would silently drop them: the field is the only place they live,
  // and an untouched text input reads as empty.
  setArticleExtras(article?.extraImages ?? []);
  if (byId('article-extra-url')) byId('article-extra-url').value = '';
  byId('article-caption').value = article?.caption ?? '';
  byId('article-body').value = article?.body ?? '';
  byId('article-featured').checked = Boolean(article?.featured);

  openDialog('article-editor', { initialFocus: '#article-title' });
}

/* -------------------------------------------------------------------------- */
/* Interview editor                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Repaint the staged video list.
 *
 * The list is rendered from `interviewVideoDraft` rather than read back out of
 * the inputs on save, because each row has its own remove button and there is no
 * single input whose value is the answer. Indices come straight from the rows on
 * screen, so they cannot drift out of step with the array.
 */
function renderInterviewVideoPreview() {
  const host = byId('interview-video-preview');
  if (!host) return;

  if (!interviewVideoDraft.length) {
    host.innerHTML = '';
    return;
  }

  host.innerHTML = interviewVideoDraft
    .map(
      (id, index) => `
      <div class="surface-sunken flex items-center gap-2 px-3 py-2 text-xs">
        <span class="badge badge-neutral">${index + 1}</span>
        <code class="min-w-0 flex-1 truncate">${escapeHtml(id)}</code>
        <button type="button" class="btn btn-quiet" data-action="interview-video-remove"
          data-index="${index}" aria-label="Remove video ${index + 1}">
          <i class="fa-solid fa-xmark" aria-hidden="true"></i>
        </button>
      </div>`
    )
    .join('');
}

/**
 * Stage one pasted YouTube reference into the draft.
 *
 * Nothing is written straight to the interview from the text box: the field is
 * cleared and the id is appended to `interviewVideoDraft`, which is what the save
 * reads. The id shown back to the writer is the normalised form, so a pasted
 * share link visibly becomes the bare 11-character id that will be stored --
 * the writer can see the normalisation actually happened.
 *
 * Rejects (with an explanation) rather than silently ignoring a bad paste, an
 * over-limit add, and a duplicate. Silently ignoring all three is how a writer
 * ends up saving an interview with two videos and no idea why.
 */
function stageInterviewVideo(rawValue) {
  const value = String(rawValue ?? '').trim();
  if (!value) return false;

  if (interviewVideoDraft.length >= store.MAX_INTERVIEW_VIDEOS) {
    showToast(
      `That is the ${store.MAX_INTERVIEW_VIDEOS}-video limit. Remove one first.`,
      { type: 'error' }
    );
    return false;
  }

  const id = store.normaliseYouTubeId(value);
  if (!id) {
    showToast('That does not look like a YouTube video link.', { type: 'error' });
    return false;
  }

  if (interviewVideoDraft.includes(id)) {
    showToast('That video is already attached.', { type: 'error' });
    return false;
  }

  interviewVideoDraft.push(id);
  renderInterviewVideoPreview();

  const field = byId('interview-video-url');
  if (field) field.value = '';
  return true;
}

/** Open the interview editor, either blank or pre-filled. */
function openInterviewEditor(interviewId) {
  const interview = interviewId ? store.getInterview(interviewId) : null;
  editingInterviewId = interview?.id ?? null;

  byId('interview-editor-title').textContent = interview
    ? 'Edit Interview'
    : 'Create Interview';
  byId('interview-title').value = interview?.title ?? '';
  byId('interview-guest').value = interview?.guest ?? '';
  byId('interview-guest-role').value = interview?.guestRole ?? '';
  byId('interview-interviewer').value = interview?.interviewer ?? '';
  byId('interview-status').value = interview?.status ?? 'pending';
  byId('interview-summary').value = interview?.summary ?? '';
  byId('interview-description').value = interview?.description ?? '';
  byId('interview-image').value = interview?.image ?? '';

  // Repopulate the staged videos on edit. The draft is the only place they live
  // during editing, so an untouched text box reads as empty and a round trip
  // through this dialog would otherwise silently drop every recording.
  interviewVideoDraft = store.readVideoIds(interview?.videoIds);
  if (byId('interview-video-url')) byId('interview-video-url').value = '';
  renderInterviewVideoPreview();

  openDialog('interview-editor', { initialFocus: '#interview-title' });
}

/** CREATE or UPDATE an interview from the editor dialog. */
async function saveInterviewFromForm() {
  const payload = {
    title: byId('interview-title').value,
    guest: byId('interview-guest').value,
    guestRole: byId('interview-guest-role').value,
    interviewer: byId('interview-interviewer').value,
    status: byId('interview-status').value,
    summary: byId('interview-summary').value,
    description: byId('interview-description').value,
    image: byId('interview-image').value.trim(),
    videoIds: interviewVideoDraft
  };

  if (!payload.title.trim()) {
    showToast('Every interview needs a headline.', { type: 'error' });
    byId('interview-title').focus();
    return;
  }

  // The guest is the subject of the interview, so a record without one is a
  // record nobody can identify in the Owner's queue. Title alone is not enough.
  if (!payload.guest.trim()) {
    showToast('Name the person who was interviewed.', { type: 'error' });
    byId('interview-guest').focus();
    return;
  }

  if (editingInterviewId) {
    await store.updateInterview(editingInterviewId, payload);
    showToast('Interview updated.', { type: 'success' });
  } else {
    await store.createInterview(payload);
    showToast(
      payload.status === 'published'
        ? 'Interview created and published.'
        : 'Interview filed for approval.',
      { type: 'success' }
    );
  }

  editingInterviewId = null;
  interviewVideoDraft = [];
  closeDialog('interview-editor');
  paintActiveTab();
}

/** Open the staff editor. */
function openStaffEditor(staffId) {
  const member = staffId
    ? store.listStaff().find((entry) => entry.id === staffId)
    : null;
  editingStaffId = member?.id ?? null;

  byId('staff-editor-title').textContent = member ? 'Edit Staffer' : 'Add Staffer';
  byId('staff-name').value = member?.name ?? '';
  byId('staff-username').value = member?.username ?? '';
  byId('staff-email').value = member?.email ?? '';
  byId('staff-role').value = member?.role ?? 'Writer';

  // Only pre-select a status the dropdown can actually hold. Assigning an
  // unrecognised value ('active' in the wrong case, or a blank column) leaves
  // the select reporting '', and that '' was then saved back over the stored
  // status -- so opening and saving the dialog silently un-suspended a suspended
  // staffer. An unrecognised value leaves the dropdown on its first option and
  // the save below preserves whatever was actually stored.
  const storedStatus = normaliseStaffStatus(member?.status);
  byId('staff-status').value = storedStatus || STAFF_STATUSES[0];

  // Always start from a blank portrait field. The file input keeps its value
  // across dialog openings, so without this the photo picked for one staffer
  // would silently attach to the next person the Owner hires.
  byId('staff-portrait-url').value = '';
  if (byId('staff-portrait-file')) byId('staff-portrait-file').value = '';

  openDialog('staff-editor', { initialFocus: '#staff-name' });
}

/**
 * Offer every approved account in the "Assigned to" picker.
 *
 * `wire_list_accounts()` is owner-gated, which is exactly right here: only the
 * Owner assigns work. Unapproved requests are excluded because you cannot
 * meaningfully assign a deadline to an account that cannot sign in, and the
 * reminder push would go nowhere.
 *
 * Safe to call repeatedly - the list is rebuilt, not appended to.
 */
async function populateAssignedTo(currentId) {
  const select = byId('assignment-assigned-to');
  if (!select) return;

  const rows = await loadAccounts();
  if (rows === null) {
    // The roster read FAILED. Do not rebuild the select from an empty list: that
    // would leave only "Nobody yet" in the dropdown, and the Owner's next save
    // would read that placeholder back and clear the assignee - a data-loss bug
    // wearing the costume of a permissions problem.
    console.warn('[admin] roster unreadable; leaving the assignee select as-is');
    return;
  }

  // `wire_list_accounts()` returns `status`, NOT `is_active`. The filter read
  // `row.is_active !== false`, which is undefined on every row, so it excluded
  // nobody -- and then `!row.is_owner` dropped the Owner. Together those left an
  // empty dropdown whenever the only other accounts were pending or suspended,
  // which is exactly what "it resets to Nobody" looks like from the outside.
  //
  // Only genuinely unusable accounts are excluded now: a pending account cannot
  // sign in, and a suspended one has had access revoked, so in both cases the
  // reminder push would go nowhere. The Owner IS includable - they receive
  // broadcasts and are as entitled to a deadline reminder as anyone else.
  const eligible = rows.filter((row) => {
    const status = String(row.status || '').toLowerCase();
    return status !== 'pending' && status !== 'suspended';
  });

  // Remember what was already chosen, and restore it. A selection that vanishes
  // on re-open is indistinguishable from one that was never saved.
  const previous = currentId || select.value || '';

  select.innerHTML =
    '<option value="">Nobody yet</option>' +
    eligible
      .map((row) => {
        const name = row.display_name || row.username || 'Unnamed';
        const role = row.role ? ` (${row.role})` : '';
        // The value is the staff account id: that is what `assigned_to` stores
        // and what the reminder pass matches a device against.
        return `<option value="${escapeHtml(String(row.id))}">${escapeHtml(name + role)}</option>`;
      })
      .join('');

  // Only restore if the id is genuinely still offered. Assigning a value that is
  // not among the options leaves the select on the placeholder, which would
  // silently unassign somebody on the next save.
  if (previous && [...select.options].some((option) => option.value === String(previous))) {
    select.value = String(previous);
  }
}

/** Open the assignment editor. */
async function openAssignmentEditor(assignmentId) {
  const item = assignmentId
    ? store.listAssignments().find((entry) => entry.id === assignmentId)
    : null;
  editingAssignmentId = item?.id ?? null;

  byId('assignment-editor-title').textContent = item
    ? 'Edit Assignment'
    : 'New Assignment';
  byId('assignment-title').value = item?.title ?? '';
  byId('assignment-reporter').value = item?.reporter ?? '';
  byId('assignment-status').value = item?.status ?? 'Open';
  // Seed the picker from the machine-readable instant. Falling back to the
  // free-text `deadline` column would put something like "18 April" into a
  // `datetime-local` input, which the browser silently rejects and blanks - the
  // value is then written back as empty, quietly losing the deadline on save.
  byId('assignment-deadline').value = toDateTimeLocalValue(
    item?.due_at ? new Date(item.due_at) : null
  );

  // Reflect the stored instant back, so the Owner sees the exact value the cron
  // compares against rather than trusting that it round-tripped.
  const dueAt = item?.due_at || null;
  const hint = byId('assignment-due-hint');
  if (hint) {
    hint.textContent = dueAt
      ? `Reminder fires a day ahead — ${new Date(dueAt).toLocaleString()}.`
      : 'No deadline set, so no reminder will be sent.';
  }

  openDialog('assignment-editor', { initialFocus: '#assignment-title' });

  // Populate after the dialog is open so the select has a measurable width and
  // the roster fetch does not delay the editor appearing.
  try {
    await populateAssignedTo(item?.assigned_to ?? null);
  } catch (error) {
    console.warn('[admin] could not load the roster for the picker', error);
  }
}

/** The single delegated click/submit/change handler for the workspace. */
function handleClick(event) {
  const tabButton = event.target.closest('[data-admin-tab]');
  if (tabButton) {
    selectTab(tabButton.dataset.adminTab);
    return;
  }

  const trigger = event.target.closest('[data-action]');
  if (!trigger) return;

  const { action, id, title, name, filter, status, username } = trigger.dataset;

  switch (action) {
    /* --- navigation --- */
    case 'close-admin':
      closeAdmin();
      break;
    case 'refresh':
      guard(async () => {
        await store.refresh();
        paintActiveTab();
        showToast('Workspace refreshed.', { type: 'success' });
      });
      break;
    case 'sign-out':
      guard(async () => {
        await signOut();
        closeAdmin();
      });
      break;

    /* --- content desk --- */
    case 'content-filter':
      contentFilter = filter;
      paintActiveTab();
      break;

    /* --- front-page layout --- */
    // Local reordering. Nothing is written until Save is pressed, so a mis-drag
    // costs one tap of the arrow buttons rather than a round trip and a repaint.
    case 'layout-up':
      // The arrows reorder the DRAFT in memory; `layout-save` is what writes it.
      // Both are Owner-only, and both are gated because a Writer reaching this
      // switch has already got past the panel that no longer renders for them.
      if (!isOwner()) break;
      nudgeLayout(id, -1);
      break;
    case 'layout-down':
      if (!isOwner()) break;
      nudgeLayout(id, 1);
      break;

    case 'layout-save': {
      /*
        ONLY THE OWNER SETS THE FRONT PAGE ORDER.
        `contentLayoutPanel()` no longer renders for a non-Owner, so this is the
        second gate. It is kept because the other one lives in a template and
        templates are re-rendered; a gate that only exists at render time is a gate
        that disappears the moment somebody adds the panel somewhere else.
        `wire_set_article_layout` raises on anything but `is_owner()` regardless.
      */
      if (!isOwner()) {
        showToast('Only the Owner can set the front page order.', { type: 'error' });
        break;
      }
      const order = currentLayoutOrder();
      guard(async () => {
        const button = trigger;
        if (button) button.disabled = true;
        try {
          const result = await store.saveArticleLayout(order);
          if (!result.ok) {
            showToast(result.message || 'The layout could not be saved.', { type: 'error' });
            return;
          }
          // Only now is the draft the truth. Clearing it first is what stops
          // `layoutIsDirty` comparing the new order against the order we just
          // wrote and reporting an unsaved change that does not exist.
          layoutDraft = null;
          layoutSaved = '';
          showToast(`Front page order saved (${result.saved} stories).`, { type: 'success' });
          paintActiveTab();
        } finally {
          if (button) button.disabled = false;
        }
      });
      break;
    }

    case 'article-new':
      openArticleEditor(null);
      break;
    case 'article-edit': {
      /*
        AN OWNERSHIP RE-CHECK, WHICH `article-delete` ALREADY HAD
        -------------------------------------------------------
        Delete has always re-checked `canDeleteArticle()` in the handler and says
        so in a comment. Edit did not: the button was gated when it was rendered
        and then `openArticleEditor(id)` was called on nothing more than the id
        from the DOM. Those are not the same thing, because `data-id` is an
        ATTRIBUTE, and the whole point of the exercise is that an attacker with
        devtools can change an attribute.

        So the handler trusts the button only as far as the button is a
        convenience, and the authority is the RLS policy in supabase/007 plus
        `articles_publish_guard`. The re-check here exists to turn a permission
        error from Postgres into a sentence a Writer can act on.
      */
      const article = store.listArticles().find((item) => item.id === id);
      if (!store.canEditArticle(article)) {
        showToast('You can only edit your own articles.', { type: 'error' });
        break;
      }
      openArticleEditor(id);
      break;
    }
    case 'article-extra-remove': {
      // Indices come from the rendered thumbnails, which are drawn straight
      // from articleExtras, so they cannot drift out of step with it.
      const index = Number(trigger.dataset.index);
      if (Number.isInteger(index) && index >= 0 && index < articleExtras.length) {
        articleExtras.splice(index, 1);
        renderArticleExtraPreview();
      }
      break;
    }
    case 'article-publish':
      /*
        APPROVING IS THE APPROVER TIER, RE-CHECKED HERE
        ------------------------------------------------
        The buttons are already gated on `canApprove()` where they are rendered,
        and this is the second gate. `data-action="article-publish"` also appears
        in the Overview review queue, which is gated the same way -- two renderers
        to keep in step with one handler is two chances to forget.

        Without this, a Writer who edited `data-id` by hand got a raw Postgres
        error, or -- before `articles_publish_guard` existed in migration 033 --
        a story on the front page. `store.canApprove()` mirrors
        `public.can_approve()`; the guard trigger is what makes it true.
      */
      if (!store.canApprove()) {
        showToast('Only the Owner or a Board Manager can approve.', { type: 'error' });
        break;
      }
      guard(async () => {
        await store.publishArticle(id);
        showToast('Article approved and published.', { type: 'success' });
      });
      break;
    case 'article-reject':
      if (!store.canApprove()) {
        showToast('Only the Owner or a Board Manager can unpublish.', { type: 'error' });
        break;
      }
      guard(async () => {
        await store.rejectArticle(id);
        showToast('Article moved out of publication.');
      });
      break;
    case 'article-delete': {
      // A writer may remove only their own byline. This hides the affordance,
      // but the real check is the RLS policy in supabase/007 — the browser
      // must not be the thing deciding who can delete what.
      const article = store.listArticles().find((item) => item.id === id);
      if (!store.canDeleteArticle(article)) {
        showToast('You can only delete your own articles.', { type: 'error' });
        break;
      }
      if (askToDelete('article', title)) {
        guard(async () => {
          await store.deleteArticle(id);
          showToast('Article deleted.', { type: 'success' });
        });
      }
      break;
    }

    /* --- interviews --- */
    case 'interview-new':
      openInterviewEditor(null);
      break;

    // The writer's door into the podcast feature. On the Content tab, which every
    // staffer can open -- the Owner-only Podcasts tab has no writer door at all,
    // and the Interviews tab is where this briefly lived, which made an episode
    // look as though it filed as an interview. Interviews and podcasts are
    // separate tables with separate approval flows.
    case 'podcast-new':
      openPodcastEditor();
      break;
    case 'interview-edit': {
      // Same reasoning as `article-edit` above, and for the same reason the
      // buttons are already gated at render: a gate in a template and a gate in a
      // handler are different code, and only the second one runs when `data-id`
      // has been changed by hand.
      const interview = store.listInterviews().find((item) => item.id === id);
      if (!store.canEditInterview(interview)) {
        showToast('You can only edit interviews you filed.', { type: 'error' });
        break;
      }
      openInterviewEditor(id);
      break;
    }
    case 'interview-publish':
      // The approver tier, re-checked for the same reason as `article-publish`
      // above. Migration 033 widened `interviews_publish_guard` to
      // `can_approve()`, so this is now the only remaining thing that used to stop
      // a Board Manager here.
      if (!store.canApprove()) {
        showToast('Only the Owner or a Board Manager can approve.', { type: 'error' });
        break;
      }
      guard(async () => {
        await store.publishInterview(id);
        showToast('Interview approved and published.', { type: 'success' });
      });
      break;
    case 'interview-unpublish':
      if (!store.canApprove()) {
        showToast('Only the Owner or a Board Manager can unpublish.', { type: 'error' });
        break;
      }
      guard(async () => {
        await store.unpublishInterview(id);
        showToast('Interview pulled back to the review queue.');
      });
      break;
    case 'interview-delete': {
      // Same reasoning as articles: hide the affordance honestly, but let the
      // RLS policy in migration 022 be the thing that actually decides. A
      // leaked anon key cannot bypass the database, so the browser must not be
      // the authority here either.
      const interview = store.listInterviews().find((item) => item.id === id);
      if (!store.canDeleteInterview(interview)) {
        showToast('You can only delete your own interviews.', { type: 'error' });
        break;
      }
      if (askToDelete('interview', title)) {
        guard(async () => {
          await store.deleteInterview(id);
          showToast('Interview deleted.', { type: 'success' });
        });
      }
      break;
    }

    case 'interview-filter':
      // Same dead-control class of bug as the video buttons below: the filter row
      // rendered these, but no case ever routed them, so every status button in
      // the Interviews Desk silently did nothing and the tab looked like it had
      // no filtering at all.
      interviewFilter = filter;
      paintActiveTab();
      break;

    case 'interview-video-add': {
      // The Add button in the YouTube section. Without this case the button was
      // rendered but never routed: `data-action` only dispatches inside this
      // switch, so the click fell through to the end of the handler and nothing
      // happened. stageInterviewVideo() existed, was correct, and had no caller.
      //
      // Reads the text box rather than an event value because the button is a
      // sibling of the input, not a form submit carrying the field.
      const staged = stageInterviewVideo(byId('interview-video-url')?.value);
      // Only refocus when the paste was accepted. On a rejection the text stays
      // put so the writer can see and correct what they pasted -- stealing focus
      // here would make the editor look like it had swallowed the link.
      if (staged) byId('interview-video-url')?.focus();
      break;
    }
    case 'interview-video-remove': {
      // Indices come from the rendered rows, which are drawn straight from
      // interviewVideoDraft, so they cannot drift out of step with it.
      const index = Number(trigger.dataset.index);
      if (Number.isInteger(index) && index >= 0 && index < interviewVideoDraft.length) {
        interviewVideoDraft.splice(index, 1);
        renderInterviewVideoPreview();
      }
      break;
    }

    /* --- assignments --- */
    case 'assignment-new':
      openAssignmentEditor(null);
      break;
    case 'assignment-edit':
      openAssignmentEditor(id);
      break;
    case 'assignment-delete':
      if (askToDelete('assignment', title)) {
        guard(async () => {
          await store.deleteAssignment(id);
          showToast('Assignment deleted.', { type: 'success' });
        });
      }
      break;

    /* --- breaking banner --- */
    case 'breaking-off':
      guard(async () => {
        await store.saveBreakingNews({ enabled: false });
        showToast('Breaking banner hidden.');
      });
      break;

    /* --- broadcasts --- */
    case 'broadcast-delete':
      if (askToDelete('broadcast')) {
        guard(async () => {
          await store.deleteBroadcast(id);
          showToast('Broadcast removed from history.', { type: 'success' });
        });
      }
      break;

    /* --- curation --- */
    case 'reroll-pick':
      guard(async () => {
        const chosen = await store.rerollTodaysPick();
        if (!chosen) {
          showToast('Publish an article first.', { type: 'error' });
          return;
        }
        paintActiveTab();
        showToast(`Today's Pick is now "${chosen.title}".`, {
          type: 'success'
        });
      });
      break;

    /* --- staff --- */
    case 'staff-new':
      openStaffEditor(null);
      break;
    case 'staff-edit':
      openStaffEditor(id);
      break;
    case 'staff-delete':
      if (askToDelete('staff', name)) {
        guard(async () => {
          await store.deleteStaff(id);
          showToast('Staff member removed.', { type: 'success' });
        });
      }
      break;

    /* --- portrait review (Owner only) --- */
    // The client hides these buttons and the RPC re-checks is_owner() in
    // Postgres, so this branch is the third gate, not the only one.
    case 'portrait-approve':
    case 'portrait-reject': {
      const approving = action === 'portrait-approve';
      const who = name || 'this staffer';
      guard(async () => {
        const result = await setPortraitStatus(id, approving ? 'approved' : 'rejected');
        if (!result.ok) {
          showToast(result.message, { type: 'error', duration: 6000 });
          return;
        }
        // primePortraits() re-reads the sticker cache so the byline photo and
        // the Credits page reflect the decision without a page reload.
        await primePortraits();
        showToast(
          approving
            ? `${who}'s portrait is live. It now appears beside their bylines.`
            : `${who}'s portrait was rejected. They can upload a new one.`,
          { type: approving ? 'success' : 'info' }
        );
      });
      break;
    }

    // Deletes the stored photo outright rather than flagging it. There is no
    // un-reject: once cleared, the only way back is a fresh upload, so this
    // asks for a second, unambiguous confirmation instead of the shared
    // askToDelete() copy -- a mis-click here destroys someone's portrait.
    case 'portrait-reset': {
      const who = name || 'this staffer';
      if (
        !window.confirm(
          `Delete ${who}'s portrait?\n\nThe photo will be removed from the server, not just hidden, and cannot be recovered. ${who} will be able to upload a replacement.`
        )
      ) {
        return;
      }
      guard(async () => {
        const result = await resetPortrait(id);
        if (!result.ok) {
          showToast(result.message, { type: 'error', duration: 8000 });
          return;
        }
        // Same reason as the approve/reject branch: the byline photo and the
        // Credits page read from the cached sticker list, so without priming
        // they keep showing a portrait that no longer exists.
        await primePortraits();
        showToast(`${who}'s portrait was cleared. They can submit a new one.`, {
          type: 'success'
        });
      });
      break;
    }

    /* --- podcasts --- */
    // The Owner's own upload. A different function from submitPodcast rather than
    // a flag on it, because submitPodcast always writes 'pending' and the INSERT
    // policy pins that -- the one path a writer can reach must not be widenable
    // by adding a parameter.
    case 'podcast-upload':
      guard(() => openPodcastUpload());
      break;

    case 'podcast-approve':
      if (!store.canApprove()) {
        showToast('Only the Owner or a Board Manager can approve.', { type: 'error' });
        break;
      }
      guard(async () => {
        const result = await decidePodcast(id, 'approved');
        showToast(result.message, { type: result.ok ? 'success' : 'error' });
        if (!result.ok) return;
        podcastQueue = null;
        paintActiveTab();
      });
      break;

    case 'podcast-reject':
    case 'podcast-delete': {
      /*
        APPROVE IS THE TIER; DELETE IS THE OWNER SEAT.

        Refusing a PENDING episode and deleting a PUBLISHED one are the same act on
        different rows -- both delete the row and purge the MP3 -- and migration 030
        made a Board Manager an approver, so refusing one is theirs to do. Deleting
        something readers can currently hear is not: `podcasts_delete` in Storage and
        `podcasts_owner_all` both require `is_owner()`, and migration 033 leaves them
        alone. So the two cases are separated HERE, where a Board Manager gets the
        refusal and not the deletion.

        Both are gated on `canApprove()` first because the whole queue panel is only
        rendered for an approver, and a gate that exists only at render time is a
        gate that disappears the moment the panel is reused somewhere else.
      */
      if (!store.canApprove()) {
        showToast('Only the Owner or a Board Manager can decide a submission.', {
          type: 'error'
        });
        break;
      }
      if (action === 'podcast-delete' && !isOwner()) {
        showToast('Only the Owner can delete a published episode.', { type: 'error' });
        break;
      }

      // Named in the brief because it is irreversible and it deletes storage:
      // there is no second confirmation in the panel to appeal to, so the
      // browser confirm is the last thing between a mis-click and a deleted
      // recording. Both actions share one guard so the object purge can never be
      // forgotten on one path.
      if (
        !window.confirm(
          action === 'podcast-reject'
            ? `Refuse "${name}"?\n\nThe record is deleted and the MP3 is purged from storage. This cannot be undone.`
            : `Delete "${name}"?\n\nReaders lose it immediately, and the MP3 is purged from storage. This cannot be undone.`
        )
      ) {
        break;
      }
      guard(async () => {
        const result =
          action === 'podcast-reject'
            ? await decidePodcast(id, 'rejected')
            : await deletePodcast(id);
        showToast(result.message, { type: result.ok ? 'success' : 'error', duration: 6000 });
        if (!result.ok) return;
        podcastQueue = null;
        paintActiveTab();
      });
      break;
    }

    /* --- credits --- */
    // There is no scope-switcher case any more.
    //
    // About Us and Credits are two TABS now, not three views behind one button
    // row, so which page you are editing is `admin-tab-body.dataset.tab` and the
    // scope is derived from that by `tabScope()`. The `credits-scope` action and
    // the `creditsScope` module variable are both gone; leaving a handler here
    // that could set a scope would reintroduce exactly the "which page is this
    // save for?" ambiguity the split exists to remove.

    // Every one of the rest writes to public.credits_people through an RPC that
    // re-checks is_owner() in Postgres, so this client-side gate is a
    // convenience, not the enforcement.
    case 'credits-role-up':
    case 'credits-role-down': {
      // Moves a whole ROLE band, not one person. The role a band sits at on the
      // Credits page is just the sort_order of its first member, so the swap is
      // done by rebuilding one flat id list with the two bands exchanged and
      // rewriting every order in a single RPC call. A partial write would leave
      // the band split across two positions on the public page.
      const role = trigger.dataset.role;
      const direction = action === 'credits-role-up' ? -1 : 1;
      // The rows must already be in memory. If they are not, the buttons were
      // rendered against a stale panel and reordering from nothing would silently
      // rewrite the whole page's order to an empty list.
      if (!creditsPeople || creditsPeople.length < 2) {
        showToast('The Credits list is still loading. Try again in a moment.', {
          type: 'error'
        });
        return;
      }

      /*
       * SCOPE THE LIST BEFORE REORDERING.
       *
       * `creditsPeople` is the whole roster, both pages, because the panel has to
       * be able to see every row. Passing that straight to `moveRoleBand()` is
       * wrong now that pages are separate: the RPC rewrites `sort_order` from the
       * ARRAY POSITION of every id it is handed, so handing it board members
       * mixed in with Credits entries would renumber the About page's people with
       * Credits positions. The About page reads `about_order`, so the visible
       * damage is nil -- but the Credits page's own order would be corrupted by
       * the presence of rows that are not on it.
       *
       * `moveRoleBand` also uses the array to decide which BANDS exist, and a band
       * named "Contributor" appearing on both pages would otherwise be one band
       * holding both rosters' people.
       */
      const creditsOnly = rowsInScope(creditsPeople, 'credits');
      if (creditsOnly.length < 2) {
        showToast('There are not enough people on the Credits page to reorder.', {
          type: 'error'
        });
        return;
      }

      guard(async () => {
        const result = await moveRoleBand(creditsOnly, role, direction);
        if (!result.ok) {
          showToast(result.message, { type: 'error' });
          return;
        }
        await refreshCreditsPeople();
        paintActiveTab();
        showToast(result.message, { type: 'success' });
      });
      break;
    }

    case 'credits-remove':
      if (askToDelete('person', title)) {
        guard(async () => {
          const result = await removePerson(id);
          if (!result.ok) {
            showToast(result.message, { type: 'error' });
            return;
          }
          await refreshCreditsPeople();
          paintActiveTab();
          showToast('Removed from the Credits page.', { type: 'success' });
        });
      }
      break;

    case 'credits-copy-colour': {
      // "Copy role colour" lifts a colour off ONE other person onto the row
      // being edited, which is what makes a newsroom consistent: one colour per
      // department.
      //
      // The source is resolved in this order:
      //   1. data-source, when the markup names a specific person;
      //   2. otherwise the first person who is NOT the row being edited.
      //
      // Step 2 matters. The fallback used to be unconditionally `people[0]`,
      // which for a row's own button was frequently that same person -- the
      // button set the colour to the value it already had, reported success,
      // and the owner concluded the feature was broken.
      const targetId = trigger.dataset.target;
      const explicit = trigger.dataset.source;

      let sourceId = explicit || null;
      if (!sourceId) {
        const ownId = creditsPeople?.find(
          (p) => `credits-color-${p.id}` === targetId
        )?.id;

        /*
         * THE SOURCE MUST BE SOMEONE WHO IS ON SCREEN.
         *
         * `creditsPeople` is the whole roster, both pages — the panel needs it
         * that way so a row is never unreachable. But this fallback used to pick
         * "the first person who is not this one" from that list and read their
         * colour input by id, and with the pages split that first person is
         * routinely a board member whose card is NOT rendered on the Credits tab.
         * `byId()` then returned null, `copyRoleColour` had nothing to read, and
         * the button silently did nothing at all — the exact failure the comment
         * above this block was written to prevent.
         *
         * So the fallback is scoped to the tab that is open, which is also the
         * only set whose colour inputs actually exist in the DOM.
         */
        const onScreen = rowsInScope(
          creditsPeople || [],
          tabScope(byId('admin-tab-body')?.dataset.tab)
        );
        const other = onScreen.find((p) => p.id !== ownId);
        if (other) sourceId = `credits-color-${other.id}`;
      }

      if (!sourceId) {
        const onScreenCount = rowsInScope(
          creditsPeople || [],
          tabScope(byId('admin-tab-body')?.dataset.tab)
        ).length;
        showToast(
          onScreenCount
            ? 'Add a second person on this page first, then copy their accent colour.'
            : 'Add a person to this page first, then copy their accent colour.',
          { type: 'info' }
        );
        break;
      }
      copyRoleColour(sourceId, targetId);
      break;
    }

    case 'credits-clear-photo':
      guard(async () => {
        const result = await updatePerson(id, { portrait_url: '' });
        if (!result.ok) {
          showToast(result.message, { type: 'error' });
          return;
        }
        await refreshCreditsPeople();
        paintActiveTab();
      });
      break;

case 'gallery-category-delete': {
      const name = trigger.dataset.name || 'this category';
      // The store keeps the photos and only clears their category, so the
      // wording has to promise that or the Owner will think the images are gone.
      guard(async () => {
        const removed = await store.deleteGalleryCategory(id);
        if (!removed) {
          showToast('That category no longer exists.', { type: 'error' });
          return;
        }
        showToast(`Removed "${name}". Its photos were kept.`, { type: 'success' });
        paintActiveTab();
      });
      break;
    }
    /* --- media --- */
    case 'media-gallery': {
      // Read off `trigger`, not a destructured local -- `next` is not one of the
      // names pulled out of `trigger.dataset` above.
      const want = trigger.dataset.next === '1';

      // Turning a photo ON now asks which category it belongs in. Doing it the
      // other way round -- toggle first, choose later -- is what let a photo be
      // published with no category and so appear nowhere.
      if (want) {
        const item = store.listMedia().find((entry) => entry.id === id);
        if (!item) {
          showToast('That image is no longer on the shelf.', { type: 'error' });
          return;
        }
        openGalleryCategoryPicker(item);
        return;
      }

      guard(async () => {
        const item = await store.setGalleryItem(id, false, null);
        if (item) {
          showToast(
            `"${item.caption}" was removed from the Photo Gallery.`,
            { type: 'success' }
          );
        }
      });
      break;
    }

    case 'gallery-publish-in': {
      // The category the Owner picked, straight off the button. `id` is the
      // image; the picker only exists to capture the category.
      const categoryId = trigger.dataset.category || '';
      closeDialog('gallery-category-picker');
      guard(async () => {
        if (!categoryId) {
          showToast('Pick a category first.', { type: 'error' });
          return;
        }
        const category = store
          .listGalleryCategories()
          .find((cat) => cat.id === categoryId);
        const item = await store.setGalleryItem(id, true, categoryId);
        if (item) {
          showToast(
            `"${item.caption}" is now on the Photo Gallery in ${category?.name || 'that category'}.`,
            { type: 'success' }
          );
        }
        paintActiveTab();
      });
      break;
    }

    case 'media-delete':
      if (askToDelete('media')) {
        guard(async () => {
          await store.deleteMedia(id);
          showToast('Image removed from the library.', { type: 'success' });
        });
      }
      break;

    /* --- security --- */
    case 'toggle-forced':
      guard(async () => {
        const next = !store.getState().notifications.forced;
        await store.setForcedNotifications(next);
        paintActiveTab();
        showToast(
          `Forced notifications ${next ? 'enabled' : 'disabled'}.`,
          { type: 'success' }
        );
      });
      break;
    case 'reset-data':
      if (askToDelete('reset')) {
        guard(async () => {
          await store.resetLocalData();
          paintActiveTab();
          showToast('Local data reset to defaults.', { type: 'success' });
        });
      }
      break;

    /* --- reset all settings (Owner only, two steps) --- */
    case 'reset-settings':
      // Step one only: reveal the confirmation. No write happens here.
      resetArmed = true;
      paintActiveTab();
      break;

    case 'reset-settings-cancel':
      resetArmed = false;
      paintActiveTab();
      break;

    case 'reset-settings-confirm':
      // Re-check the gate. A stale armed state must not be exploitable if the
      // Owner's session changed between the click and the confirmation.
      if (!isOwner()) {
        resetArmed = false;
        paintActiveTab();
        showToast('Only the Owner can reset settings.', { type: 'error' });
        break;
      }
      resetArmed = false;
      guard(async () => {
        await store.resetAllSettings();
        // No explicit public repaint: the store subscription in app.js already
        // re-renders the masthead and banner on every commit, which is how the
        // branding and breaking-news saves behave.
        paintActiveTab();
        showToast('All settings returned to their defaults.', { type: 'success' });
      });
      break;

    /* --- account approvals --- */
    case 'accounts-refresh':
      guard(async () => {
        await reloadAccounts();
        showToast('Account list refreshed.', { type: 'success' });
      });
      break;

    case 'account-approve': {
      // The role chosen in the row's <select> is applied at approval time.
      const role = document.querySelector(`[data-account-role="${id}"]`)?.value || 'Writer';
      guard(async () => {
        await approveAccount(id, role);
        showToast(`Account approved as ${role}.`, { type: 'success' });
        await reloadAccounts();
      });
      break;
    }

    case 'account-reject':
      if (
        window.confirm(
          username
            ? `Refuse the request from @${username}? They will not be able to sign in.`
            : 'Refuse this request? They will not be able to sign in.'
        )
      ) {
        guard(async () => {
          await rejectAccount(id);
          showToast('Request refused.', { type: 'success' });
          await reloadAccounts();
        });
      }
      break;

    case 'account-password':
      openPasswordResetDialog(id, username);
      break;

    case 'account-remove':
      if (
        window.confirm(
          `Remove @${username}? They will be signed out immediately and will have to register again.`
        )
      ) {
        guard(async () => {
          await rejectAccount(id);
          showToast(`@${username} removed.`, { type: 'success' });
          await reloadAccounts();
        });
      }
      break;

    default:
      console.warn('[admin] unhandled action', action);
  }
}

