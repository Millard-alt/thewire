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
  setAccountPassword
} from '../lib/auth.js';
import { getReleases, pendingCount, sectionIcon } from '../lib/changelog.js';
import { config, describeBackend } from '../lib/config.js';
import {
  sendBroadcastToDevices,
  ensureAlertPermission
} from './alerts.js';
import * as push from '../lib/push.js';
import { uploadImage, bindImagePicker } from '../lib/upload.js';
import {
  listCredits,
  listCreditsForOwner,
  addPerson,
  updatePerson,
  removePerson,
  assignPortrait,
  setPortraitStatus,
  primePortraits,
  isCreditsMigrationMissing,
  normaliseColour,
  readableOn
} from '../lib/credits.js';
import {
  escapeHtml,
  safeUrl,
  byId,
  openDialog,
  closeDialog,
  releaseDialogLocks,
  showToast,
  formatEditionDate
} from '../lib/dom.js';

/** Which article statuses the Content Desk is filtered to. */
let contentFilter = 'all';
/** Which tab is showing. Not persisted — the workspace always opens on Overview. */
let activeTab = 'overview';
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
      'fill="#8c1d11" text-anchor="middle">The Wire</text></svg>'
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

  return `
    <div class="space-y-6">
      ${panelHeader('Newsroom overview', `Backend: ${backend.label}`,
        `<button class="btn btn-ghost" data-action="refresh">
           <i class="fa-solid fa-rotate" aria-hidden="true"></i> Refresh
         </button>`)}

      <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        ${metrics
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

      <div class="grid gap-6 lg:grid-cols-2">
        <section>
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
        </section>

        <section>
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
        </section>
      </div>
  `;
}

/* -------------------------------------------------------------------------- */
/* Tab 2 — Content Desk                                                        */
/* -------------------------------------------------------------------------- */

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
        NEW_ARTICLE_BUTTON
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
                <button class="btn btn-ghost" data-action="article-edit"
                  data-id="${escapeHtml(article.id)}">
                  <i class="fa-solid fa-pen" aria-hidden="true"></i> Edit
                </button>
                ${
                  String(article.status || '').toLowerCase() === 'pending review'
                    ? `<button class="btn btn-ghost" data-action="article-publish"
                        data-id="${escapeHtml(article.id)}">Approve</button>`
                    : `<button class="btn btn-ghost" data-action="article-reject"
                        data-id="${escapeHtml(article.id)}">Unpublish</button>`
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
/* Tab 4 — Breaking News Banner                                                */
/* -------------------------------------------------------------------------- */

function renderBreakingTab() {
  const breaking = store.getState().breakingNews;

  return `
    <div class="space-y-5">
      ${panelHeader(
        'Breaking news banner',
        'The real-time alert strip that runs above the masthead'
      )}

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

          <label class="switch ml-auto" for="breaking-dismissible">
            <input id="breaking-dismissible" type="checkbox" ${
              breaking.dismissible ? 'checked' : ''
            } />
            <span class="switch-track"></span>
            <span class="switch-thumb"></span>
          </label>
          <label class="field-label mb-0" for="breaking-dismissible">
            Readers may dismiss it
          </label>
        </div>

        <div class="grid gap-4 sm:grid-cols-2">
          <div>
            <label class="field-label" for="breaking-label">Label</label>
            <input id="breaking-label" class="field" type="text"
              value="${escapeHtml(breaking.label)}" />
          </div>
          <div>
            <label class="field-label" for="breaking-severity">Severity</label>
            <select id="breaking-severity" class="field">
              ${['Breaking', 'Developing', 'Advisory']
                .map(
                  (option) =>
                    `<option value="${option}" ${
                      breaking.severity === option ? 'selected' : ''
                    }>${option}</option>`
                )
                .join('')}
            </select>
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

        <div class="grid gap-4 sm:grid-cols-2">
          <div>
            <label class="field-label" for="breaking-link-text">Link text</label>
            <input id="breaking-link-text" class="field" type="text"
              value="${escapeHtml(breaking.linkText)}" />
          </div>
          <div>
            <label class="field-label" for="breaking-link-url">Link URL</label>
            <input id="breaking-link-url" class="field" type="text"
              value="${escapeHtml(breaking.linkUrl)}" />
          </div>
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
            <strong class="text-[0.7rem]">In-app delivery.</strong>
            A broadcast is saved to the database and raised as a notification on
            devices that currently have The Wire open. Reaching a reader whose tab
            is closed needs a Web Push sender, which is not connected yet — so
            treat the audience as staff currently reading, not the whole readership.
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
              ${['Everyone', 'Writers', 'Assignment Managers']
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
  const options = published
    .map(
      (article) =>
        `<option value="${escapeHtml(article.id)}">${escapeHtml(article.title)}</option>`
    )
    .join('');

  const slot = (key, label) => `
    <div>
      <label class="field-label" for="slot-${key}">${escapeHtml(label)}</label>
      <select id="slot-${key}" class="field" data-slot="${key}">
        ${options}
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
        <div>
          <label class="field-label" for="slot-todays-pick">Today's pick</label>
          <select id="slot-todays-pick" class="field" data-slot="todaysPick">
            ${options}
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

function renderStaffTab() {
  const staff = store.listStaff();

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
        <table class="w-full text-left text-sm">
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
                      ? `<img class="byline-sticker" src="${escapeHtml(
                          safeUrl(member.portrait_url)
                        )}" alt="" width="48" height="48" loading="lazy" decoding="async" />`
                      : `<span class="byline-sticker byline-sticker-empty" aria-hidden="true">
                           <i class="fa-solid fa-user"></i>
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
            </span>`;
  }

  if (status === 'rejected') {
    return `<span class="badge badge-amber" title="Waiting on a new upload">
              <i class="fa-solid fa-rotate" aria-hidden="true"></i> Rejected
            </span>`;
  }

  return '';
}


function renderMediaTab() {
  const media = store.listMedia();

  return `
    <div class="space-y-5">
      ${panelHeader(
        'Media library',
        'Shared image shelf used across the publication'
      )}

      <form id="media-form" class="panel-raised grid gap-4 p-5 sm:grid-cols-[2fr_2fr_auto]" novalidate>
        <div>
          <label class="field-label" for="media-file">Image from your device</label>
          <input
            id="media-file"
            class="field"
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif,image/avif"
          />
        </div>
        <div>
          <label class="field-label" for="media-url">...or an image URL</label>
          <input id="media-url" class="field" type="text" placeholder="https://…" />
        </div>
        <div>
          <label class="field-label" for="media-caption">Caption</label>
          <input id="media-caption" class="field" type="text" placeholder="Council session, Tuesday" />
        </div>
        <div class="flex items-end sm:col-span-3">
          <button type="submit" class="btn btn-accent w-full sm:w-auto">
            <i class="fa-solid fa-upload" aria-hidden="true"></i> Add
          </button>
        </div>
      </form>

      ${
        media.length
          ? `<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        ${media
          .map(
            (item) => `
          <figure class="panel-raised overflow-hidden">
            <img class="h-40 w-full object-cover" src="${escapeHtml(
              artFor(item.url)
            )}" alt="${escapeHtml(item.caption)}" loading="lazy" />
            <figcaption class="space-y-2 p-3">
              <span class="block min-w-0 truncate text-xs">${escapeHtml(item.caption)}</span>
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
        ${store.listGallery().length} of ${media.length} image${
          media.length === 1 ? '' : 's'
        } currently appear on the public Photo Gallery.
      </p>
    </div>
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
                ${['Active', 'Suspended']
                  .map(
                    (status) =>
                      `<option value="${status}">${status}</option>`
                  )
                  .join('')}
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
              <label class="field-label" for="assignment-reporter">Assigned to</label>
              <input
                id="assignment-reporter"
                class="field"
                type="text"
                placeholder="Leave blank to leave it open"
              />
            </div>
            <div>
              <label class="field-label" for="assignment-deadline">Deadline</label>
              <input id="assignment-deadline" class="field" type="text" />
            </div>
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
    ['Edit other people’s drafts', true],
    ['Send broadcasts', true],
    ['Upload media', true],
    ['Approve & suspend accounts', false],
    ['Approve portraits', true],
    ['Curate the credits board', true]
  ],
  Writer: [
    ['Publish anything', true],
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
               <table class="w-full text-left text-sm">
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
/* Tab - Credits (public page)                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Rows load asynchronously, so the latest fetch is kept here and the tab
 * repainted when it lands. Named `creditsPeople` rather than the old
 * `creditsRoster` because it no longer mirrors the staff roster: these are
 * hand-picked entries, most of which have no account at all.
 */
let creditsPeople = null;

/**
 * Re-read the Credits page from the database.
 *
 * Every write goes through here so the Owner never sees a card the database
 * has already forgotten. A failure returns the previous list rather than
 * blanking the tab, because a network blip is not a reason to make the Owner
 * think their whole page was deleted.
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
 * The Credits page as the Owner edits it.
 *
 * This tab is OWNER-ONLY. The page itself is a curated list of people, not a
 * roster of accounts, and the whole point of the redesign is that only the Owner
 * decides who appears. `TABS` enforces that client-side and every write RPC in
 * supabase/009_credits_page.sql re-checks `is_owner()` server-side, so the
 * restriction survives a leaked anon key.
 *
 * Rows load asynchronously, so it returns a loading placeholder and fills itself
 * in when the page arrives.
 */
function renderCreditsTab() {
  const body = byId('admin-tab-body');
  if (!body) return '';

  // Guard the live session, not a cached value: someone signed in before a
  // demotion must not keep reading this tab.
  if (!isOwner()) {
    return emptyState('Only the Owner can edit the Credits page.', 'fa-lock');
  }

  if (creditsPeople) return creditsPanel(creditsPeople);

  listCreditsForOwner().then((people) => {
    creditsPeople = people;
    if (!body.isConnected || body.dataset.tab !== 'credits') return;
    body.innerHTML = creditsPanel(people);
  });

  return `<div class="panel-sunken p-10 text-center">
    <i class="fa-solid fa-circle-notch spin-slow ink-muted text-xl" aria-hidden="true"></i>
    <p class="ink-muted mt-3 text-sm">Loading the Credits page…</p>
  </div>`;
}

/** Colour a new person starts from, so the picker is never empty. */
const DEFAULT_ROLE_COLOR = '#c8102e';

/**
 * Render the Credits editor: an "add someone" form plus one card per person.
 *
 * @param {Array<object>} people
 */
function creditsPanel(people) {
  return `
    <div class="space-y-5">
      ${panelHeader(
        'Credits page',
        `${people.length} ${people.length === 1 ? 'person' : 'people'} listed` +
          ' · only people you add here appear on the page',
        `<a class="btn btn-ghost" href="#credits" data-nav="credits">
           <i class="fa-solid fa-eye" aria-hidden="true"></i> Preview page
         </a>`
      )}

      <p class="panel-sunken p-4 text-xs ink-muted">
        <i class="fa-solid fa-circle-info" aria-hidden="true"></i>
        This page is a list of <strong>people</strong>, not of accounts. Adding
        someone here creates no login and grants no access — it only puts their
        name, photo and role on the public page. The role is free text, so you can
        write anything you like, and each role carries its own colour.
      </p>

      ${creditsAddForm(people)}

      ${
        people.length
          ? `<ul class="space-y-4">${people.map(creditsPersonCard).join('')}</ul>`
          : isCreditsMigrationMissing()
            ? `<div class="panel-raised p-6 text-sm">
                 <p class="flex items-center gap-2 font-bold">
                   <i class="fa-solid fa-database ink-muted" aria-hidden="true"></i>
                   Database migration not applied yet
                 </p>
                 <p class="ink-muted mt-2">
                   The Credits page table does not exist in your Supabase project, so
                   it cannot be read or saved. Run
                   <code>supabase/009_credits_page.sql</code> in the Supabase SQL
                   Editor, then reopen this tab.
                 </p>
               </div>`
            : emptyState(
                'Nobody is on the Credits page yet. Add the first person above.',
                'fa-id-badge'
              )
      }
    </div>
  `;
}

/**
 * One person's card: photo, name, free-text role with its colour, blurb, order.
 *
 * The role is free text rather than a dropdown of staff roles on purpose: a
 * credits page credits contributors, and contributors are not all accounts.
 * Whatever the Owner types is what appears.
 *
 * @param {{id: string, name: string, role_label: string, role_color: string,
 *          blurb: string, portrait_url: string, sort_order: number}} person
 */
function creditsPersonCard(person) {
  const id = escapeHtml(person.id || '');
  const colour = normaliseColour(person.role_color) || DEFAULT_ROLE_COLOR;
  const order = Number(person.sort_order) || 100;
  const name = escapeHtml(person.name || 'Unnamed');

  return `
    <li class="panel-raised p-4" data-credits-row="${id}">
      <form class="space-y-3" data-credits-form="${id}" novalidate>
        <div class="flex items-start gap-3">
          ${avatar(person, 56)}

          <div class="min-w-0 flex-1">
            <label class="field-label" for="credits-name-${id}">Name</label>
            <input id="credits-name-${id}" class="field" type="text" maxlength="80"
              data-credits-name value="${name}" />
          </div>

          <button type="button" class="btn btn-ghost shrink-0 text-rose-600"
            data-action="credits-remove" data-id="${id}"
            aria-label="Remove ${name} from the Credits page">
            <i class="fa-solid fa-trash" aria-hidden="true"></i>
          </button>
        </div>

        <div class="grid gap-3 sm:grid-cols-2">
          <div>
            <label class="field-label" for="credits-role-${id}">Role</label>
            <input id="credits-role-${id}" class="field" type="text" maxlength="60"
              data-credits-role value="${escapeHtml(person.role_label || '')}" />
          </div>
          <div>
            <label class="field-label" for="credits-order-${id}">Order</label>
            <input id="credits-order-${id}" class="field" type="number" min="1"
              max="999" data-credits-order value="${order > 0 ? order : 100}" />
          </div>
        </div>

        <div>
          <label class="field-label" for="credits-blurb-${id}">Note (optional)</label>
          <textarea id="credits-blurb-${id}" class="field" rows="2" maxlength="220"
            data-credits-blurb>${escapeHtml(person.blurb || '')}</textarea>
        </div>

        <div class="flex flex-wrap items-center gap-2">
          <input id="credits-color-${id}" type="color"
            class="h-10 w-12 shrink-0 cursor-pointer rounded-lg border
              border-ink/20 bg-transparent p-1"
            data-credits-color value="${colour}"
            aria-label="Role colour for ${name}" />

          <span class="badge" style="background:${colour};color:${readableOn(colour)}">
            ${escapeHtml(person.role_label || 'Contributor')}
          </span>

          <button type="button" class="btn btn-ghost"
            data-action="credits-copy-colour" data-target="credits-color-${id}"
            data-source="">
            <i class="fa-solid fa-copy" aria-hidden="true"></i> Copy role colour
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
 * Circular avatar for a Credits card, falling back to initials.
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
    return `<img src="${url}" alt="${escapeHtml(person.name || '')}" loading="lazy"
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


/**
 * The "Add new person" form.
 *
 * A photo is optional — plenty of contributors deserve a credit without a
 * portrait, and the card falls back to their initials. Name and role are
 * required, because a nameless card on a credits page is worse than no card.
 *
 * @param {Array<object>} people  used to offer existing roles as suggestions
 */
function creditsAddForm(people) {
  const used = [...new Set(people.map((p) => p.role_label).filter(Boolean))];

  return `
    <form id="credits-add-form" class="panel-raised space-y-4 p-4" novalidate>
      <div class="flex items-center gap-2">
        <i class="fa-solid fa-user-plus ink-accent" aria-hidden="true"></i>
        <h3 class="text-sm font-black tracking-tight">Add new person</h3>
      </div>

      <div class="grid gap-3 sm:grid-cols-2">
        <div>
          <label class="field-label" for="credits-add-name">Name</label>
          <input id="credits-add-name" class="field" type="text" maxlength="80"
            placeholder="Amina Mohamed" required />
        </div>
        <div>
          <label class="field-label" for="credits-add-role">Role</label>
          <input id="credits-add-role" class="field" type="text" maxlength="60"
            list="credits-role-suggestions" placeholder="Photographer" required />
          <datalist id="credits-role-suggestions">
            ${used.map((role) => `<option value="${escapeHtml(role)}"></option>`).join('')}
          </datalist>
          <p class="mt-1 text-[0.6875rem] ink-muted">
            Any wording you like. It does not have to match a staff role.
          </p>
        </div>
      </div>

      <div class="grid gap-3 sm:grid-cols-2">
        <div>
          <label class="field-label" for="credits-add-photo">Photo</label>
          <input id="credits-add-photo" class="field" type="file"
            accept="image/jpeg,image/png,image/webp" />
        </div>
        <div>
          <label class="field-label" for="credits-add-color">Role colour</label>
          <div class="flex items-center gap-2">
            <input id="credits-add-color" type="color"
              class="h-11 w-14 shrink-0 cursor-pointer rounded-lg border
                border-ink/20 bg-transparent p-1"
              value="${DEFAULT_ROLE_COLOR}" />
            <button type="button" class="btn btn-ghost shrink-0"
              data-action="credits-copy-colour" data-target="credits-add-color"
              data-source="">
              <i class="fa-solid fa-copy" aria-hidden="true"></i> Copy role colour
            </button>
          </div>
        </div>
      </div>

      <details class="text-xs">
        <summary class="cursor-pointer ink-muted">Or paste a photo URL</summary>
        <input id="credits-add-url" class="field mt-2" type="url"
          placeholder="https://…" />
      </details>

      <div>
        <label class="field-label" for="credits-add-blurb">One line about them</label>
        <input id="credits-add-blurb" class="field" type="text" maxlength="300"
          placeholder="Covers local government and civic affairs." />
      </div>

      <button type="submit" class="btn btn-accent w-full sm:w-auto">
        <i class="fa-solid fa-plus" aria-hidden="true"></i> Add to Credits page
      </button>
    </form>
  `;
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
const TABS = [
  { id: 'overview', label: 'Overview', icon: 'fa-gauge-high', render: renderOverview, minRole: 'Writer' },
  { id: 'content', label: 'Content', icon: 'fa-newspaper', render: renderContent, minRole: 'Writer' },
  { id: 'accounts', label: 'Accounts', icon: 'fa-user-check', render: renderAccountsTab, ownerOnly: true },
  { id: 'assignments', label: 'Assignments', icon: 'fa-clipboard-list', render: renderAssignmentsTab, minRole: 'Writer' },
  { id: 'breaking', label: 'Breaking', icon: 'fa-bolt', render: renderBreakingTab, minRole: 'Board Manager' },
  { id: 'broadcasts', label: 'Broadcasts', icon: 'fa-paper-plane', render: renderBroadcastsTab, minRole: 'Board Manager' },
  { id: 'curation', label: 'Curation', icon: 'fa-star', render: renderCurationTab, minRole: 'Board Manager' },
  { id: 'staff', label: 'Staff', icon: 'fa-users', render: renderStaffTab, minRole: 'Board Manager' },
  // Owner only. The Credits page is a hand-curated public page, not a view of
  // the staff roster: anybody the Owner chooses to list appears, and nobody
  // listed by an account gets in automatically. A Board Manager must not be
  // able to add or remove names from it.
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
}

/** Attach the device-upload pickers to whatever is currently on screen. */
function bindFilePickers() {
  const pairs = [
    ['media-file', 'media-url'],
    ['article-image-file', 'article-image']
  ];

  pairs.forEach(([fileId, urlId]) => {
    const fileInput = byId(fileId);
    const urlInput = byId(urlId);
    if (!fileInput || !urlInput) return;
    if (fileInput.dataset.bound === 'true') return;
    fileInput.dataset.bound = 'true';
    bindImagePicker(fileInput, urlInput);
  });
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
      ${staffEditorDialog()}
      ${assignmentEditorDialog()}
      ${passwordResetDialog()}
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
  const publication = byId('publication-view');
  if (!host) return false;

  if (isMounted) {
    paintActiveTab();
    return true;
  }

  host.innerHTML = shellMarkup();
  host.classList.remove('hidden');
  host.classList.add('admin-mode');
  publication?.classList.add('hidden');
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
  byId('publication-view')?.classList.remove('hidden');
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
    } else if (form.id === 'staff-form') {
      event.preventDefault();
      guard(() => saveStaffFromForm(form));
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
    }
  });

  // The article editor's own file input is NOT a submit button, so it never
  // reaches the delegated submit listener above. Bind it once here, lazily,
  // when the editor dialog is first opened.

  // "Keep me signed in"-style switches and inline selects.
  document.addEventListener('change', (event) => handleChange(event));
}

/* -------------------------------------------------------------------------- */
/* Form persistence                                                            */
/* -------------------------------------------------------------------------- */

/** CREATE or UPDATE an article from the editor dialog. */
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

  const payload = {
    title: byId('article-title').value,
    author: byId('article-author').value,
    category: byId('article-category').value,
    status: byId('article-status').value,
    date: byId('article-date').value,
    image: byId('article-image').value.trim(),
    caption: byId('article-caption').value,
    body: byId('article-body').value,
    featured: byId('article-featured').checked
  };

  if (!payload.title.trim()) {
    showToast('Every dispatch needs a headline.', { type: 'error' });
    byId('article-title').focus();
    return;
  }

  if (editingArticleId) {
    await store.updateArticle(editingArticleId, payload);
    showToast('Article updated.', { type: 'success' });
  } else {
    await store.createArticle(payload);
    showToast('Article created and added to the desk.', { type: 'success' });
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
    role: byId('staff-role').value,
    status: byId('staff-status').value
  };

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
      const { url, isLocal } = await uploadImage(pendingFile);
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
 * Add an image to the shared shelf. The editor can either upload a file from
 * their device or paste a URL; the picker writes the uploaded URL into
 * `#media-url`, and this handler reads whichever one is present.
 */
async function saveMediaFromForm(form) {
  const urlField = byId('media-url');
  const pending = byId('media-file')?.files?.[0];

  if (pending) {
    const busy = showToast('Uploading your image...', { type: 'info', duration: 0 });
    try {
      const { url, isLocal } = await uploadImage(pending);
      urlField.value = url;
      busy.remove();
      if (isLocal) {
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

  const url = urlField?.value.trim();
  if (!url) {
    showToast('Choose a file from your device, or paste an image URL.', {
      type: 'error'
    });
    return;
  }

  await store.createMedia({
    url,
    caption: byId('media-caption')?.value.trim() || 'Untitled image'
  });

  form.reset();
  showToast('Image added to the media shelf.', { type: 'success' });
}

/** CREATE or UPDATE an assignment from the editor dialog. */
async function saveAssignmentFromForm(form) {
  const payload = {
    title: byId('assignment-title').value,
    reporter: byId('assignment-reporter').value,
    status: byId('assignment-status').value,
    deadline: byId('assignment-deadline').value
  };

  if (!payload.title.trim()) {
    showToast('Give the pitch a title before saving.', { type: 'error' });
    return;
  }

  if (editingAssignmentId) {
    await store.updateAssignment(editingAssignmentId, payload);
    showToast('Assignment updated.', { type: 'success' });
  } else {
    await store.createAssignment(payload);
    showToast('Assignment published to the board.', { type: 'success' });
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

  /* --- Breaking news banner --------------------------------------------- */
  if (target.id === 'breaking-enabled') {
    guard(async () => {
      await store.saveBreakingNews({ enabled: target.checked });
      paintActiveTab();
    });
    return;
  }
  if (target.id === 'breaking-sticky' || target.id === 'breaking-dismissible') {
    guard(async () => {
      await store.saveBreakingNews({
        [target.id.replace('breaking-', '')]: target.checked
      });
      paintActiveTab();
    });
    return;
  }
  if (target.id === 'breaking-severity' || target.id === 'breaking-color') {
    guard(async () => {
      await store.saveBreakingNews({ [target.id.replace('breaking-', '')]: target.value });
      paintActiveTab();
    });
    return;
  }

  /* --- Curation ---------------------------------------------------------- */
  if (target.id === 'curate-todays-pick') {
    guard(async () => {
      await store.saveCuration({ todaysPickId: target.value });
      paintActiveTab();
    });
    return;
  }
  if (target.id.startsWith('curate-slot-')) {
    const slot = target.id.replace('curate-slot-', '');
    guard(async () => {
      await store.saveCuration({
        weeklySlots: { [slot]: target.value }
      });
      paintActiveTab();
    });
    return;
  }

  /* --- Account roles ------------------------------------------------------- */
  // Only a *saved* row (an approved account) writes immediately. On a pending
  // request the role is just the value to be used by the Approve button, so
  // changing it must not persist anything.
  if (target instanceof HTMLSelectElement && target.dataset.accountSaved) {
    const id = target.dataset.accountSaved;
    guard(async () => {
      await approveAccount(id, target.value);
      showToast(`Role updated to ${target.value}.`, { type: 'success' });
      await reloadAccounts();
    });
  }
}

/**
 * Persist every field of the breaking-news banner in one write. The individual
 * switches already autosave through `handleChange`; this catches the text
 * inputs, which have no `change` handler of their own.
 */
async function saveBreakingFromForm() {
  const label = byId('breaking-label')?.value.trim() || '';
  const headline = byId('breaking-headline')?.value.trim() || '';
  const subtext = byId('breaking-subtext')?.value.trim() || '';
  const linkText = byId('breaking-link-text')?.value.trim() || '';
  const linkUrl = byId('breaking-link-url')?.value.trim() || '';
  const severity = byId('breaking-severity')?.value || 'Breaking';
  const enabled = byId('breaking-enabled')?.checked ?? false;

  if (enabled && !headline) {
    showToast('A live banner needs a headline, or readers will see an empty strip.', {
      type: 'error'
    });
    byId('breaking-headline')?.focus();
    return;
  }

  await store.saveBreakingNews({
    label,
    headline,
    subtext,
    linkText,
    linkUrl,
    severity,
    enabled
  });

  showToast(
    enabled ? 'Banner saved and live on the public site.' : 'Banner saved but hidden.',
    { type: 'success' }
  );
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
async function saveCreditsFromForm(form) {
  const personId = form.dataset.creditsForm;
  if (!personId) return;

  const name = form.querySelector('[data-credits-name]')?.value.trim() || '';
  if (!name) {
    showToast('A person needs a name.', { type: 'error' });
    return;
  }

  const orderRaw = Number(form.querySelector('[data-credits-order]')?.value);
  const order = Number.isFinite(orderRaw)
    ? Math.min(999, Math.max(1, Math.round(orderRaw)))
    : 100;

  const result = await updatePerson(personId, {
    name,
    role_label: form.querySelector('[data-credits-role]')?.value.trim() || '',
    role_color: form.querySelector('[data-credits-color]')?.value || '',
    blurb: form.querySelector('[data-credits-blurb]')?.value.trim() || '',
    sort_order: order
  });

  if (!result.ok) {
    showToast(result.message, { type: 'error' });
    return;
  }

  showToast(`${name} saved to the Credits page.`, { type: 'success' });
  await refreshCreditsPeople();
  paintActiveTab();
}

/**
 * Add a brand-new person to the Credits page.
 *
 * Note what is NOT required here: an account, a username, an e-mail or a staff
 * role. The Owner types any role they like and picks its colour. That is the
 * whole point of the page -- it credits contributors, who are not all staff.
 *
 * @param {HTMLFormElement} form
 */
async function addCreditsPersonFromForm(form) {
  const name = byId('credits-add-name')?.value.trim() || '';
  const role = byId('credits-add-role')?.value.trim() || '';

  if (!name || !role) {
    showToast('A person needs both a name and a role.', { type: 'error' });
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
    portraitUrl: portrait
  });

  if (!result.ok) {
    showToast(result.message, { type: 'error' });
    return;
  }

  form.reset();
  await refreshCreditsPeople();
  paintActiveTab();
  showToast(`${name} added to the Credits page.`, { type: 'success' });
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

/**
 * Compose a broadcast and hand it to the delivery layer, which shows a real
 * notification popup on every opted-in device (and records the send in the
 * history table).
 */
async function sendBroadcastFromForm(form) {
  const title = byId('broadcast-title')?.value.trim() || '';
  const message = byId('broadcast-message')?.value.trim() || '';
  const audience = byId('broadcast-audience')?.value || 'Everyone';

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
          'Allow notifications for The Wire on this device, then send again — ' +
            'otherwise you cannot see the alert to confirm it works.',
          { type: 'info', duration: 9000 }
        );
        return;
      }
    }

    const result = await sendBroadcastToDevices({ title, message, audience });
    form.reset();
    paintActiveTab();
    // Be precise about what happened. `sent` is the row's delivered_count, which
    // only counts devices a Web Push sender actually reached — and no sender is
    // connected yet, so it is legitimately 0 even on a successful send. Claiming
    // "N devices notified" there would be a lie the owner acts on.
    showToast(
      result.popped
        ? 'Broadcast saved and shown on this device. Other devices pick it up on their next refresh.'
        : 'Broadcast saved. This device blocked the popup — allow notifications to see it here.',
      { type: result.popped ? 'success' : 'info', duration: 7000 }
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
  byId('article-caption').value = article?.caption ?? '';
  byId('article-body').value = article?.body ?? '';
  byId('article-featured').checked = Boolean(article?.featured);

  openDialog('article-editor', { initialFocus: '#article-title' });
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
  byId('staff-status').value = member?.status ?? 'Active';

  // Always start from a blank portrait field. The file input keeps its value
  // across dialog openings, so without this the photo picked for one staffer
  // would silently attach to the next person the Owner hires.
  byId('staff-portrait-url').value = '';
  if (byId('staff-portrait-file')) byId('staff-portrait-file').value = '';

  openDialog('staff-editor', { initialFocus: '#staff-name' });
}

/** Open the assignment editor. */
function openAssignmentEditor(assignmentId) {
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
  byId('assignment-deadline').value = item?.deadline ?? '';

  openDialog('assignment-editor', { initialFocus: '#assignment-title' });
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
    case 'article-new':
      openArticleEditor(null);
      break;
    case 'article-edit':
      openArticleEditor(id);
      break;
    case 'article-publish':
      guard(async () => {
        await store.publishArticle(id);
        showToast('Article approved and published.', { type: 'success' });
      });
      break;
    case 'article-reject':
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

    /* --- credits --- */
    // Every one of these writes to public.credits_people through an RPC that
    // re-checks is_owner() in Postgres, so this client-side gate is a
    // convenience, not the enforcement.
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
        const other = (creditsPeople || []).find((p) => p.id !== ownId);
        if (other) sourceId = `credits-color-${other.id}`;
      }

      if (!sourceId) {
        showToast(
          (creditsPeople || []).length
            ? 'Add a second person first, then copy their role colour.'
            : 'Add a person first, then copy their role colour.',
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

    /* --- media --- */
    case 'media-gallery': {
      // Read off `trigger`, not a destructured local — `next` is not one of the
      // names pulled out of `trigger.dataset` above.
      const want = trigger.dataset.next === '1';
      guard(async () => {
        const item = await store.setGalleryItem(id, want);
        if (item) {
          showToast(
            want
              ? `"${item.caption}" is now on the Photo Gallery.`
              : `"${item.caption}" was removed from the Photo Gallery.`,
            { type: 'success' }
          );
        }
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

