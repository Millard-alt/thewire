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
import { getSession, isOwner } from './auth.js';

const STORAGE_KEY = 'wire.state.v1';

/** State slice -> Supabase table name. */
const TABLES = {
  articles: 'articles',
  assignments: 'assignments',
  staff: 'staff',
  topPerformers: 'top_performers',
  mediaLibrary: 'media_assets',
  galleryCategories: 'gallery_categories',
  auditLogs: 'audit_logs',
  broadcasts: 'broadcasts'
};

/**
 * How many extra photographs one article may carry, on top of its lead image.
 *
 * Three is a hard ceiling, not a preference. It is what keeps the reader view
 * readable on a phone: the layout below renders 1 as a wide frame, 2 as a pair
 * and 3 as a full-bleed lead above a two-up, which are the only arrangements
 * that do not leave a stranded half-width row. A fourth has no good layout
 * without the strip turning into a grid that stops reading as one story.
 */
export const MAX_ARTICLE_PHOTOS = 3;

/**
 * Normalise whatever Postgres gave us for `articles.extra_images` into the
 * shape the renderer expects: an array of `{ url, caption }`, at most
 * MAX_ARTICLE_PHOTOS long, with no empty URLs.
 *
 * This runs on every hydration, so it has to tolerate all of:
 *   - the key missing entirely  -> 017 not pasted yet
 *   - null                      -> a row written before 017 normalised it
 *   - a bare string or object   -> should be impossible (017 has a CHECK) but a
 *                                  bad hand-written row must not break the page
 * Returns [] for all of them, which renders as "no extra photos".
 */
export function readExtraImages(raw) {
  if (!Array.isArray(raw)) return [];

  // Accept a bare URL string as well as `{ url, caption }`. Both shapes reach
  // this function: Postgres returns jsonb objects, but the article editor hands
  // over a plain list of strings it built from pasted URLs and the file picker.
  // Requiring an object here silently threw away every typed or pasted photo,
  // so the article saved fine and simply had no strip.
  const asEntry = (entry) =>
    typeof entry === 'string'
      ? { url: entry, caption: '' }
      : entry && typeof entry === 'object'
        ? { url: entry.url, caption: entry.caption }
        : null;

  return raw
    .map(asEntry)
    .filter((entry) => entry && typeof entry.url === 'string' && entry.url.trim())
    .slice(0, MAX_ARTICLE_PHOTOS)
    .map((entry) => ({
      url: entry.url.trim(),
      caption: entry.caption ? String(entry.caption) : ''
    }));
}

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
 * Make one media entry safe to read, whatever shape it was written in.
 *
 * WHY THIS EXISTS
 * The first version of the gallery feature keyed a photo's category under
 * `galleryCategoryId`. Everything in the app -- listGalleryByCategory(),
 * updateMedia(), the media tab and the 017 column mapping -- keys off
 * `categoryId`. The seed therefore wrote a field nothing read, and the gallery
 * page showed every photo as unfiled.
 *
 * The seed is fixed, but a browser that loaded that build still holds the old
 * key in localStorage, and localStorage is only cleared by hand. Without a
 * tolerant read those users would keep seeing a broken gallery with no way to
 * recover short of a private-mode visit. So the read is made tolerant as well
 * as the write: accept either spelling, drop the dead one, and leave a
 * well-formed entry behind for the next save.
 *
 * @param {object} item
 * @returns {object} a new entry carrying a canonical `categoryId`
 */
function normaliseMediaEntry(item) {
  if (!item || typeof item !== 'object') return item;

  const legacy = item.galleryCategoryId;
  const canonical = item.categoryId;

  // The canonical value wins when both are present; the legacy key only ever
  // fills a gap.
  const categoryId = canonical ?? legacy ?? null;

  if (!('categoryId' in item) && legacy === undefined) return item;

  const next = { ...item, categoryId: categoryId || null };
  // Never carry the dead key forward, or the next save would write it back and
  // it would reappear in the cached copy.
  delete next.galleryCategoryId;
  return next;
}

/**
 * Merge a (possibly older or partial) payload onto the seed shape so a schema
 * addition never breaks a cached copy.
 *
 * THE BUG THIS FIXES
 * The original version ran every list through `next.x?.length ? next.x : seed.x`.
 * That reads "the database returned zero rows" as "we have no data yet" and
 * re-injects the demo seed. Since `articles` was empty on the live database, the
 * newsroom panel showed four fake `seed-article-N` stories that no Postgres row
 * backed. Deleting one hit the `isPersistedId()` guard in `deleteArticle()`,
 * skipped the database call entirely, mutated memory that is never persisted in
 * production, and the story reappeared on the next hydrate. That is why "the
 * Owner cannot delete articles" -- there was nothing to delete, and the panel was
 * showing the demo store.
 *
 * `remote: true` means this payload came from Postgres and is therefore
 * authoritative. An empty table is an empty table; the seed is only ever a
 * fallback for the local demo store.
 *
 * @param {object} next
 * @param {{remote?: boolean}} [options]
 */
function mergeState(next = {}, { remote = false } = {}) {
  const seed = createSeedState();

  /**
   * @param {unknown} value   the incoming list, possibly undefined or empty
   * @param {Array} fallback  the demo seed list
   * @returns {Array} always an array
   */
  const pick = (value, fallback) => {
    if (remote) return Array.isArray(value) ? value : [];
    return Array.isArray(value) && value.length ? value : fallback;
  };

  /** Non-list slices keep the seed defaults only in the local demo store. */
  const pickObject = (value, fallback) => (remote ? value || {} : { ...fallback, ...(value || {}) });

  return {
    ...seed,
    ...next,
    articles: pick(next.articles, seed.articles),
    assignments: pick(next.assignments, seed.assignments),
    staff: pick(next.staff, seed.staff),
    topPerformers: pick(next.topPerformers, seed.topPerformers),
    mediaLibrary: pick(next.mediaLibrary, seed.mediaLibrary).map(normaliseMediaEntry),
    // Categories and per-article photos are the two newest slices. They fall back
    // to the seed ONLY in the local demo store; on a live database an empty
    // table means the Owner has not created any yet, which is the honest answer
    // and must not be papered over with demo rows.
    galleryCategories: pick(next.galleryCategories, seed.galleryCategories),
    auditLogs: pick(next.auditLogs, seed.auditLogs),
    branding: pickObject(next.branding, seed.branding),
    breakingNews: pickObject(next.breakingNews, seed.breakingNews),
    notifications: pickObject(next.notifications, seed.notifications),
    weeklySlots: pickObject(next.weeklySlots, seed.weeklySlots)
  };
}

/**
 * Drop curation pointers that no longer resolve to a real article.
 *
 * `site_settings.weekly_slots` and `todays_pick_id` are jsonb holding article
 * ids. The demo seed wrote `seed-article-1`..`3` into that jsonb, and because
 * site_settings IS a real database row those text ids were persisted into
 * Postgres and outlived every article they pointed at. Nothing renders them
 * (no article has that id any more) but they make the Curation tab look
 * populated with stories that do not exist, so they are cleared here rather
 * than left to rot in the database.
 *
 * @param {object} state
 * @returns {object} the same object, mutated
 */
function reconcileCuration(state) {
  const known = new Set((state.articles || []).map((a) => a.id));
  const resolves = (id) => (id == null ? false : known.has(String(id)));

  if (!resolves(state.todaysPickId)) state.todaysPickId = null;

  const slots = state.weeklySlots || {};
  Object.keys(slots).forEach((slot) => {
    if (!resolves(slots[slot])) delete slots[slot];
  });
  state.weeklySlots = slots;

  return state;
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
function replaceState(next, options = {}) {
  state = mergeState(next, options);
  if (options.remote) reconcileCuration(state);
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
      categories,
      audit,
      broadcasts,
      settings
    ] = await Promise.all([
      client.from(TABLES.articles).select('*').order('created_at', { ascending: false }),
      client.from(TABLES.assignments).select('*').order('created_at', { ascending: false }),
      client.from(TABLES.staff).select('*').order('created_at', { ascending: false }),
      client.from(TABLES.topPerformers).select('*').order('articles_count', { ascending: false }),
      client.from(TABLES.mediaLibrary).select('*').order('created_at', { ascending: false }),
      client.from(TABLES.galleryCategories).select('*').order('sort_order', {
        ascending: true,
        nullsFirst: false
      }),
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

    // `remote: true` from here on. Everything in this payload is either a row
    // Postgres just returned or a genuine fallback; the demo seed must NOT be
    // merged back in when a table is legitimately empty.
    replaceState(
      {
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
        // Read defensively: migration 007 may not have run yet, in which case
        // PostgREST omits the key entirely rather than returning null.
        authorAccountId: row.author_account_id ?? null,
        featured: Boolean(row.featured),
        // The extra photos a writer attached. Migration 017 stores them as a
        // jsonb array on the article itself, not in a side table, so this is the
        // only place that shape needs defending: `extra_images` is absent
        // entirely when 017 has not been pasted, and can be NULL or a non-array
        // on a row written before the migration normalised it.
        extraImages: readExtraImages(row.extra_images)
      })),
      assignments: (assignments.data || []).map((row) => ({
        id: row.id,
        title: row.title,
        reporter: row.reporter || '',
        status: row.status,
        deadline: row.deadline || '',
        // Migration 021 added these three. They were NOT carried through here, so
        // after any re-hydrate every assignment silently reverted to "unassigned"
        // and to a blank deadline in the editor - the value had been written to
        // Postgres correctly and was thrown away one layer up. The same class of
        // bug as the portrait columns noted below.
        //
        // `?? null` rather than `|| null`: PostgREST omits a key entirely when a
        // deployment has not run 021 yet, and `row.assigned_to` being undefined
        // must not be read as a real value.
        assigned_to: row.assigned_to ?? null,
        due_at: row.due_at ?? null,
        reminder_sent: Boolean(row.reminder_sent)
      })),
      // NOTE: portrait_url and portrait_status are carried through here on
      // purpose. They were dropped by this mapper, so the Owner's Staff tab
      // received rows with no photo and no review state, renderPortraitReview()
      // always fell through to '' and there was nothing to approve -- a portrait
      // the writer could submit successfully but that the Owner could never see.
      staff: (staff.data || []).map((row) => ({
        id: row.id,
        name: row.name,
        username: row.username,
        email: row.email || row.shadow_email || '',
        role: row.role,
        status: row.status,
        portrait_url: row.portrait_url || '',
        portrait_status: row.portrait_status || 'none'
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
        galleryOrder: row.gallery_order ?? null,
        // Null when the photo is not filed under a category. 017 may not be
        // applied yet, in which case PostgREST omits the key entirely.
        categoryId: row.category_id ?? null
      })),
      // Owner-defined cards for the gallery page. A null sortOrder sorts last,
      // which is what the public view wants for a freshly created category.
      galleryCategories: (categories.data || []).map((row) => ({
        id: row.id,
        name: row.name,
        coverUrl: row.cover_url || '',
        sortOrder: row.sort_order ?? null
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
        // Read the curation pointers from Postgres only. Falling back to
        // `local.todaysPickId` / `local.weeklySlots` here would resurrect the
        // `seed-article-N` text ids, which point at rows that have never existed
        // in the database. An unset pointer is simply unset.
        todaysPickId: settingsRow.todays_pick_id ?? null,
        weeklySlots: settingsRow.weekly_slots || {}
      },
      { remote: true }
    );
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
 * The signed-in account id, or null.
 *
 * Read from the LIVE auth module rather than from a prop or a cached value: the
 * point of every ownership check in this file is that it reflects who is
 * actually signed in right now.
 *
 * Deliberately NOT filtered through isPersistedId(). In production the id is a
 * uuid from staff_accounts and that is what author_account_id stores. In the
 * demo store it is a synthetic `demo-<hash>` string, and the demo still has to
 * be able to demonstrate ownership -- filtering it here returned null for every
 * demo session, so a writer could never delete anything they had written and the
 * rule could not be exercised outside a live database.
 *
 * @returns {string|null}
 */
function currentAccountId() {
  const id = getSession()?.user?.id;
  return id ? String(id) : null;
}

/**
 * Has migration 007 been applied (i.e. does `articles.author_account_id` exist)?
 *
 * Probed once and cached. Sending an unknown column makes PostgREST reject the
 * ENTIRE statement with PGRST204, so a new deployment that writes the column
 * before the migration has run would fail every article insert. Probing costs
 * one cheap select and removes that ordering dependency entirely.
 */
let ownershipColumnReady = null;

export async function hasOwnershipColumn() {
  if (ownershipColumnReady !== null) return ownershipColumnReady;
  if (config.demoMode || !db()) {
    ownershipColumnReady = false;
    return false;
  }
  try {
    const { error } = await db()
      .from(TABLES.articles)
      .select('author_account_id')
      .limit(1);
    ownershipColumnReady = !error;
    if (error) {
      console.warn(
        '[store] articles.author_account_id is missing — run supabase/007_article_ownership.sql',
        error.message
      );
    }
  } catch {
    ownershipColumnReady = false;
  }
  return ownershipColumnReady;
}

/**
 * Does `articles.extra_images` exist yet?
 *
 * Same reasoning as hasOwnershipColumn() above, for the same reason: a deploy
 * that lands before migration 017 must not break article creation. PostgREST
 * rejects the whole request (PGRST204) when an unknown column appears in the
 * payload, so the probe gates whether the key is sent at all rather than
 * letting a missing migration surface as "could not save story".
 */
let extraImagesColumnReady = null;

export async function hasExtraImagesColumn() {
  if (extraImagesColumnReady !== null) return extraImagesColumnReady;
  if (config.demoMode || !db()) {
    extraImagesColumnReady = false;
    return false;
  }
  try {
    const { error } = await db().from(TABLES.articles).select('extra_images').limit(1);
    extraImagesColumnReady = !error;
    if (error) {
      console.warn(
        '[store] articles.extra_images is missing — run supabase/017_gallery_categories_and_article_photos.sql',
        error.message
      );
    }
  } catch {
    extraImagesColumnReady = false;
  }
  return extraImagesColumnReady;
}

/**
 * Does `media_assets.category_id` exist yet?
 *
 * Same rationale as hasExtraImagesColumn() above, for the same migration (017).
 * This matters more than usual here: without it, one uncategorised upload
 * alongside a categorised one would fail with a 400 for the whole batch.
 */
let categoryColumnReady = null;

export async function hasCategoryColumn() {
  if (categoryColumnReady !== null) return categoryColumnReady;
  if (config.demoMode || !db()) {
    categoryColumnReady = false;
    return false;
  }
  try {
    const { error } = await db()
      .from(TABLES.mediaLibrary)
      .select('category_id')
      .limit(1);
    categoryColumnReady = !error;
    if (error) {
      console.warn(
        '[store] media_assets.category_id is missing — run supabase/017_gallery_categories_and_article_photos.sql',
        error.message
      );
    }
  } catch {
    categoryColumnReady = false;
  }
  return categoryColumnReady;
}

/**
 * May the signed-in account delete this article?
 *
 * This is a UI affordance only. The real enforcement is the RLS policy in
 * supabase/007_article_ownership.sql, which a leaked anon key cannot bypass.
 * Kept here so the Owner sees an honest disabled button instead of clicking
 * through to a database error.
 *
 * @param {{id: string, authorAccountId?: string|null, author?: string}} article
 */
export function canDeleteArticle(article) {
  if (!article) return false;
  const session = getSession();
  if (!session?.isAdmin) return false;
  if (isOwner()) return true;
  // A writer may delete only their own work.
  return Boolean(
    article.authorAccountId &&
      session.user?.id &&
      article.authorAccountId === session.user.id
  );
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
    featured: Boolean(input.featured),
    // Up to MAX_ARTICLE_PHOTOS, on top of the lead image above. Normalised here
    // so an over-long or malformed list from any caller is trimmed before it can
    // reach either the database CHECK or the renderer.
    extraImages: readExtraImages(input.extraImages)
  };

  if (!config.demoMode && db()) {
    // Only include author_account_id when the column actually exists. Sending an
    // unknown column makes PostgREST reject the whole insert (PGRST204), which
    // would mean a deploy that lands before migration 007 breaks article
    // creation for everyone. Probed once, then cached.
    const row = {
      title: article.title,
      author: article.author,
      category: article.category,
      published_at: article.date,
      image_url: article.image,
      caption: article.caption,
      body: article.body,
      status: article.status,
      featured: article.featured
    };

    if (await hasOwnershipColumn()) {
      row.author_account_id = currentAccountId();
    }

    // Only send extra_images once the column is known to exist. Sending an
    // unknown key makes PostgREST reject the entire insert with PGRST204, so
    // before 017 is pasted the photos would cost the writer their story, not
    // just their photos.
    if (article.extraImages.length && (await hasExtraImagesColumn())) {
      row.extra_images = article.extraImages;
    }

    const inserted = assertOk(
      await db()
        .from(TABLES.articles)
        .insert(row)
        .select()
        .single(),
      'create article'
    );
    article.id = inserted.id;
    article.authorAccountId = inserted.author_account_id ?? null;
  } else {
    // Demo store. Stamp the owner here too, otherwise a writer files a story
    // they then have no right to delete -- the rule would be untestable and
    // visibly wrong to anyone trying it in the demo.
    article.authorAccountId = currentAccountId();
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
    // Same gate as create: an unknown column in the payload fails the whole
    // update, which would lose the writer's text edits along with the photos.
    if (patch.extraImages !== undefined && (await hasExtraImagesColumn())) {
      row.extra_images = readExtraImages(patch.extraImages);
    }

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
  // Re-normalise rather than trusting the caller. Object.assign above copies
  // whatever shape the caller passed, and every other consumer of this object
  // (the reader view, the panel, the audit line) assumes the trimmed form.
  article.extraImages = readExtraImages(article.extraImages);
  await addAuditLog(`Updated article "${article.title}"`);
  commit();
  return article;
}

/**
 * DELETE — permanently remove an article and detach it from curation slots.
 *
 * WHY THIS USED TO LOOK BROKEN
 * The panel was rendering `seed-article-N` rows that no Postgres row backed (see
 * mergeState). `isPersistedId()` correctly refused to send a text id to a uuid
 * column, so the database call was skipped, the in-memory removal was discarded
 * because production never writes localStorage, and the story came straight back
 * on the next hydrate. With the seed no longer injected, the rows the panel shows
 * are real uuids and this genuinely deletes.
 *
 * A text id here means a local-only row from the demo store: it is removed from
 * memory and that is the correct outcome, so it is still a success.
 *
 * @param {string} id
 * @returns {Promise<boolean>} true when a row was removed
 */
export async function deleteArticle(id) {
  const current = getState();
  const article = current.articles.find((item) => item.id === id);
  if (!article) return false;

  const remote = !config.demoMode && db() && isPersistedId(id);

  if (remote) {
    // PostgREST reports success even when RLS matched zero rows, so the row
    // count has to be requested back explicitly. Without this a delete that the
    // database silently refused still reported success to the Owner.
    const { data, error } = await db()
      .from(TABLES.articles)
      .delete()
      .eq('id', id)
      .select('id');
    assertOk({ data, error }, 'delete article');
    if (!data || data.length === 0) {
      throw new Error(
        'That article was not deleted. You can only delete your own articles.'
      );
    }
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
    deadline: input.deadline || '',
    // Who owns the piece. Migration 021 added `assigned_to`; the hourly cron
    // pushes deadline reminders to exactly this person's devices, so a row left
    // NULL is simply never reminded about. `reporter` above is free text kept
    // for the public board - it cannot identify a device.
    assigned_to: input.assigned_to || null,
    // The free-text deadline is what the board renders. `due_at` is the
    // machine-readable copy the cron compares against now(); without it the
    // assignment is invisible to the reminder pass.
    due_at: input.due_at || null
  };

  if (!config.demoMode && db()) {
    const inserted = assertOk(
      await db()
        .from(TABLES.assignments)
        .insert({
          title: assignment.title,
          reporter: assignment.reporter,
          status: assignment.status,
          deadline: assignment.deadline,
          assigned_to: assignment.assigned_to,
          due_at: assignment.due_at
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
    // `assigned_to` and `due_at` are additive columns (migration 021). Sending
    // them only when the caller actually supplies one keeps this UPDATE
    // compatible with a deployment that has not run 021 yet: PostgREST rejects
    // the whole request if it names a column the table does not have.
    if (patch.assigned_to !== undefined) row.assigned_to = patch.assigned_to;
    if (patch.due_at !== undefined) row.due_at = patch.due_at;
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
    role: input.role || 'Writer',
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

/**
 * Every image on the shared shelf, each carrying the NAME of its category.
 *
 * `categoryName` is resolved here for the same reason as the category `count`:
 * the media tab and the gallery page both print it, and neither has the category
 * table to hand. Resolving it once keeps the two in step.
 */
export function listMedia() {
  const state = getState();
  const names = new Map(state.galleryCategories.map((cat) => [cat.id, cat.name]));

  return state.mediaLibrary.map((item) => ({
    ...item,
    categoryName: item.categoryId ? names.get(item.categoryId) || '' : ''
  }));
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
    galleryOrder: input.galleryOrder ?? null,
    // null = filed under the built-in "Other" group on the gallery page.
    categoryId: input.categoryId ?? null
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
          gallery_order: item.galleryOrder,
          // Only send the column when 017 exists. PostgREST rejects the whole
          // request with 400 on an unknown column, which would make a multi-file
          // upload fail wholesale because of one optional field.
          ...(await hasCategoryColumn() ? { category_id: item.categoryId } : {})
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
    if (patch.categoryId !== undefined && (await hasCategoryColumn())) {
      row.category_id = patch.categoryId || null;
    }
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
 *
 * A category is REQUIRED to publish. `categoryId` may be null, but it may not
 * be undefined: undefined means "the caller forgot", and publishing into no
 * category produces a photo that is in the gallery yet appears nowhere on the
 * public site. `listGalleryByCategory()` deliberately refuses to synthesise an
 * "Uncategorised" group, so such a photo would simply vanish.
 *
 * @param {string} id
 * @param {boolean} inGallery
 * @param {string|null} categoryId required (may be null) when inGallery is true
 */
export async function setGalleryItem(id, inGallery, categoryId) {
  if (inGallery && categoryId === undefined) {
    throw new Error('Publishing an image needs a gallery category.');
  }

  const order = inGallery ? getState().mediaLibrary.length + 1 : null;
  const patch = { inGallery, galleryOrder: order };
  if (inGallery) patch.categoryId = categoryId || null;

  const item = await updateMedia(id, patch);
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

/**
 * The Owner-defined category cards, in the order the Owner chose.
 *
 * `count` and `photos` are derived here rather than in the admin panel. Every
 * caller needs them -- the media tab prints the count, the public gallery page
 * shows the shots -- and computing them per caller meant one of the two read a
 * field that was never set and rendered the literal word "undefined".
 *
 * @returns {Array<{id:string,name:string,coverUrl:string,sortOrder:number|null,
 *                  count:number, photos:Array<object>}>}
 */
export function listGalleryCategories() {
  const state = getState();
  const published = state.mediaLibrary.filter((item) => item.inGallery);

  return [...state.galleryCategories]
    .sort((a, b) => (a.sortOrder ?? 9999) - (b.sortOrder ?? 9999))
    .map((cat) => {
      const photos = published.filter(
        (item) => item.categoryId && item.categoryId === cat.id
      );
      // Prefer a live shot over the stored cover so a category the Owner has
      // just filled does not still show its empty placeholder.
      const coverUrl = photos[0]?.url || cat.coverUrl || '';
      return { ...cat, count: photos.length, photos, coverUrl };
    });
}

/** CREATE — a new card on the gallery page. */
export async function createGalleryCategory(input) {
  const current = getState();
  const name = String(input.name || '').trim();
  if (!name) throw new Error('A gallery category needs a name.');

  const item = {
    id: newId('gcat'),
    name,
    coverUrl: input.coverUrl?.trim() || '',
    // Default to the end of the list so a new card does not jump the queue.
    sortOrder: input.sortOrder ?? current.galleryCategories.length + 1
  };

  if (!config.demoMode && db()) {
    const inserted = assertOk(
      await db()
        .from(TABLES.galleryCategories)
        .insert({
          name: item.name,
          cover_url: item.coverUrl || null,
          sort_order: item.sortOrder
        })
        .select()
        .single(),
      'create gallery category'
    );
    item.id = inserted.id;
  }

  current.galleryCategories = [...current.galleryCategories, item];
  await addAuditLog(`Created gallery category "${item.name}"`);
  commit();
  return item;
}

/** UPDATE — rename a card or swap its cover image. */
export async function updateGalleryCategory(id, patch) {
  const current = getState();
  const item = current.galleryCategories.find((entry) => entry.id === id);
  if (!item) return null;

  if (!config.demoMode && db() && isPersistedId(id)) {
    const row = {};
    if (patch.name !== undefined) row.name = String(patch.name).trim();
    if (patch.coverUrl !== undefined) row.cover_url = patch.coverUrl || null;
    if (patch.sortOrder !== undefined) row.sort_order = patch.sortOrder;
    if (Object.keys(row).length) {
      assertOk(
        await db()
          .from(TABLES.galleryCategories)
          .update(row)
          .eq('id', id)
          .select()
          .single(),
        'update gallery category'
      );
    }
  }

  Object.assign(item, patch);
  commit();
  return item;
}

/**
 * DELETE — remove a card. Photos filed under it are NOT deleted: the column is
 * nullable with `on delete set null`, so they fall back to the uncategorised
 * group on the public page rather than vanishing.
 */
export async function deleteGalleryCategory(id) {
  const current = getState();
  const item = current.galleryCategories.find((entry) => entry.id === id);
  if (!item) return false;

  if (!config.demoMode && db() && isPersistedId(id)) {
    assertOk(
      await db().from(TABLES.galleryCategories).delete().eq('id', id),
      'delete gallery category'
    );
    // `categoryId` is cleared in memory too, not just on the server: Postgres
    // cascades the FK, but only for rows it can see, and in demo mode there is no
    // server at all. Without this the client files photos under a card it has just
    // lost, and listGalleryByCategory() would build a synthetic "Uncategorised"
    // group for them -- which must never reach the public gallery page.
    current.mediaLibrary = current.mediaLibrary.map((entry) =>
      entry.categoryId === id ? { ...entry, categoryId: null, inGallery: false } : entry
    );
  }

  current.galleryCategories = current.galleryCategories.filter(
    (entry) => entry.id !== id
  );
  await addAuditLog(
    `Removed gallery category "${item.name}" (its photos were kept)`
  );
  commit();
  return true;
}

/**
 * Published photos grouped by category, for the gallery page.
 *
 * Returns every category the Owner has defined, including empty ones -- a card
 * with no photos yet is still something they chose to publish, and hiding it
 * would silently drop their work.
 *
 * UNCATEGORISED PHOTOS ARE NEVER RETURNED. This used to collect them under a
 * synthetic `null` key so an early upload could not disappear, but that is
 * exactly the leak the newsroom asked to close: a photo that was never filed
 * belongs on the Owner's shelf, not on the public gallery. Callers that want
 * those photos list the media shelf instead.
 *
 * @returns {Array<{category:object, shots:Array<object>}>}
 */
export function listGalleryByCategory() {
  const shots = listGallery();
  return listGalleryCategories().map((category) => ({
    category,
    shots: shots.filter((shot) => shot.categoryId === category.id)
  }));
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

/**
 * Restore every *setting* to the shipped default: masthead branding, the
 * breaking-news banner, Today's Pick, the three weekly slots and the
 * forced-notification lockout.
 *
 * This deliberately touches settings ONLY. Content is left alone -- articles,
 * staff, media, accounts and broadcast history are real newsroom records, and
 * "reset settings" is a request about configuration, not about deleting
 * published work. A separate, far louder action handles data.
 */
export async function resetAllSettings() {
  const seed = createSeedState();
  const current = getState();

  current.branding = { ...seed.branding };
  current.breakingNews = { ...seed.breakingNews };
  current.todaysPickId = seed.todaysPickId;
  current.weeklySlots = { ...seed.weeklySlots };
  // Only the setting, not activeSubscriberCount: that figure is read from
  // `push_subscriptions` at runtime and must stay honest.
  current.notifications.forced = seed.notifications.forced;
  current.notifications.permissionGranted = seed.notifications.permissionGranted;

  await persistSettings();
  await addAuditLog('Reset all settings to defaults');
  commit();

  return {
    branding: current.branding,
    breakingNews: current.breakingNews,
    todaysPickId: current.todaysPickId,
    weeklySlots: current.weeklySlots,
    forced: current.notifications.forced
  };
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

