/* =============================================================================
   src/lib/store.js — DATA ACCESS / CRUD LAYER
   -----------------------------------------------------------------------------
   One repository, two backends:

     • Supabase (production) — every read hits PostgREST, every write is
       guarded by the Row Level Security policies in supabase/schema.sql.
     • localStorage (demo)    — used automatically when the Supabase env vars
       are absent or VITE_DEMO_MODE=true, so the site is fully explorable
       with zero backend setup.

   The in-memory `state` object is the single source of truth for rendering.
   Every mutating function follows the same shape:
       1. write to the backend (Supabase or localStorage)
       2. update the in-memory state
       3. notify subscribers
   That keeps the UI reactive without a framework.

   Usage:
       const unsub = subscribe(() => render());
       await hydrate();
   ========================================================================== */

import { config } from './config.js';
import { getSupabase } from './supabase.js';
import { createSeedState } from './seed.js';

const STORAGE_KEY = 'wire.state.v1';

/** State slice -> Supabase table name. */
const TABLES = {
  articles: 'articles',
  assignments: 'assignments',
  staff: 'staff',
  topPerformers: 'top_performers',
  mediaLibrary: 'media_assets',
  auditLogs: 'audit_logs',
  broadcasts: 'broadcasts'
};

export const ARTICLE_STATUSES = [
  'Published',
  'Pending Review',
  'Rejected',
  'Archived'
];

let state = null;
const listeners = new Set();
let hydrated = false;

/* -------------------------------------------------------------------------- */
/* In-memory state plumbing                                                    */
/* -------------------------------------------------------------------------- */

function readLocalState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return createSeedState();
    return mergeState(JSON.parse(raw));
  } catch {
    return createSeedState();
  }
}

function writeLocalState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (error) {
    console.warn('[store] could not persist to localStorage', error);
  }
}

/**
 * Merge a (possibly older or partial) payload onto the seed shape so a schema
 * addition never breaks a cached copy.
 */
function mergeState(next = {}) {
  const seed = createSeedState();
  return {
    ...seed,
    ...next,
    articles: next.articles?.length ? next.articles : seed.articles,
    assignments: next.assignments?.length ? next.assignments : seed.assignments,
    staff: next.staff?.length ? next.staff : seed.staff,
    topPerformers: next.topPerformers?.length
      ? next.topPerformers
      : seed.topPerformers,
    mediaLibrary: next.mediaLibrary?.length
      ? next.mediaLibrary
      : seed.mediaLibrary,
    auditLogs: next.auditLogs?.length ? next.auditLogs : seed.auditLogs,
    branding: { ...seed.branding, ...(next.branding || {}) },
    breakingNews: { ...seed.breakingNews, ...(next.breakingNews || {}) },
    notifications: { ...seed.notifications, ...(next.notifications || {}) },
    weeklySlots: { ...seed.weeklySlots, ...(next.weeklySlots || {}) }
  };
}

/** The live application state. Safe to read synchronously. */
export function getState() {
  if (!state) state = readLocalState();
  return state;
}

/** Subscribe to state changes. Returns an unsubscribe function. */
export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify() {
  listeners.forEach((listener) => {
    try {
      listener(state);
    } catch (error) {
      console.error('[store] subscriber failed', error);
    }
  });
}

function commit() {
  if (config.demoMode) writeLocalState();
  notify();
}

/** Replace the whole state object (used after a remote load). */
function replaceState(next) {
  state = mergeState(next);
  if (config.demoMode) writeLocalState();
  notify();
}

/* -------------------------------------------------------------------------- */
/* Backend helpers                                                            */
/* -------------------------------------------------------------------------- */

function db() {
  return getSupabase();
}

/** Turn a Supabase/PostgREST error into a thrown Error with a clean message. */
function assertOk({ data, error }, context) {
  if (error) {
    const err = new Error(`${context}: ${error.message}`);
    err.cause = error;
    throw err;
  }
  return data;
}

/**
 * True when PostgREST rejected a write because a column is absent from the
 * database, i.e. a migration that adds it has not been applied yet. The app
 * ships optional columns that only exist after `003_subscriptions_and_gallery`
 * runs, so a missing one should degrade a feature rather than break it.
 */
function isMissingColumn(error) {
  const message = String(error?.message || '');
  return /could not find the '.*' column/i.test(message);
}

function nowStamp() {
  return new Date().toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

export function newId(prefix = 'id') {
  if (globalThis.crypto?.randomUUID) {
    return `${prefix}-${globalThis.crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

/* -------------------------------------------------------------------------- */
/* Hydration                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Load everything the publication needs. Call once at boot.
 * Falls back to the seed/demo store on any failure so the site always renders.
 * @returns {Promise<object>} the loaded state
 */
export async function hydrate() {
  if (hydrated) return getState();
  hydrated = true;

  if (config.demoMode || !db()) {
    replaceState(readLocalState());
    return getState();
  }

  const client = db();
  try {
    const [
      articles,
      assignments,
      staff,
      performers,
      media,
      audit,
      broadcasts,
      settings
    ] = await Promise.all([
      client.from(TABLES.articles).select('*').order('created_at', { ascending: false }),
      client.from(TABLES.assignments).select('*').order('created_at', { ascending: false }),
      client.from(TABLES.staff).select('*').order('created_at', { ascending: false }),
      client.from(TABLES.topPerformers).select('*').order('articles_count', { ascending: false }),
      client.from(TABLES.mediaLibrary).select('*').order('created_at', { ascending: false }),
      client
        .from(TABLES.auditLogs)
        .select('*')
        .order('created_at', { ascending: false })
        .limit(50),
      client
        .from(TABLES.broadcasts)
        .select('*')
        .order('created_at', { ascending: false })
        .limit(50),
      client.from('site_settings').select('*').limit(1).maybeSingle()
    ]);

    assertOk({ data: articles.data, error: articles.error }, 'load articles');

    // The subscriber count lives in a table readers may not read, so it comes
    // through a SECURITY DEFINER function rather than a direct select. A failure
    // here must not abort hydration, hence the separate try/catch.
    let subscriberCount = 0;
    if (!config.demoMode && db()) {
      try {
        const { data, error } = await db().rpc('wire_subscriber_count');
        if (!error && typeof data === 'number') subscriberCount = data;
      } catch {
        // Migration 003 not applied yet: report 0 rather than a fake figure.
      }
    }

    const local = readLocalState();
    const settingsRow = settings.data || {};

    replaceState({
      ...local,
      // Postgres columns are snake_case; the UI reads camelCase `date`/`image`.
      // Passing the raw rows through left `article.date` and `article.image`
      // undefined, which printed the literal text "undefined" on the front page
      // and broke every thumbnail. Normalise here, once, at the boundary.
      articles: (articles.data || []).map((row) => ({
        id: row.id,
        title: row.title,
        author: row.author,
        category: row.category,
        date: row.published_at || '',
        image: row.image_url || '',
        caption: row.caption || '',
        body: row.body || '',
        status: row.status,
        featured: Boolean(row.featured)
      })),
      assignments: (assignments.data || []).map((row) => ({
        id: row.id,
        title: row.title,
        reporter: row.reporter || '',
        status: row.status,
        deadline: row.deadline || ''
      })),
      staff: (staff.data || []).map((row) => ({
        id: row.id,
        name: row.name,
        username: row.username,
        email: row.email || row.shadow_email || '',
        role: row.role,
        status: row.status
      })),
      topPerformers: (performers.data || []).map((row) => ({
        id: row.id,
        name: row.name,
        role: row.role,
        articlesCount: row.articles_count
      })),
      mediaLibrary: (media.data || []).map((row) => ({
        id: row.id,
        url: row.url,
        caption: row.caption,
        // The Owner's gallery publish toggle. Older rows predate the column, so
        // treat anything missing as "not published" rather than showing every
        // uploaded image on the public page.
        inGallery: Boolean(row.in_gallery),
        galleryOrder: row.gallery_order ?? null
      })),
      auditLogs: (audit.data || []).map((row) => ({
        id: row.id,
        user: row.actor_name,
        action: row.action,
        time: row.created_at
      })),
      notifications: {
        ...local.notifications,
        forced: Boolean(settingsRow.forced_notifications),
        // Real device count from the database, not a seeded number.
        activeSubscriberCount: subscriberCount,
        history: (broadcasts.data || []).map((row) => ({
          id: row.id,
          title: row.title,
          message: row.message,
          audience: row.audience,
          time: row.created_at,
          delivered: row.delivered_count,
          requiresAction: Boolean(row.requires_action),
          targetEndpoint: row.target_endpoint || null
        }))
      },
      branding: {
        ...local.branding,
        ...(settingsRow.title ? { title: settingsRow.title } : {}),
        ...(settingsRow.subtitle ? { subtitle: settingsRow.subtitle } : {}),
        ...(settingsRow.edition ? { edition: settingsRow.edition } : {})
      },
      breakingNews: { ...local.breakingNews, ...(settingsRow.breaking_news || {}) },
      todaysPickId: settingsRow.todays_pick_id || local.todaysPickId,
      weeklySlots: { ...local.weeklySlots, ...(settingsRow.weekly_slots || {}) }
    });
  } catch (error) {
    console.error('[store] hydration failed, using local store', error);
    replaceState(readLocalState());
  }

  return getState();
}

/** Re-read everything from the backend (used after signing in/out). */
export async function refresh() {
  hydrated = false;
  return hydrate();
}

/* -------------------------------------------------------------------------- */
/* Audit log                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Record an administrative action. Never throws — auditing must not be able
 * to break an operation the user already completed.
 * @param {string} action
 * @param {string} [actor] Display name of whoever performed it.
 */
export async function addAuditLog(action, actor = 'Owner') {
  const entry = { id: newId('audit'), user: actor, action, time: nowStamp() };
  const current = getState();
  current.auditLogs = [entry, ...current.auditLogs].slice(0, 100);

  if (!config.demoMode && db()) {
    try {
      assertOk(
        await db()
          .from(TABLES.auditLogs)
          .insert({ action, actor_name: actor }),
        'write audit log'
      );
    } catch (error) {
      console.warn('[store] audit write failed', error);
    }
  }
  commit();
  return entry;
}


/* -------------------------------------------------------------------------- */
/* ARTICLES — full CRUD                                                        */
/* -------------------------------------------------------------------------- */

/** @returns {Array} every article, newest first. */
export function listArticles() {
  return [...getState().articles];
}

/**
 * True when an id is a real database uuid.
 *
 * The demo/seed store uses readable text ids like 'seed-staff-3'. Those rows only
 * ever exist in localStorage, so sending one to PostgREST makes Postgres raise
 * `invalid input syntax for type uuid` and aborts the whole operation. Every
 * id-keyed write goes through this guard first: non-uuid ids are treated as
 * local-only and simply removed from in-memory state.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isPersistedId(id) {
  return UUID_RE.test(String(id || ''));
}

/**
 * Compare a workflow status case-insensitively.
 * The database was seeded with lower-case values ('published') while the UI and
 * the seed data use title case ('Published'). Matching exactly meant the front
 * page rendered nothing at all, so normalise before comparing.
 */
function isStatus(value, expected) {
  return String(value || '').trim().toLowerCase() === expected.toLowerCase();
}

/**
 * Render a value for display, never emitting the literal text "undefined" or
 * "null". Empty/missing becomes an em dash so the layout keeps its shape.
 * @param {unknown} value
 * @param {string} [fallback]
 */
function display(value, fallback = '—') {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  return text === '' ? fallback : text;
}

/** Only the stories a reader may see. */
export function listPublishedArticles() {
  return getState().articles.filter((article) => isStatus(article.status, 'Published'));
}

/** @param {string} id */
export function getArticle(id) {
  return getState().articles.find((article) => article.id === id) || null;
}

/**
 * CREATE — insert a new article.
 * @param {object} input
 * @returns {Promise<object>} the created article
 */
export async function createArticle(input) {
  const current = getState();
  const article = {
    id: newId('article'),
    title: input.title?.trim() || 'Untitled dispatch',
    author: input.author?.trim() || 'The Wire Staff',
    category: input.category || 'Civic Dispatch',
    date: input.date || nowStamp(),
    image: input.image || '',
    caption: input.caption || '',
    body: input.body || '',
    status: ARTICLE_STATUSES.includes(input.status) ? input.status : 'Pending Review',
    featured: Boolean(input.featured)
  };

  if (!config.demoMode && db()) {
    const inserted = assertOk(
      await db()
        .from(TABLES.articles)
        .insert({
          title: article.title,
          author: article.author,
          category: article.category,
          published_at: article.date,
          image_url: article.image,
          caption: article.caption,
          body: article.body,
          status: article.status,
          featured: article.featured
        })
        .select()
        .single(),
      'create article'
    );
    article.id = inserted.id;
  }

  current.articles = [article, ...current.articles];
  await addAuditLog(`Created article "${article.title}"`);
  commit();
  return article;
}

/**
 * UPDATE — patch an existing article.
 * @param {string} id
 * @param {object} patch
 * @returns {Promise<object|null>}
 */
export async function updateArticle(id, patch) {
  const current = getState();
  const article = current.articles.find((item) => item.id === id);
  if (!article) return null;

  if (!config.demoMode && db() && isPersistedId(id)) {
    const row = {};
    if (patch.title !== undefined) row.title = patch.title;
    if (patch.author !== undefined) row.author = patch.author;
    if (patch.category !== undefined) row.category = patch.category;
    if (patch.date !== undefined) row.published_at = patch.date;
    if (patch.image !== undefined) row.image_url = patch.image;
    if (patch.caption !== undefined) row.caption = patch.caption;
    if (patch.body !== undefined) row.body = patch.body;
    if (patch.status !== undefined) row.status = patch.status;
    if (patch.featured !== undefined) row.featured = patch.featured;

    if (Object.keys(row).length) {
      assertOk(
        await db()
          .from(TABLES.articles)
          .update(row)
          .eq('id', id)
          .select()
          .single(),
        'update article'
      );
    }
  }

  Object.assign(article, patch);
  await addAuditLog(`Updated article "${article.title}"`);
  commit();
  return article;
}

/**
 * DELETE — permanently remove an article and detach it from curation slots.
 * @param {string} id
 * @returns {Promise<boolean>} true when a row was removed
 */
export async function deleteArticle(id) {
  const current = getState();
  const article = current.articles.find((item) => item.id === id);
  if (!article) return false;

  if (!config.demoMode && db() && isPersistedId(id)) {
    assertOk(
      await db().from(TABLES.articles).delete().eq('id', id),
      'delete article'
    );
  }

  current.articles = current.articles.filter((item) => item.id !== id);
  if (current.todaysPickId === id) {
    current.todaysPickId = current.articles[0]?.id ?? null;
  }
  Object.keys(current.weeklySlots).forEach((slot) => {
    if (current.weeklySlots[slot] === id) {
      current.weeklySlots[slot] = current.articles[0]?.id ?? null;
    }
  });

  await addAuditLog(`Deleted article "${article.title}"`);
  commit();
  return true;
}

/** Move a story out of the review queue. */
export async function publishArticle(id) {
  return updateArticle(id, { status: 'Published' });
}

/** Bounce a story back to the author. */
export async function rejectArticle(id) {
  return updateArticle(id, { status: 'Rejected' });
}


/* -------------------------------------------------------------------------- */
/* ASSIGNMENTS — full CRUD                                                      */
/* -------------------------------------------------------------------------- */

export function listAssignments() {
  return [...getState().assignments];
}

/** CREATE an open pitch on the public assignment board. */
export async function createAssignment(input) {
  const current = getState();
  const assignment = {
    id: newId('assignment'),
    title: input.title?.trim() || 'Untitled pitch',
    reporter: input.reporter?.trim() || '',
    status: input.status || 'Open',
    deadline: input.deadline || ''
  };

  if (!config.demoMode && db()) {
    const inserted = assertOk(
      await db()
        .from(TABLES.assignments)
        .insert({
          title: assignment.title,
          reporter: assignment.reporter,
          status: assignment.status,
          deadline: assignment.deadline
        })
        .select()
        .single(),
      'create assignment'
    );
    assignment.id = inserted.id;
  }

  current.assignments = [assignment, ...current.assignments];
  await addAuditLog(`Opened assignment "${assignment.title}"`);
  commit();
  return assignment;
}

/** UPDATE an assignment (status, reporter, title, deadline). */
export async function updateAssignment(id, patch) {
  const current = getState();
  const assignment = current.assignments.find((item) => item.id === id);
  if (!assignment) return null;

  if (!config.demoMode && db() && isPersistedId(id)) {
    const row = {};
    if (patch.title !== undefined) row.title = patch.title;
    if (patch.reporter !== undefined) row.reporter = patch.reporter;
    if (patch.status !== undefined) row.status = patch.status;
    if (patch.deadline !== undefined) row.deadline = patch.deadline;
    if (Object.keys(row).length) {
      assertOk(
        await db()
          .from(TABLES.assignments)
          .update(row)
          .eq('id', id)
          .select()
          .single(),
        'update assignment'
      );
    }
  }

  Object.assign(assignment, patch);
  await addAuditLog(`Updated assignment "${assignment.title}"`);
  commit();
  return assignment;
}

/** DELETE an assignment. */
export async function deleteAssignment(id) {
  const current = getState();
  const assignment = current.assignments.find((item) => item.id === id);
  if (!assignment) return false;

  if (!config.demoMode && db() && isPersistedId(id)) {
    assertOk(
      await db().from(TABLES.assignments).delete().eq('id', id),
      'delete assignment'
    );
  }

  current.assignments = current.assignments.filter((item) => item.id !== id);
  await addAuditLog(`Closed assignment "${assignment.title}"`);
  commit();
  return true;
}

/** A reporter claiming an open pitch. */
export async function claimAssignment(id, reporter) {
  return updateAssignment(id, { reporter, status: 'In Progress' });
}


/* -------------------------------------------------------------------------- */
/* STAFF — full CRUD                                                           */
/* -------------------------------------------------------------------------- */

export function listStaff() {
  return [...getState().staff];
}

/**
 * CREATE a staff record.
 *
 * SECURITY NOTE: account *credentials* are never created from the browser with
 * an admin key. In production you either invite the user from the Supabase
 * dashboard, or call an Edge Function that holds the `service_role` key
 * server-side. This function only writes the newsroom profile row.
 */
export async function createStaff(input) {
  const current = getState();
  const member = {
    id: newId('staff'),
    name: input.name?.trim() || 'Unnamed staffer',
    username: input.username?.trim().toLowerCase() || 'staffer',
    email: input.email?.trim().toLowerCase() || '',
    role: input.role || 'Editor',
    status: input.status || 'Active'
  };

  if (!config.demoMode && db()) {
    const inserted = assertOk(
      await db()
        .from(TABLES.staff)
        .insert({
          name: member.name,
          username: member.username,
          email: member.email,
          role: member.role,
          status: member.status,
          auth_user_id: input.authUserId || null
        })
        .select()
        .single(),
      'create staff'
    );
    member.id = inserted.id;
  }

  current.staff = [...current.staff, member];
  await addAuditLog(`Provisioned staff account @${member.username} (${member.role})`);
  commit();
  return member;
}

/** UPDATE a staff record (role promotion, suspension, rename). */
export async function updateStaff(id, patch) {
  const current = getState();
  const member = current.staff.find((item) => item.id === id);
  if (!member) return null;

  if (!config.demoMode && db() && isPersistedId(id)) {
    const row = {};
    if (patch.name !== undefined) row.name = patch.name;
    if (patch.username !== undefined) row.username = patch.username;
    if (patch.email !== undefined) row.email = patch.email;
    if (patch.role !== undefined) row.role = patch.role;
    if (patch.status !== undefined) row.status = patch.status;
    if (Object.keys(row).length) {
      assertOk(
        await db()
          .from(TABLES.staff)
          .update(row)
          .eq('id', id)
          .select()
          .single(),
        'update staff'
      );
    }
  }

  Object.assign(member, patch);
  await addAuditLog(`Updated staff account @${member.username}`);
  commit();
  return member;
}

/** DELETE a staff record. Owners cannot be removed by this path. */
export async function deleteStaff(id) {
  const current = getState();
  const member = current.staff.find((item) => item.id === id);
  if (!member) return false;
  if (member.role === 'Owner') {
    throw new Error('The Owner account cannot be removed from the roster.');
  }

  if (!config.demoMode && db() && isPersistedId(id)) {
    assertOk(
      await db().from(TABLES.staff).delete().eq('id', id),
      'delete staff'
    );
  }

  current.staff = current.staff.filter((item) => item.id !== id);
  await addAuditLog(`Removed staff account @${member.username}`);
  commit();
  return true;
}


/* -------------------------------------------------------------------------- */
/* MEDIA LIBRARY — full CRUD                                                   */
/* -------------------------------------------------------------------------- */

export function listMedia() {
  return [...getState().mediaLibrary];
}

/** CREATE — add an image URL to the shared media shelf. */
export async function createMedia(input) {
  const current = getState();
  const item = {
    id: newId('media'),
    url: input.url?.trim() || '',
    caption: input.caption?.trim() || 'Untitled frame',
    // Opt-in: the Owner decides which uploads reach the public gallery.
    inGallery: Boolean(input.inGallery),
    galleryOrder: input.galleryOrder ?? null
  };
  if (!item.url) throw new Error('A media item needs an image URL.');

  if (!config.demoMode && db()) {
    const inserted = assertOk(
      await db()
        .from(TABLES.mediaLibrary)
        .insert({
          url: item.url,
          caption: item.caption,
          in_gallery: item.inGallery,
          gallery_order: item.galleryOrder
        })
        .select()
        .single(),
      'create media'
    );
    item.id = inserted.id;
  }

  current.mediaLibrary = [item, ...current.mediaLibrary];
  await addAuditLog(
    `Added media asset "${item.caption}"${item.inGallery ? ' to the gallery' : ''}`
  );
  commit();
  return item;
}

/** UPDATE — recaption or re-point an image. */
export async function updateMedia(id, patch) {
  const current = getState();
  const item = current.mediaLibrary.find((entry) => entry.id === id);
  if (!item) return null;

  if (!config.demoMode && db() && isPersistedId(id)) {
    const row = {};
    if (patch.url !== undefined) row.url = patch.url;
    if (patch.caption !== undefined) row.caption = patch.caption;
    if (patch.inGallery !== undefined) row.in_gallery = Boolean(patch.inGallery);
    if (patch.galleryOrder !== undefined) row.gallery_order = patch.galleryOrder;
    if (Object.keys(row).length) {
      assertOk(
        await db()
          .from(TABLES.mediaLibrary)
          .update(row)
          .eq('id', id)
          .select()
          .single(),
        'update media'
      );
    }
  }

  Object.assign(item, patch);
  commit();
  return item;
}

/** The photos the Owner has chosen to publish, in their chosen order. */
export function listGallery() {
  return getState()
    .mediaLibrary.filter((entry) => entry.inGallery)
    .sort((a, b) => (a.galleryOrder ?? 9999) - (b.galleryOrder ?? 9999));
}

/**
 * Show or hide one image on the public gallery.
 * @param {string} id
 * @param {boolean} inGallery
 */
export async function setGalleryItem(id, inGallery) {
  const order = inGallery ? getState().mediaLibrary.length + 1 : null;
  const item = await updateMedia(id, { inGallery, galleryOrder: order });
  if (item) {
    await addAuditLog(
      `${inGallery ? 'Published' : 'Removed'} "${item.caption}" ${
        inGallery ? 'in' : 'from'
      } the public gallery`
    );
    commit();
  }
  return item;
}

/** DELETE — remove an image from the shelf. */
export async function deleteMedia(id) {
  const current = getState();
  const item = current.mediaLibrary.find((entry) => entry.id === id);
  if (!item) return false;

  if (!config.demoMode && db() && isPersistedId(id)) {
    assertOk(
      await db().from(TABLES.mediaLibrary).delete().eq('id', id),
      'delete media'
    );
  }

  current.mediaLibrary = current.mediaLibrary.filter((entry) => entry.id !== id);
  await addAuditLog(`Removed media asset "${item.caption}"`);
  commit();
  return true;
}

/* -------------------------------------------------------------------------- */
/* BROADCASTS — push notification centre                                       */
/* -------------------------------------------------------------------------- */

export function listBroadcasts() {
  return [...getState().notifications.history];
}

/** CREATE — send a broadcast to the subscriber list. */
export async function createBroadcast(input) {
  const current = getState();
  const subscribers = current.notifications.activeSubscriberCount || 0;
  const broadcast = {
    id: newId('broadcast'),
    title: input.title?.trim() || 'Newsroom update',
    message: input.message?.trim() || '',
    audience: input.audience || 'Everyone',
    time: nowStamp(),
    delivered: subscribers
  };

  if (!config.demoMode && db()) {
    const payload = {
      title: broadcast.title,
      message: broadcast.message,
      audience: broadcast.audience,
      delivered_count: broadcast.delivered,
      requires_action: Boolean(input.requiresAction),
      target_endpoint: input.targetEndpoint?.trim() || null
    };

    // `requires_action` and `target_endpoint` are added by an optional
    // migration. If the database predates it, retry with only the columns the
    // table is known to have rather than failing the whole broadcast.
    let result = await db()
      .from(TABLES.broadcasts)
      .insert(payload)
      .select()
      .single();

    if (result.error && isMissingColumn(result.error)) {
      console.warn(
        '[store] broadcasts.requires_action is missing — run ' +
          'supabase/003_subscriptions_and_gallery.sql. Sending without it.',
        result.error
      );
      const { requires_action: _omitted, target_endpoint: _also, ...core } = payload;
      result = await db()
        .from(TABLES.broadcasts)
        .insert(core)
        .select()
        .single();
    }

    const inserted = assertOk(result, 'create broadcast');
    broadcast.id = inserted.id;
  }

  current.notifications.history = [
    broadcast,
    ...current.notifications.history
  ];
  await addAuditLog(
    `Broadcast "${broadcast.title}" to ${broadcast.audience} (${broadcast.delivered} recipients)`
  );
  commit();
  return broadcast;
}

/** DELETE — remove a broadcast from the history. */
export async function deleteBroadcast(id) {
  const current = getState();
  const broadcast = current.notifications.history.find((item) => item.id === id);
  if (!broadcast) return false;

  if (!config.demoMode && db() && isPersistedId(id)) {
    assertOk(
      await db().from(TABLES.broadcasts).delete().eq('id', id),
      'delete broadcast'
    );
  }

  current.notifications.history = current.notifications.history.filter(
    (item) => item.id !== id
  );
  commit();
  return true;
}


/* -------------------------------------------------------------------------- */
/* SITE SETTINGS — branding, breaking banner, curation                         */
/* -------------------------------------------------------------------------- */

/** Persist the singleton `site_settings` row (Supabase) or nothing (demo). */
async function persistSettings(overrides = {}) {
  if (config.demoMode || !db()) return;
  const current = getState();
  const payload = {
    id: 1,
    title: current.branding.title,
    subtitle: current.branding.subtitle,
    edition: current.branding.edition,
    breaking_news: current.breakingNews,
    todays_pick_id: current.todaysPickId,
    weekly_slots: current.weeklySlots,
    forced_notifications: current.notifications.forced,
    ...overrides
  };
  assertOk(
    await db()
      .from('site_settings')
      .upsert(payload, { onConflict: 'id' })
      .select()
      .maybeSingle(),
    'save site settings'
  );
}

/** UPDATE the publication's masthead branding. */
export async function saveBranding({ title, subtitle, edition }) {
  const current = getState();
  current.branding = { ...current.branding, title, subtitle, edition };
  await persistSettings();
  await addAuditLog('Updated publication branding');
  commit();
  return current.branding;
}

/** UPDATE the breaking-news banner configuration. */
export async function saveBreakingNews(next) {
  const current = getState();
  current.breakingNews = { ...current.breakingNews, ...next };
  await persistSettings();
  await addAuditLog('Published a real-time breaking-news alert');
  commit();
  return current.breakingNews;
}

/** UPDATE today's pick + the three weekly feature slots in one call. */
export async function saveCuration({ todaysPickId, weeklySlots }) {
  const current = getState();
  if (todaysPickId !== undefined) current.todaysPickId = todaysPickId;
  if (weeklySlots !== undefined) {
    current.weeklySlots = { ...current.weeklySlots, ...weeklySlots };
  }
  await persistSettings();
  commit();
  return { todaysPickId: current.todaysPickId, weeklySlots: current.weeklySlots };
}

/** Pick a random published article as today's pick. */
export async function rerollTodaysPick() {
  const published = listPublishedArticles();
  if (!published.length) return null;
  const chosen = published[Math.floor(Math.random() * published.length)];
  await saveCuration({ todaysPickId: chosen.id });
  await addAuditLog(`Rerolled Today's Pick to "${chosen.title}"`);
  return chosen;
}

/** Turn the forced-notification lockout on or off. */
export async function setForcedNotifications(enabled) {
  const current = getState();
  current.notifications.forced = Boolean(enabled);
  await persistSettings();
  await addAuditLog(
    `Forced push notifications ${enabled ? 'ENABLED' : 'disabled'}`
  );
  commit();
  return current.notifications.forced;
}

/** Record that this browser has accepted the notification permission. */
export function setPushPermission(granted) {
  getState().notifications.permissionGranted = Boolean(granted);
  commit();
  return getState().notifications.permissionGranted;
}

/* -------------------------------------------------------------------------- */
/* Derived read helpers used by the public view                               */
/* -------------------------------------------------------------------------- */

/** The article currently pinned as Today's Pick. */
export function getTodaysPick() {
  const current = getState();
  return (
    current.articles.find((article) => article.id === current.todaysPickId) ||
    current.articles[0] ||
    null
  );
}

/** @param {'article'|'event'|'picture'} slot */
export function getWeeklySlot(slot) {
  const current = getState();
  return (
    current.articles.find((article) => article.id === current.weeklySlots[slot]) ||
    current.articles[0] ||
    null
  );
}

/** Everything waiting in the editorial review queue. */
export function getPendingQueue() {
  return getState().articles.filter((a) => isStatus(a.status, 'Pending Review'));
}

/** Wipe every local cache. Used by "reset demo data" in the admin panel. */
export async function resetLocalData() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage unavailable */
  }
  hydrated = false;
  return hydrate();
}

