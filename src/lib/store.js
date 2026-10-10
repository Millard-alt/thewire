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
import { captionText } from './dom.js';

const STORAGE_KEY = 'wire.state.v1';

/**
 * Row ceilings for `hydrate()`.
 *
 * These tables were read in full, with no limit, on every page load for every
 * reader including anonymous ones. That cost grows without bound: the five
 * hundredth article costs exactly as much as the first, and `body` carries the
 * full text of every one of them.
 *
 * DELIBERATELY NOT applied to `articles`, `media_assets` or `staff`. The panel
 * filters those client-side over the complete set, so a cap would silently hide
 * content from the Owner -- a worse failure than the egress it saves. They need
 * a paginated panel query, which is a larger change than this.
 */
const HYDRATE_LIMITS = {
  // Archival. The UI shows the newest; the panel queries the rest itself.
  interviews: 50
};

/**
 * State slice -> Supabase table name.
 */
const TABLES = {
  articles: 'articles',
  assignments: 'assignments',
  staff: 'staff',
  topPerformers: 'top_performers',
  mediaLibrary: 'media_assets',
  galleryCategories: 'gallery_categories',
  auditLogs: 'audit_logs',
  broadcasts: 'broadcasts',
  interviews: 'interviews'
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

/**
 * How many YouTube videos one interview may carry.
 *
 * Three is the product decision from the spec, and it is enforced in three
 * places that must agree: here (so the UI never offers a fourth field), in the
 * `interviews_video_ids_check` CHECK in supabase/migrations/022_interviews.sql
 * (so a hand-rolled request cannot bypass it), and in the editor's own trim.
 * The database is the authority; this one is for the reader's benefit.
 */
export const MAX_INTERVIEW_VIDEOS = 3;

/**
 * The two hosts an embed may load from.
 *
 * `youtube-nocookie.com` is the default and `youtube.com` is kept as a fallback
 * for the Owner if an embed is ever blocked. Both are honoured by the renderer,
 * which builds the src from an id and never from a stored URL.
 */
export const YOUTUBE_EMBED_HOSTS = ['www.youtube-nocookie.com', 'www.youtube.com'];

/**
 * The workflow statuses an interview can hold, matching the CHECK constraint in
 * supabase/migrations/022_interviews.sql exactly.
 */
export const INTERVIEW_STATUSES = ['pending', 'published'];

/**
 * The one place a candidate id is allowed to become an id.
 *
 * Centralising this is what makes the guarantee below auditable: there is no
 * second code path that returns a video id, so there is no second place a bad
 * one can be introduced. Also used as an array callback, hence the loose
 * signature.
 *
 * @param {unknown} candidate
 * @returns {string}
 */
function acceptId(candidate) {
  const text = String(candidate ?? '').trim();
  return /^[A-Za-z0-9_-]{11}$/.test(text) ? text : '';
}

/**
 * Reduce any accepted YouTube URL shape to the bare 11-character video id.
 *
 * WHY THIS IS THE MOST IMPORTANT FUNCTION IN THE FEATURE
 * Everything downstream interpolates the result straight into
 * `<iframe src="https://www.youtube-nocookie.com/embed/${id}">`. If this ever
 * returned anything but an id, that string becomes an attacker-controlled URL:
 * a value like `x"></iframe><script>...` would close the tag and inject markup.
 * Escaping the attribute would stop the attribute breaking out, but the value
 * would still be spliced into a URL, so the real fix is to never accept a
 * non-id in the first place. Hence the final guard -- a value is only returned
 * if it matches YouTube's id alphabet AND is exactly 11 characters long.
 *
 * This is belt-and-braces with the CHECK constraint in migration 022, on purpose:
 * a row that somehow bypassed the constraint must still not produce a bad src.
 *
 * Accepted shapes, all of which appear in the wild:
 *   https://www.youtube.com/watch?v=ID            (the canonical link)
 *   https://youtube.com/watch?v=ID&t=42s          (extra query junk)
 *   https://youtu.be/ID                           (the short link)
 *   https://youtu.be/ID?t=42                      (short link with a start time)
 *   https://www.youtube.com/embed/ID              (the embed url itself)
 *   https://www.youtube-nocookie.com/embed/ID     (privacy-preserving embed)
 *   https://www.youtube.com/shorts/ID             (Shorts)
 *   https://www.youtube.com/live/ID               (a livestream replay)
 *   https://m.youtube.com/watch?v=ID              (mobile)
 *   //www.youtube.com/watch?v=ID                  (protocol-relative paste)
 *   www.youtube.com/watch?v=ID                    (schemeless paste)
 *   ID                                            (a bare id typed by hand)
 *   https://www.youtube.com/watch?list=PL...&v=ID (playlist member link)
 *
 * Returns '' for anything unrecognised, including a YouTube URL for a CHANNEL or
 * PLAYLIST with no video in it -- those have no embeddable id, and silently
 * returning a channel handle would build a 404 embed.
 *
 * @param {string} value
 * @returns {string} an 11-character id, or '' if this is not a video reference
 */
export function normaliseYouTubeId(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';

  // A bare id typed straight into the field. Checked first because it is the
  // cheapest test and by far the most common input on an edit.
  if (/^[A-Za-z0-9_-]{11}$/.test(raw)) return raw;

  let url;
  try {
    // Accept schemeless and protocol-relative pastes too. `new URL` needs a
    // scheme, and prefixing a throwaway one is safe because we only read
    // pathname/search back out and never navigate to the result.
    url = new URL(
      raw.startsWith('//')
        ? `https:${raw}`
        : /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
          ? raw
          : `https://${raw}`
    );
  } catch {
    return '';
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, '').replace(/^m\./, '');

  // youtube.com         -> 'youtube.com'
  // youtu.be             -> 'youtu.be'
  // youtube-nocookie.com -> 'youtube-nocookie.com'
  // music.youtube.com    -> not collapsed by the www/m stripping above, but
  //                         still matched by the `.youtube.com` suffix test,
  //                         which is correct: a music.youtube.com link is a
  //                         real YouTube video and carries a normal 11-char id.
  const isYoutube =
    host === 'youtube.com' ||
    host === 'youtube-nocookie.com' ||
    host.endsWith('.youtube.com');
  const isShort = host === 'youtu.be';

  if (!isYoutube && !isShort) return '';

  // The short link carries the id in the path itself: youtu.be/ID
  if (isShort) return acceptId(url.pathname.split('/').filter(Boolean)[0]);

  // Standard link, and the one that also carries ?list=...&v=... from a
  // "save to playlist" click. `v` wins over the path, because on a /watch URL
  // the path carries no id at all.
  const fromQuery = url.searchParams.get('v');
  if (fromQuery) {
    const id = acceptId(fromQuery);
    if (id) return id;
  }

  // /embed/ID, /shorts/ID, /live/ID, /v/ID -- all id-in-path.
  const segments = url.pathname.split('/').filter(Boolean);
  if (['embed', 'shorts', 'live', 'v'].includes(segments[0])) {
    return acceptId(segments[1]);
  }

  return '';
}

/**
 * Build the `<iframe src>` for one video id.
 *
 * The ONLY way this feature produces a YouTube URL. Three properties matter and
 * all three come from routing every call through here:
 *
 *   1. The host is a literal from YOUTUBE_EMBED_HOSTS, never anything derived
 *      from the caller's value, so a stored id cannot redirect the embed.
 *   2. The path segment is the output of normaliseYouTubeId(), which is
 *      constrained to [A-Za-z0-9_-]{11}. That is what makes the result safe to
 *      interpolate into an attribute -- a value like `x"></iframe><script>`
 *      cannot survive the regex, so it can never close the tag.
 *   3. Anything that does not normalise returns '' and the caller renders
 *      nothing, rather than an iframe pointing at an invalid src.
 *
 * `rel=0` is omitted so the player shows its own related-video suggestions; the
 * reader lands on the interview they asked for, not on a queue of other people's
 * interviews.
 *
 * @param {unknown} value an id or any accepted URL shape
 * @param {{host?: string}} [options] override the embed host (Owner fallback)
 * @returns {string} an embed URL, or '' if this is not a usable video
 */
export function youtubeEmbedUrl(value, { host } = {}) {
  const id = normaliseYouTubeId(value);
  if (!id) return '';

  const chosen =
    YOUTUBE_EMBED_HOSTS.includes(String(host || '').toLowerCase())
      ? String(host).toLowerCase()
      : YOUTUBE_EMBED_HOSTS[0];

  // encodeURIComponent on an already-validated id is a no-op today, and is kept
  // so that relaxing the id charset later cannot silently open an injection.
  return `https://${chosen}/embed/${encodeURIComponent(id)}`;
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
    // Same reasoning, for the newest slice. `remote: true` matters most here: on
    // a live database an empty `interviews` table means nobody has filed one yet,
    // and re-injecting demo rows would put three fabricated interviews with fake
    // video ids on the public front page.
    interviews: pick(next.interviews, seed.interviews).map(mapInterviewRow),
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

    // Interviews are loaded in their own guarded block rather than as an entry in
    // the Promise.all above, and that is the whole point of the arrangement.
    //
    // The Promise.all is wrapped in ONE try/catch that falls back to the whole
    // local store. Adding interviews to it means a deployment that ships this
    // build before migration 022 is pasted fails the select with PGRST204, and
    // one unapplied migration then takes down articles, staff, media and
    // everything else with it — the reader gets the demo site instead of the
    // real one. Isolated here, the worst case is an empty interviews tab and a
    // warning in the console.
    let interviews = [];
    if (!config.demoMode && client && (await hasInterviewsTable())) {
      try {
        // Bounded, unlike the tables in the Promise.all above.
        //
        // `body` is the full text of the interview, so an unbounded read ships
        // every transcript to every reader on every page load -- including the
        // anonymous front page, which renders at most a handful. These are
        // archival interviews, so the newest slice is what the UI shows and the
        // rest is reachable through the panel's own queries.
        const { data, error } = await client
          .from(TABLES.interviews)
          .select('*')
          .order('created_at', { ascending: false })
          .limit(HYDRATE_LIMITS.interviews);
        if (!error) interviews = data || [];
        else console.warn('[store] could not load interviews', error.message);
      } catch (error) {
        console.warn('[store] interviews read failed', error);
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
        // Manual front-page position (migration 024). NULL means "no manual
        // placement", and listPublishedArticles() sorts those by date as before
        // -- so the migration cannot rearrange a live front page by itself, only
        // an explicit save can.
        displayOrder: row.display_order ?? null,
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
        // 037: media needs approval before it is public. A row that predates the
        // column reads back undefined, and 037 backfilled every existing row to
        // 'approved', so undefined means "a database where 037 has not been
        // applied" -- treat it as approved so the gallery is not blanked there.
        status: row.status ?? 'approved',
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
      /*
       * Interviews.
       *
       * The rows were fetched above into the `interviews` local, and that value
       * has to be handed to replaceState explicitly. Omitting it left the
       * hydrated state falling back to whatever the local store held, so on a
       * live database the feed rendered the demo seed and every interview the
       * newsroom had actually filed was invisible -- while the Owner, whose
       * writes had gone to Postgres correctly, saw nothing they could fix.
       *
       * `remote: true` is in force by this point, so an empty table yields an
       * empty list rather than three fabricated interviews.
       */
      interviews: interviews.map(mapInterviewRow),
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
        weeklySlots: settingsRow.weekly_slots || {},
        // Migration 023 may not be applied yet, in which case PostgREST omits
        // the key entirely. Default to enabled rather than to undefined: an
        // undefined flag is falsy and would hide the band for every reader on
        // a database that never asked for it.
        showThisWeek: settingsRow.show_this_week ?? true
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
 *
 * The database row is written by `wire_log_audit` (migration 035), which fills
 * `actor_name` from the bearer token. `actor` is therefore cosmetic here: it
 * labels the optimistic local entry only. It used to be sent to the server,
 * which let any staff member write a log line naming somebody else — the row
 * is now unforgeable.
 *
 * @param {string} action
 * @param {string} [actor] Display name for the optimistic local entry.
 */
export async function addAuditLog(action, actor = 'Owner') {
  const entry = { id: newId('audit'), user: actor, action, time: nowStamp() };
  const current = getState();
  current.auditLogs = [entry, ...current.auditLogs].slice(0, 100);

  if (!config.demoMode && db()) {
    try {
      assertOk(
        await db().rpc('wire_log_audit', { p_action: action }),
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
 * May this session move a row between review states -- approve or unpublish?
 *
 * THE APPROVER TIER: the Owner seat, or an Active Board Manager.
 *
 * This mirrors `public.can_approve()` in supabase/migrations/030_approver_tier.sql
 * exactly. The database is what decides -- this exists so the button is honest
 * rather than so the decision is made in the browser. A Writer who reaches the
 * hidden handler anyway is refused by the RLS policy, which is the point of
 * keeping the two in step.
 *
 * SCOPE, PRECISELY: the approve DECISION. It does not grant editing another
 * author's work, deleting, or reordering the front page. `canEditArticle` and
 * `canDeleteArticle` below are separate questions with separate answers.
 *
 * @returns {boolean}
 */
export function canApprove() {
  const session = getSession();
  if (!session?.isAdmin) return false;
  if (isOwner()) return true;
  return String(session.user?.role || '').toLowerCase() === 'board manager';
}

/**
 * May this session EDIT this article?
 *
 * DISTINCT FROM canApprove(), and the distinction is the whole point of the
 * lockdown: a Board Manager may clear the review queue without inheriting the
 * ability to rewrite somebody else's story. A Writer may only touch their own.
 *
 * The database already enforces this -- `articles_update_own` permits only
 * `wire_owns_article(id) or is_owner() or author_account_id is null` -- so this
 * is about not offering an Edit button that leads to a permission error.
 *
 * @param {{authorAccountId?: string|null}} article
 * @returns {boolean}
 */
export function canEditArticle(article) {
  if (!article) return false;
  const session = getSession();
  if (!session?.isAdmin) return false;
  if (isOwner()) return true;
  return Boolean(
    article.authorAccountId && session.user?.id && article.authorAccountId === session.user.id
  );
}

/**
 * May this session EDIT this interview? Mirrors canEditArticle exactly.
 *
 * @param {{authorAccountId?: string|null}} interview
 * @returns {boolean}
 */
export function canEditInterview(interview) {
  if (!interview) return false;
  const session = getSession();
  if (!session?.isAdmin) return false;
  if (isOwner()) return true;
  return Boolean(
    interview.authorAccountId &&
      session.user?.id &&
      interview.authorAccountId === session.user.id
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
/**
 * Published articles in front-page order.
 *
 * ORDER OF RANK, NOT OF ROW
 * --------------------------
 * A story the Owner has placed with `display_order` comes before everything
 * else, in that order. Everything else keeps the order it already had.
 *
 * The two are ranked separately rather than coalesced into one number, because
 * they are different things: a manual position is an instruction, a date is an
 * observation. Coalescing them would mean an unplaced story published today
 * outranking a placed one, so "put this at the top" would depend on when it was
 * filed -- the behaviour the Owner is trying to get rid of.
 *
 * DELIBERATELY NOT RE-SORTED
 * --------------------------
 * The unplaced tail is passed through in the store's own order, which is
 * `created_at desc` from the database query. Sorting it again by the article's
 * `published_at` looks tidier and is wrong: the two columns disagree for every
 * story written before publication, so it silently reordered the front page AND
 * the Curation tab's dropdown -- a change to a published page that nothing asked
 * for. If the default order is ever wrong, that is a change to the query, made
 * deliberately.
 */
export function listPublishedArticles() {
  const published = getState().articles.filter((article) =>
    isStatus(article.status, 'Published')
  );

  const placed = published
    .filter((article) => Number.isFinite(article.displayOrder))
    .sort((a, b) => a.displayOrder - b.displayOrder);

  return [...placed, ...published.filter((article) => !Number.isFinite(article.displayOrder))];
}

/**
 * Save the front-page layout: one call, one statement, the whole order.
 *
 * @param {string[]} ids  article ids in the order the Owner arranged them
 * @returns {Promise<{ok: boolean, message?: string, saved?: number}>}
 */
export async function saveArticleLayout(ids) {
  const order = (ids || []).map((id) => String(id || '').trim()).filter(Boolean);
  if (!order.length) return { ok: false, message: 'There is no layout to save.' };

  if (config.demoMode || !db()) {
    const current = getState();
    const position = new Map(order.map((id, index) => [id, index + 1]));
    current.articles = current.articles.map((article) =>
      position.has(article.id) ? { ...article, displayOrder: position.get(article.id) } : article
    );
    await addAuditLog(`Reordered the front page (${order.length} stories)`);
    commit();
    return { ok: true, saved: order.length };
  }

  // assertOk rather than a hand-rolled message: every other write in this module
  // reports a failure the same way, and `guard()` in the panel renders
  // error.message directly.
  let saved;
  try {
    saved = assertOk(
      await db().rpc('wire_set_article_layout', { p_ids: order }),
      'save the front page layout'
    );
  } catch (error) {
    return { ok: false, message: error.message };
  }

  // The RPC writes positions but does not return the rows, so the local state is
  // updated from what was sent rather than refetched. One round trip instead of
  // two, and the panel repaints from the same numbers the database now holds.
  const current = getState();
  const position = new Map(order.map((id, index) => [id, index + 1]));
  current.articles = current.articles.map((article) =>
    position.has(article.id) ? { ...article, displayOrder: position.get(article.id) } : article
  );
  await addAuditLog(`Reordered the front page (${saved ?? order.length} stories)`);
  commit();
  return { ok: true, saved: saved ?? order.length };
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
    author: input.author?.trim() || 'The Pulse Staff',
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
/* INTERVIEWS — full CRUD                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Reduce whatever a caller supplied to a clean list of video ids.
 *
 * Accepts ids OR urls, because the editor's fields are text boxes a writer
 * pastes a share link into and nobody should have to be told which form is
 * wanted. Anything unrecognised is DROPPED rather than passed through: an id we
 * cannot parse is not a video, and the reader is better served by a missing
 * embed than a broken one.
 *
 * Duplicates are collapsed because pasting the same link into all three fields
 * is an easy mistake, and three identical embeds is not what it looks like.
 * Order is otherwise preserved -- the writer chose it.
 *
 * Trimmed to MAX_INTERVIEW_VIDEOS so an over-long list can never reach either the
 * database CHECK or the renderer.
 *
 * @param {unknown} value an array of ids/urls, or a single string
 * @returns {string[]} unique 11-character ids, at most MAX_INTERVIEW_VIDEOS
 */
export function readVideoIds(value) {
  const list = Array.isArray(value) ? value : value == null ? [] : [value];
  const seen = new Set();
  const out = [];

  for (const entry of list) {
    const id = normaliseYouTubeId(entry);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length === MAX_INTERVIEW_VIDEOS) break;
  }

  return out;
}

/**
 * Read a field that may be spelled either way.
 *
 * Postgres rows arrive snake_case; the demo seed and anything already sitting in
 * localStorage is camelCase, because that is the shape mergeState() hands to the
 * views. Without this dual read, `mergeState()` re-running mapInterviewRow() over
 * an in-memory state would blank every field whose snake_case name is absent —
 * which for the demo store means every interview silently loses its guest,
 * description and videos on the second read, not the first.
 *
 * @param {object} row
 * @param {string} snake
 * @param {string} camel
 * @returns {unknown}
 */
function interviewField(row, snake, camel) {
  return row[snake] ?? row[camel];
}

/**
 * Map one database row onto the camelCase shape the views read.
 *
 * Centralised because the same mapping is needed on hydration AND after every
 * write: create/update get their authoritative values back from the row the
 * database returned, and re-mapping is what keeps a freshly written interview
 * from differing in shape from one that arrived on boot. `video_ids` goes
 * through readVideoIds() so a row written by hand, or by an older build, cannot
 * put a non-id in front of the renderer.
 *
 * @param {object} row
 * @returns {object}
 */
/**
 * Which archive a row belongs to. Migration 040.
 *
 * DEFAULTED TO 'interview' RATHER THAN READ AS-IS, and that is the whole point.
 * A client can be deployed before 040 is pasted into the database, and this
 * build would then read `undefined` for every row -- putting every published
 * interview into neither feed. The archives are reached from the site nav, so
 * that failure is a silently empty page rather than an error.
 *
 * Anything unrecognised also falls to 'interview', for the same reason: the
 * column has a CHECK constraint, so an unexpected value can only come from a
 * database older than that constraint, and hiding those rows would be worse
 * than showing them in the wrong feed.
 */
export const MEDIA_CATEGORIES = ['interview', 'video'];

function mediaCategory(row) {
  const raw = String(interviewField(row, 'category', 'category') || '').toLowerCase();
  return MEDIA_CATEGORIES.includes(raw) ? raw : 'interview';
}

function mapInterviewRow(row) {
  return {
    id: row.id,
    title: interviewField(row, 'title', 'title') || '',
    guest: interviewField(row, 'guest', 'guest') || '',
    guestRole: interviewField(row, 'guest_role', 'guestRole') || '',
    interviewer: interviewField(row, 'interviewer', 'interviewer') || '',
    summary: interviewField(row, 'summary', 'summary') || '',
    description: interviewField(row, 'description', 'description') || '',
    image: interviewField(row, 'image_url', 'image') || '',
    videoIds: readVideoIds(interviewField(row, 'video_ids', 'videoIds')),
    // Lower-cased here so a row pasted by hand in title case is not stranded
    // behind a comparison that will never match.
    status: String(interviewField(row, 'status', 'status') || 'pending').toLowerCase(),
    category: mediaCategory(row),
    authorAccountId: interviewField(row, 'author_account_id', 'authorAccountId') ?? null,
    publishedAt: interviewField(row, 'published_at', 'publishedAt') || null,
    createdAt: interviewField(row, 'created_at', 'createdAt') || null
  };
}

/** Every interview, newest first. Owners and writers see the pending queue too. */
export function listInterviews() {
  return [...getState().interviews];
}

/**
 * Every row in ONE archive, regardless of status.
 *
 * Backs the Owner Panel's Videos & Interviews sub-tabs. Filtered in the client
 * rather than in the query, because `hydrate()` has already loaded the table and
 * the panel needs both halves at once to render the switcher with real counts.
 */
export function listMediaByCategory(category) {
  const want = MEDIA_CATEGORIES.includes(category) ? category : 'interview';
  return getState().interviews.filter((item) => mediaCategory(item) === want);
}

/** How many rows each archive holds, for the sub-tab badges. */
export function countMediaByCategory() {
  const counts = { interview: 0, video: 0 };
  for (const item of getState().interviews) counts[mediaCategory(item)] += 1;
  return counts;
}

/**
 * Only what a reader is allowed to see.
 *
 * The status filter here is a UI courtesy, not the security boundary -- that is
 * the RLS policy in migration 022. Both exist because they fail differently: RLS
 * keeps a pending row off the pulse; this keeps a row that is ALREADY in local
 * memory out of the public feed while an Owner happens to be signed in.
 */
export function listPublishedInterviews() {
  return getState().interviews.filter((item) => isStatus(item.status, 'published'));
}

/**
 * Published rows in ONE archive. Backs /interviews and /videos-feed.
 *
 * Same two-layer reasoning as listPublishedInterviews(): the status filter is a
 * UI courtesy for rows already in memory, and the category filter is the split
 * 040 introduced. Neither is the security boundary -- that is the RLS policy.
 */
export function listPublishedMedia(category) {
  const want = MEDIA_CATEGORIES.includes(category) ? category : 'interview';
  return listPublishedInterviews().filter((item) => mediaCategory(item) === want);
}

/** @param {string} id */
export function getInterview(id) {
  return getState().interviews.find((item) => item.id === id) || null;
}

/** Everything awaiting the Owner's approval. */
export function getPendingInterviews() {
  return getState().interviews.filter((item) => isStatus(item.status, 'pending'));
}

/**
 * May the signed-in account delete this interview?
 *
 * A UI affordance only -- the real enforcement is the interviews_delete_own
 * policy plus wire_owns_interview() in migration 022. Kept here so the panel
 * shows an honest disabled button instead of letting the Owner click through to
 * a database error.
 *
 * @param {{id: string, authorAccountId?: string|null}} interview
 */
export function canDeleteInterview(interview) {
  if (!interview) return false;
  const session = getSession();
  if (!session?.isAdmin) return false;
  if (isOwner()) return true;
  return Boolean(
    interview.authorAccountId &&
      session.user?.id &&
      interview.authorAccountId === session.user.id
  );
}

/**
 * Has migration 022 been applied (i.e. does `public.interviews` exist)?
 *
 * Same defensive shape as hasOwnershipColumn()/hasExtraImagesColumn() above.
 *
 * Unlike those two this one guards the WHOLE feature rather than one optional
 * column, because every column of `interviews` arrives with the table: there is
 * no migration that adds `interviews` before migration 022 adds `video_ids`. A
 * deployment that ships this build before 022 is pasted would otherwise fail
 * EVERY interview read in hydrate() with PGRST204, and because hydration is
 * wrapped in one try/catch a single missing table would take the entire
 * publication down to the local demo store.
 *
 * Probed once and cached for the session.
 */
let interviewsTableReady = null;

export async function hasInterviewsTable() {
  if (interviewsTableReady !== null) return interviewsTableReady;
  if (config.demoMode || !db()) {
    interviewsTableReady = false;
    return false;
  }
  try {
    const { error } = await db().from(TABLES.interviews).select('id').limit(1);
    // PGRST204 here is the "table does not exist (yet)" signal. A permission
    // error is not, and is deliberately NOT cached as "unavailable": the table
    // exists, the RLS policy simply refused this key, and treating that as "the
    // feature is gone" would hide a policy bug behind a silently empty tab.
    interviewsTableReady =
      !error || !/does not exist|not found|PGRST/i.test(error.message || '');
    if (error) {
      console.warn(
        '[store] could not reach the interviews table — run supabase/migrations/022_interviews.sql',
        error.message
      );
    }
  } catch {
    interviewsTableReady = false;
  }
  return interviewsTableReady;
}

/**
 * The columns shared by an insert and an update, mapped from the camelCase the
 * views use to the snake_case the columns actually have.
 *
 * Extracted so the two cannot drift: a field added to create but forgotten in
 * update is the classic half-wired CRUD bug, and it shows up as "the Owner can
 * attach a video but editing the interview loses it".
 *
 * @param {object} input
 * @param {object} [existing] the current row, supplying fields the caller omits
 * @returns {object} a PostgREST-shaped payload
 */
function interviewRowFrom(input = {}, existing = {}) {
  const status = String(input.status ?? existing.status ?? 'pending').toLowerCase();
  return {
    title: String(input.title ?? existing.title ?? '').trim() || 'Untitled interview',
    // Blank stays blank. This used to be coerced to the literal 'Unnamed guest',
    // which was a workaround for 022's NOT NULL: the column demanded a value for
    // a video, which has no guest, so the store invented one and it rendered as
    // the card's headline. 040 drops the constraint and the video form drops the
    // field, so a missing guest is now honest and the renderers fall back to the
    // title. Inventing text here would put a placeholder in the DATABASE, where
    // the Owner would edit around it and readers would see it.
    guest: String(input.guest ?? existing.guest ?? '').trim(),
    guest_role: String(input.guestRole ?? existing.guestRole ?? '').trim(),
    interviewer: String(input.interviewer ?? existing.interviewer ?? '').trim(),
    summary: String(input.summary ?? existing.summary ?? '').trim(),
    description: String(input.description ?? existing.description ?? '').trim(),
    image_url: String(input.image ?? existing.image ?? '').trim(),
    video_ids: readVideoIds(input.videoIds ?? existing.videoIds),
    // Anything outside the vocabulary falls back to 'pending' rather than being
    // written verbatim. A status the CHECK constraint rejects fails the whole
    // INSERT and takes the writer's interview with it, and 'pending' is the safe
    // direction to fail: it asks for review instead of publishing.
    status: INTERVIEW_STATUSES.includes(status) ? status : 'pending',
    // Migration 040. Same rule as status, for the same reason: an unrecognised
    // category would fail the CHECK constraint and take the whole insert with it,
    // and 'interview' is the safe direction because it is what every row already
    // in the table is.
    category: MEDIA_CATEGORIES.includes(
      String(input.category ?? existing.category ?? 'interview').toLowerCase()
    )
      ? String(input.category ?? existing.category ?? 'interview').toLowerCase()
      : 'interview'
  };
}

/**
 * CREATE — file a new interview.
 *
 * Writers land in 'pending' unless they explicitly ask for another status; the
 * Owner can publish on the spot. Status is NOT forced by the session role here:
 * the database is what actually enforces who may publish (the
 * interviews_publish_guard trigger in migration 022), and duplicating that rule
 * in the browser would give the Owner a second opinion that can disagree with
 * the real one.
 *
 * @param {object} input
 * @returns {Promise<object>} the created interview
 */
export async function createInterview(input) {
  const current = getState();
  const row = interviewRowFrom(input);
  const interview = {
    id: newId('interview'),
    title: row.title,
    guest: row.guest,
    guestRole: row.guest_role,
    interviewer: row.interviewer,
    summary: row.summary,
    description: row.description,
    image: row.image_url,
    videoIds: row.video_ids,
    status: row.status,
    category: row.category,
    authorAccountId: null,
    publishedAt: null,
    createdAt: nowStamp()
  };

  if (!config.demoMode && db() && (await hasInterviewsTable())) {
    // Same convention as articles.author_account_id: stamp the filing account so
    // the ownership policy has something to match on.
    const inserted = assertOk(
      await db()
        .from(TABLES.interviews)
        .insert({ ...row, author_account_id: currentAccountId() })
        .select()
        .single(),
      'create interview'
    );

    // Re-map from the row the database RETURNED rather than trusting the payload
    // we sent. That is what picks up published_at, stamped by a trigger we do
    // not control, and it guarantees a freshly created interview has exactly the
    // same shape as one that arrived on boot.
    Object.assign(interview, mapInterviewRow(inserted));
  } else {
    // Demo store. Stamp the filer here too, otherwise a writer files an
    // interview they have no right to delete and the ownership rule cannot be
    // exercised outside a live database.
    interview.authorAccountId = currentAccountId();
    // Mirror the published_at trigger so the feed orders the same way in both
    // stores. A pending row deliberately gets null.
    if (interview.status === 'published') interview.publishedAt = nowStamp();
  }

  current.interviews = [interview, ...current.interviews];
  await addAuditLog(`Created interview "${interview.title}"`);
  commit();
  return interview;
}

/**
 * UPDATE — patch an existing interview.
 *
 * `video_ids` is always sent, even when the patch does not mention it. That is
 * deliberate and it is what keeps a save from silently dropping videos: the
 * payload is built from the patch MERGED OVER the live row, so an absent key
 * falls back to what is already stored rather than to undefined (which PostgREST
 * would write as SQL NULL). The remaining optional fields are only sent when the
 * caller actually supplied them, for the same reason.
 *
 * @param {string} id
 * @param {object} patch
 * @returns {Promise<object|null>} the updated interview, or null if not found
 */
export async function updateInterview(id, patch) {
  const current = getState();
  const interview = current.interviews.find((item) => item.id === id);
  if (!interview) return null;

  // Built from the patch over the CURRENT row, so every value here is either
  // what the caller just sent or what is already stored. Nothing is invented.
  const row = interviewRowFrom(patch, interview);
  const payload = {
    title: row.title,
    guest: row.guest,
    guest_role: interview.guestRole,
    interviewer: interview.interviewer,
    summary: interview.summary,
    description: interview.description,
    image_url: interview.image,
    video_ids: row.video_ids,
    status: row.status
  };
  if (patch.guestRole !== undefined) payload.guest_role = row.guest_role;
  if (patch.interviewer !== undefined) payload.interviewer = row.interviewer;
  if (patch.summary !== undefined) payload.summary = row.summary;
  if (patch.description !== undefined) payload.description = row.description;
  if (patch.image !== undefined) payload.image_url = row.image_url;

  /*
   * category IS DELIBERATELY NOT SENT.
   *
   * Migration 040 makes it immutable below the Owner seat, because re-tagging a
   * row moves it between two public archives and that is an editorial decision.
   * Sending it unconditionally would therefore make EVERY save by a Writer fail
   * with 42501 -- the payload would carry a category, the trigger would see a
   * change, and the trigger is right that nothing changed at all.
   *
   * So an ordinary edit leaves the column out of the statement entirely and
   * Postgres never evaluates it. `setMediaCategory` below is the one deliberate
   * way to move a row, and it is Owner-gated on both sides.
   */
  if (patch.category !== undefined) {
    const want = String(patch.category).toLowerCase();
    if (!MEDIA_CATEGORIES.includes(want)) {
      return null;
    }
    payload.category = want;
  }

  if (!config.demoMode && db() && isPersistedId(id) && (await hasInterviewsTable())) {
    // Re-map from the returned row: the published_at trigger has just fired (or
    // deliberately not, when the status did not change) and that is the only
    // place the authoritative value exists.
    const updated = assertOk(
      await db()
        .from(TABLES.interviews)
        .update(payload)
        .eq('id', id)
        .select()
        .single(),
      'update interview'
    );
    Object.assign(interview, mapInterviewRow(updated));
  } else {
    interview.title = payload.title;
    interview.guest = payload.guest;
    interview.guestRole = payload.guest_role;
    interview.interviewer = payload.interviewer;
    interview.summary = payload.summary;
    interview.description = payload.description;
    interview.image = payload.image_url;
    interview.videoIds = payload.video_ids;
    interview.status = payload.status;
    if (payload.category) interview.category = payload.category;
    // Mirror the published_at trigger in the demo store too, INCLUDING the
    // clearing arm, so pulling an interview back to pending takes it off the
    // ordered feed here exactly as it does in production.
    interview.publishedAt =
      interview.status === 'published' ? interview.publishedAt || nowStamp() : null;
  }

  await addAuditLog(`Updated interview "${interview.title}"`);
  commit();
  return interview;
}

/**
 * Move a row between the Interviews and Videos archives.
 *
 * The ONE deliberate category write, and deliberately separate from
 * `updateInterview`. Two reasons it cannot just be another field on that patch:
 *
 *   1. Migration 040 refuses a category change below the Owner seat. So this
 *      needs its own error surface -- a Writer gets told plainly that re-filing
 *      is not theirs to do, rather than a bare 42501 from the trigger.
 *   2. It is the only operation here that changes which PUBLIC page a row is on,
 *      so it gets its own audit line. An audit trail that records "Updated
 *      interview" for a move between archives is a trail that cannot answer the
 *      only question anybody would ask of it.
 *
 * @returns {Promise<{ok: boolean, message?: string, interview?: object}>}
 */
export async function setMediaCategory(id, category) {
  const want = String(category || '').toLowerCase();
  if (!MEDIA_CATEGORIES.includes(want)) {
    return { ok: false, message: 'That is not a kind of media The Pulse publishes.' };
  }

  const interview = getState().interviews.find((item) => item.id === id);
  if (!interview) return { ok: false, message: 'That entry no longer exists.' };
  if (mediaCategory(interview) === want) return { ok: true, interview };

  // Checked here as well as by the trigger, so a Writer gets a sentence instead
  // of a database error. The trigger remains the authority.
  if (!isOwner()) {
    return { ok: false, message: 'Only the Owner can move an entry between archives.' };
  }

  if (!config.demoMode && db() && isPersistedId(id) && (await hasInterviewsTable())) {
    const updated = await db()
      .from(TABLES.interviews)
      .update({ category: want })
      .eq('id', id)
      .select()
      .single();
    if (updated.error) {
      return { ok: false, message: `That entry could not be moved: ${updated.error.message}` };
    }
    Object.assign(interview, mapInterviewRow(updated.data));
  } else {
    interview.category = want;
  }

  await addAuditLog(`Moved "${interview.title}" to the ${want} archive`);
  commit();
  return { ok: true, interview };
}

/**
 * DELETE — permanently remove an interview.
 *
 * The row count is requested back explicitly because PostgREST reports success
 * even when RLS matched zero rows; without that check a delete the database
 * silently refused would still report success to the panel.
 *
 * @param {string} id
 * @returns {Promise<boolean>} true when a row was removed
 */
export async function deleteInterview(id) {
  const current = getState();
  const interview = current.interviews.find((item) => item.id === id);
  if (!interview) return false;

  if (!config.demoMode && db() && isPersistedId(id) && (await hasInterviewsTable())) {
    const { data, error } = await db()
      .from(TABLES.interviews)
      .delete()
      .eq('id', id)
      .select('id');
    assertOk({ data, error }, 'delete interview');
    if (!data || data.length === 0) {
      throw new Error(
        'That interview was not deleted. You can only delete your own interviews.'
      );
    }
  }

  // A non-uuid id is a demo-store row that only ever existed in localStorage;
  // removing it from memory is the correct outcome for it, so this is still a
  // success rather than a silently skipped write.
  current.interviews = current.interviews.filter((item) => item.id !== id);
  await addAuditLog(`Deleted interview "${interview.title}"`);
  commit();
  return true;
}

/* --------------------------------------------------------------------------
 * Workflow
 * ------------------------------------------------------------------------ */

/**
 * Move an interview into publication. This is also the "approve" action.
 * @param {string} id
 * @returns {Promise<object|null>}
 */
export async function publishInterview(id) {
  return updateInterview(id, { status: 'published' });
}

/**
 * Pull an interview back out of publication.
 *
 * Named "unpublish" rather than "reject" deliberately: unlike an article there
 * is no second editorial verdict here. A Writer submitting an interview is
 * filing a recording, not a draft that failed review, and no state here means
 * "we looked at this and said no" — it is either in the publication or it is
 * not. The column holds exactly the two values the CHECK constraint allows.
 *
 * @param {string} id
 * @returns {Promise<object|null>}
 */
export async function unpublishInterview(id) {
  return updateInterview(id, { status: 'pending' });
}

/**
 * How many interviews one page of the public feed holds.
 *
 * Three is the product decision from the spec and, deliberately, also the layout:
 * the feed is a single column on a phone, where three is already a full screen of
 * scrolling, and three video embeds abreast is about as many as stay legible on a
 * desktop. Changing this to a different number means re-reading that judgement,
 * so it is exported rather than inlined at each use.
 */
export const INTERVIEWS_PER_PAGE = 3;

/**
 * One page of the published feed, newest first.
 *
 * The slice is taken over the PUBLISHED list only. Slicing `interviews` directly
 * would let a pending row that happens to be in memory (an Owner is signed in and
 * has the queue open) consume a slot on the public feed and push a real
 * interview onto the next page — a bug that only reproduces for signed-in staff,
 * which is exactly the kind that reaches production unnoticed.
 *
 * @param {number} [page] 1-based
 * @returns {{items: object[], page: number, pageCount: number, total: number,
 *            hasPrev: boolean, hasNext: boolean}}
 */
/**
 * One page of ONE archive.
 *
 * The category filter happens BEFORE the sort and the slice, which is what
 * makes the two archives independent: each paginates over its own rows, so a
 * long interview archive does not push videos onto page 4.
 *
 * @param {'interview'|'video'} category
 * @param {number} page
 */
export function listPublishedMediaPage(category, page = 1) {
  return paginateMedia(listPublishedMedia(category), page);
}

export function listPublishedInterviewsPage(page = 1) {
  return paginateMedia(listPublishedInterviews(), page);
}

/** Shared paging maths, so both archives clamp and count identically. */
function paginateMedia(rows, page) {
  // Newest first. Falls back through publishedAt to createdAt so a row that was
  // published without a stamp still sorts sensibly rather than jumping to 1970.
  const ordered = [...rows].sort((a, b) => {
    const at = String(a.publishedAt || a.createdAt || '');
    const bt = String(b.publishedAt || b.createdAt || '');
    return bt.localeCompare(at);
  });

  const total = ordered.length;
  const pageCount = Math.max(1, Math.ceil(total / INTERVIEWS_PER_PAGE));
  // Clamp rather than reject. A stale bookmark pointing at page 9 of a feed that
  // now has two pages should land on the last page, not on an empty grid with no
  // way back - the reader would be stuck with no control to press.
  const current = Math.min(Math.max(1, Math.floor(Number(page) || 1)), pageCount);
  const start = (current - 1) * INTERVIEWS_PER_PAGE;

  return {
    items: ordered.slice(start, start + INTERVIEWS_PER_PAGE),
    page: current,
    pageCount,
    total,
    hasPrev: current > 1,
    hasNext: current < pageCount
  };
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

/** CREATE — add an image URL to the shared media shelf.
 *
 *  `status` is deliberately NOT sent. The column defaults to 'pending' in the
 *  database (migration 037) and the insert policy refuses any value a Writer
 *  chooses, so letting the server decide is what makes "a Writer cannot
 *  self-approve" true rather than merely intended. Sending status here would be
 *  a silent attempt to bypass a policy, and it would fail for Writers while
 *  succeeding for the Owner, which is a confusing bug rather than a clear one.
 */
export async function createMedia(input) {
  const current = getState();
  const item = {
    id: newId('media'),
    url: input.url?.trim() || '',
    caption: captionText(input.caption),
    // Opt-in: the Owner decides which uploads reach the public gallery.
    inGallery: Boolean(input.inGallery),
    galleryOrder: input.galleryOrder ?? null,
    // null = filed under the built-in "Other" group on the gallery page.
    categoryId: input.categoryId ?? null,
    // Local copy only; the database owns this value. Demo mode gets the SAME
    // 'pending' start as production on purpose -- otherwise the Pending badge
    // and the approve flow would be untestable in demo mode, which is exactly
    // where the Playwright panel tests run.
    status: 'pending'
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
    if (patch.status !== undefined) row.status = patch.status;
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

/**
 * Approve or reject a media item. Migration 037.
 *
 * The database is the authority here, not this function: `media_staff_write`
 * and `media_staff_update` both read `can_approve() or status = 'pending'`, so
 * a Writer calling this gets an RLS error rather than a silent no-op. That is
 * the point -- the button is hidden for Writers in the panel, but hiding a
 * button is cosmetic and the policy is what actually enforces it.
 *
 * Approving also clears inGallery. A photo that was waiting for sign-off should
 * not silently appear in the public gallery as a side effect of approval unless
 * it was already opted in.
 *
 * @param {string} id
 * @param {'approved'|'rejected'} status
 */
export async function setMediaStatus(id, status) {
  const current = getState();
  const item = current.mediaLibrary.find((entry) => entry.id === id);
  if (!item) return null;

  if (status !== 'approved' && status !== 'rejected') {
    throw new Error(`Unknown media status "${status}".`);
  }
  if (item.status === status) return item;

  await updateMedia(id, {
    status,
    ...(status === 'approved' ? { inGallery: Boolean(item.inGallery) } : { inGallery: false })
  });

  await addAuditLog(
    `${status === 'approved' ? 'Approved' : 'Rejected'} media asset "${item.caption || item.id}"`
  );
  return item;
}

/** Shorthand for the Approve button. */
export async function approveMedia(id) {
  return setMediaStatus(id, 'approved');
}

/** Shorthand for the Reject button. Removes it from the gallery as well. */
export async function rejectMedia(id) {
  return setMediaStatus(id, 'rejected');
}

/** Media still waiting on a Board Manager or the Owner. */
export function listPendingMedia() {
  return getState().mediaLibrary.filter((entry) => entry.status === 'pending');
}

/**
 * Has this media item cleared approval? Migration 037.
 *
 * A MISSING status counts as approved, and that is not a loophole. 037 makes the
 * column NOT NULL, so `status === undefined` can only mean the database has not
 * had 037 applied -- and in that world there is no approval gate at all, so
 * treating the gallery as empty would hide every existing photograph for no
 * benefit. Once 037 is applied the value is always one of the three literals and
 * this branch never fires.
 */
function isMediaApproved(entry) {
  return entry.status === undefined || entry.status === null || entry.status === 'approved';
}

/** The photos the Owner has chosen to publish, in their chosen order. */
export function listGallery() {
  return getState()
    .mediaLibrary.filter((entry) => entry.inGallery && isMediaApproved(entry))
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
    // Whether the "This Week In The Pulse" band appears on the homepage.
    // `undefined` must never write false — an unset flag means enabled.
    show_this_week: current.showThisWeek !== false,
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

/**
 * UPDATE today's pick, the three weekly slots and the homepage band flag.
 *
 * The visibility flag rides the same call as the slots it governs, so one Save
 * button on the Curation tab still writes a single coherent payload. Omitting
 * a key leaves that piece untouched: a re-roll of the pick or a one-slot edit
 * can never hide the band by accident.
 */
export async function saveCuration({ todaysPickId, weeklySlots, showThisWeek }) {
  const current = getState();
  if (todaysPickId !== undefined) current.todaysPickId = todaysPickId;
  if (weeklySlots !== undefined) {
    current.weeklySlots = { ...current.weeklySlots, ...weeklySlots };
  }
  if (showThisWeek !== undefined) current.showThisWeek = showThisWeek === true;
  await persistSettings();
  commit();
  return {
    todaysPickId: current.todaysPickId,
    weeklySlots: current.weeklySlots,
    showThisWeek: current.showThisWeek
  };
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
  current.showThisWeek = seed.showThisWeek;
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
    showThisWeek: current.showThisWeek,
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

