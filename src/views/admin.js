/* =============================================================================
   src/views/admin.js — OWNER CONTROL CENTER
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
import { signOut, isAdmin } from '../lib/auth.js';
import { config, describeBackend } from '../lib/config.js';
import {
  sendBroadcastToDevices,
  ensureAlertPermission
} from './alerts.js';
import * as push from '../lib/push.js';
import { uploadImage, bindImagePicker } from '../lib/upload.js';
import {
  escapeHtml,
  safeUrl,
  byId,
  openDialog,
  closeDialog,
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
                <button class="btn btn-quiet" data-action="article-delete"
                  data-id="${escapeHtml(article.id)}"
                  data-title="${escapeHtml(article.title)}">
                  <i class="fa-solid fa-trash" aria-hidden="true"></i>
                  <span class="sr-only">Delete</span>
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
              ${['Everyone', 'Editors', 'Assignment Managers']
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

export const STAFF_ROLES = [
  'Owner',
  'Editor',
  'Assignment Manager',
  'Staff Writer',
  'Contributor'
];

function renderStaffTab() {
  const staff = store.listStaff();

  return `
    <div class="space-y-5">
      ${panelHeader(
        'Staff directory',
        'Roles here are authoritative — they gate the Owner Control Center',
        `<button class="btn btn-accent" data-action="staff-new">
           <i class="fa-solid fa-user-plus" aria-hidden="true"></i> Add staffer
         </button>`
      )}

      <div class="panel-raised overflow-x-auto">
        <table class="w-full text-left text-sm">
          <thead class="rule-soft border-b">
            <tr class="ink-muted text-[0.65rem] tracking-[0.12em] uppercase">
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
                  <div class="flex justify-end gap-1">
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
                : `<tr><td colspan="5" class="px-4 py-8 text-center">
                     ${emptyState('No staff records yet.', 'fa-users')}
                   </td></tr>`
            }
          </tbody>
        </table>
      </div>

      <p class="ink-muted text-xs">
        <i class="fa-solid fa-circle-info" aria-hidden="true"></i>
        Creating a staff row does not create a login. In production, invite the
        person from Supabase Auth first, then link them here by e-mail.
      </p>
    </div>
  `;
}


/* -------------------------------------------------------------------------- */
/* Tab 9 — Media Library                                                       */
/* -------------------------------------------------------------------------- */

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
                  <i class="fa-solid ${item.inGallery ? fa-eyeSlash() : faImages()}" aria-hidden="true"></i>
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
    </div>
  `;
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
/* Tab registry                                                                */
/* -------------------------------------------------------------------------- */

/** Every workspace tab: label, icon, renderer. */
const TABS = [
  { id: 'overview', label: 'Overview', icon: 'fa-gauge-high', render: renderOverview },
  { id: 'content', label: 'Content', icon: 'fa-newspaper', render: renderContent },
  { id: 'assignments', label: 'Assignments', icon: 'fa-clipboard-list', render: renderAssignmentsTab },
  { id: 'breaking', label: 'Breaking', icon: 'fa-bolt', render: renderBreakingTab },
  { id: 'broadcasts', label: 'Broadcasts', icon: 'fa-paper-plane', render: renderBroadcastsTab },
  { id: 'curation', label: 'Curation', icon: 'fa-star', render: renderCurationTab },
  { id: 'staff', label: 'Staff', icon: 'fa-users', render: renderStaffTab },
  { id: 'branding', label: 'Branding', icon: 'fa-font', render: renderBrandingTab },
  { id: 'media', label: 'Media', icon: 'fa-images', render: renderMediaTab },
  { id: 'security', label: 'Security', icon: 'fa-shield-halved', render: renderSecurityTab }
];

/** Repaint the active tab and sync the tab buttons. */
function paintActiveTab() {
  const body = byId('admin-tab-body');
  if (!body) return;

  const tab = TABS.find((entry) => entry.id === activeTab) || TABS[0];
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
  if (!TABS.some((tab) => tab.id === tabId)) return;
  activeTab = tabId;
  paintActiveTab();
}
/* -------------------------------------------------------------------------- */
/* Shell                                                                       */
/* -------------------------------------------------------------------------- */

/** Full-page markup for the Owner Control Center. */
function shellMarkup() {
  const tabButtons = TABS.map(
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
            <i class="fa-solid fa-lock" aria-hidden="true"></i> Owner Control Center
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
          ${tabButtons}
        </nav>
        <main id="admin-tab-body" class="admin-body" tabindex="-1"></main>
      </div>

      ${articleEditorDialog()}
      ${staffEditorDialog()}
      ${assignmentEditorDialog()}
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
    showToast('You do not have access to the Owner Control Center.', {
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
}

/** True while the control centre is on screen. */
export function isAdminOpen() {
  return isMounted;
}

/* -------------------------------------------------------------------------- */
/* Delegated event handling                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Attach the delegated listeners the workspace needs. Guarded so re-opening the
 * control centre never stacks duplicate handlers.
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

  if (editingStaffId) {
    await store.updateStaff(editingStaffId, payload);
    showToast('Staff record updated.', { type: 'success' });
  } else {
    await store.createStaff(payload);
    showToast('Staff record provisioned.', { type: 'success' });
  }

  editingStaffId = null;
  closeDialog('staff-editor');
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
  byId('staff-role').value = member?.role ?? 'Editor';
  byId('staff-status').value = member?.status ?? 'Active';

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

  const { action, id, title, name, filter } = trigger.dataset;

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
    case 'article-delete':
      if (askToDelete('article', title)) {
        guard(async () => {
          await store.deleteArticle(id);
          showToast('Article deleted.', { type: 'success' });
        });
      }
      break;

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

    /* --- media --- */
    case 'media-gallery': {
      const want = target.dataset.next === '1';
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

    default:
      console.warn('[admin] unhandled action', action);
  }
}

