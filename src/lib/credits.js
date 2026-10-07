/* =============================================================================
   src/lib/credits.js — THE CREDITS PAGE AND THE ABOUT US PAGE
   -----------------------------------------------------------------------------
   TWO PUBLIC PAGES, ONE TABLE, AND A COLUMN THAT KEEPS THEM APART.

   `/credits` lists the people who made the paper. `/about` lists the board and
   the bylines. They used to share one roster, and "which page is this row on?"
   was answered by a NULL `category` column that the VIEW then filtered on. That
   produced two bugs this module is now built to make impossible:

     1. THE BLEED. `listCredits()` selected every row and let the renderer
        decide. The Credits page shipped board members' names, role colours,
        notes and photos to the browser and dropped them client-side, so they
        were in the page source for a page the reader was not on. Filtering in
        the browser is a convention, not a boundary.

     2. THE AMBIGUITY. "No category" had to mean both "not on About yet" and
        "deliberately Credits only". Promoting somebody to the board therefore
        also demoted them from the Credits page, which nobody asked for.

   `page_scope` (migration 028) says which page a row belongs to, is NOT NULL,
   is CHECK-constrained, and is enforced against `category` so the two can never
   disagree. Every public read below filters on it in the QUERY.

   THE BYLINE PORTRAIT CACHE IS DELIBERATELY NOT SCOPED
   -----------------------------------------------------
   `primePortraits()` builds the face cache used next to bylines, for people who
   have no staff profile. It reads BOTH scopes. If it were scoped to `credits`,
   every reporter listed on the About page would silently lose their portrait
   next to their bylines -- a regression on the front page, caused by a change
   to a page nobody was looking at. `listAllPeople()` exists for exactly this.

   `role_label` is free text and `role_color` is a hex triplet, so the Owner can
   invent a role that exists nowhere else and give it its own colour. Two people
   sharing a role colour is normal, which is what "Copy role colour" is for.

   ONLY THE OWNER CAN WRITE. There is no insert/update/delete policy on the
   table — RLS denies by default — so every save goes through a SECURITY DEFINER
   function that calls `is_owner()` first. An anon key cannot change either page.
   ========================================================================== */

import { getSupabase } from './supabase.js';
import { config } from './config.js';
import { escapeHtml, safeUrl, imageFallbackAttr } from './dom.js';
// Only for the demo-mode branch of resetPortrait(). store.js does not import
// this module, so there is no cycle.
import { updateStaff } from './store.js';

/**
 * The two pages a row can belong to.
 *
 * EXACTLY ONE per row. A person who must appear on both pages is TWO rows --
 * one per scope -- edited and ordered independently. This is the visible
 * consequence of migration 028 and it is the intended behaviour, not a
 * compromise.
 *
 * Constrained in three places, deliberately: the CHECK constraint on
 * `credits_people.page_scope` (migration 028), the guard in
 * `wire_credits_people_upsert`, and `normaliseScope()` here.
 *
 * @type {readonly ['about_us', 'credits']}
 */
export const PAGE_SCOPES = ['about_us', 'credits'];

/** Human label for a scope, used in Owner-panel headings and errors. */
const SCOPE_LABELS = { about_us: 'About Us', credits: 'Credits' };

/**
 * Fold a scope onto one this app knows.
 *
 * Deliberately forgiving about spelling -- 'about', 'About Us', 'ABOUT_US' all
 * land on `about_us` -- because this is the first thing that runs when the Owner
 * saves, and a rejected scope would be a rejection of a label the Owner can see
 * in the UI. Anything unrecognised falls back to `credits`, the older and larger
 * page, rather than to null: null would mean "belongs to neither page", which
 * is not a state the schema permits.
 *
 * @param {unknown} value
 * @returns {'about_us'|'credits'}
 */
export function normaliseScope(value) {
  const wanted = String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!wanted) return 'credits';
  if (wanted === 'about_us' || wanted === 'about' || wanted === 'aboutus') return 'about_us';
  return 'credits';
}

/**
 * Set when a roster read failed because `credits_people` does not exist yet.
 * Migrations 009 and 028 have to be run in the Supabase SQL Editor before any of
 * this can work, and an empty page gives the Owner no way to tell that apart from
 * "nobody is on the page yet". The flag lets the UI say which it is.
 */
let migrationMissing = false;

/** @returns {boolean} true when the credits_people table is absent. */
export function isCreditsMigrationMissing() {
  return migrationMissing;
}

/**
 * PostgREST reports an absent table and an absent column as the same "schema
 * cache" error, which is also what a transient network blip looks like. Only the
 * explicit cache/column wording counts as "migration not run".
 * @param {unknown} error
 */
function isMissingSchema(error) {
  const message = String(error?.message || '').toLowerCase();
  return (
    message.includes('schema cache') ||
    message.includes('does not exist') ||
    message.includes('could not find')
  );
}

/** Turn a Postgres error into something a newsroom owner can act on. */
function describe(error, what) {
  const text = String(error?.message || '');
  if (error?.code === '42883' || /wire_credits_people_/.test(text)) {
    return 'The newsroom server is missing the roster. Run supabase/migrations/009_credits_page.sql, then supabase/migrations/028_page_scopes.sql, in the Supabase SQL editor.';
  }
  if (/only the Owner can change the Credits page/.test(text)) {
    return 'Only the Owner can change this page.';
  }
  if (/unknown page scope/.test(text)) {
    return 'That page was not recognised. Reload the page and try again.';
  }
  if (/needs a category/.test(text)) {
    return 'An About Us entry needs a category: Board Members or Behind the Bylines.';
  }
  if (/role colour/.test(text)) {
    return 'The role colour must be a hex colour such as #1d4ed8.';
  }
  if (/a name is required/.test(text)) {
    return 'Give this person a name.';
  }
  return `Could not save the ${what}: ${text || 'unknown error'}`;
}

/* -------------------------------------------------------------------------- */
/* Public roster                                                               */
/* -------------------------------------------------------------------------- */

/** Every column either page or the Owner panel needs, in one place. */
const PERSON_COLUMNS =
  'id, name, role_label, role_color, blurb, portrait_url, sort_order, category, about_order, page_scope';

/**
 * Read rows for ONE page.
 *
 * `page_scope` is filtered IN THE QUERY, not afterwards. That is the entire
 * point of migration 028 and the reason this is a separate function rather than
 * one reader with a `.filter()` on the result: a client-side filter still ships
 * the whole table to the browser, which is how the Credits page ended up
 * carrying the board's photographs in its HTML.
 *
 * @param {'about_us'|'credits'} scope
 * @returns {Promise<Array<object>>} empty array when the table is missing
 */
async function listPeopleInScope(scope) {
  const wanted = normaliseScope(scope);

  if (config.demoMode) return demoRoster().filter((row) => normaliseScope(row.page_scope) === wanted);

  const client = getSupabase();
  if (!client) return [];

  const { data, error } = await client
    .from('credits_people')
    .select(PERSON_COLUMNS)
    .eq('page_scope', wanted)
    // The About page is ordered by its OWN column (about_order); the Credits page
    // by sort_order. One integer serving both lists would mean promoting
    // somebody to the board also reshuffled a published page.
    .order(wanted === 'about_us' ? 'about_order' : 'sort_order', { ascending: true })
    .order('name', { ascending: true });

  if (error) {
    // Migration 009 or 028 not applied yet. An empty page is a far better
    // failure for a reader than a wall of console noise.
    migrationMissing = isMissingSchema(error);
    console.warn(`[credits] could not load the ${SCOPE_LABELS[wanted]} page`, error);
    return [];
  }
  migrationMissing = false;
  return data || [];
}

/**
 * The Credits page roster: `page_scope = 'credits'` and nothing else.
 *
 * Board members and bylines are NOT here and cannot leak in — the query cannot
 * return a row whose scope is `about_us`, whatever the renderer does next.
 *
 * @returns {Promise<Array<object>>}
 */
export async function listCredits() {
  return listPeopleInScope('credits');
}

/**
 * The About Us page roster: `page_scope = 'about_us'` and nothing else.
 *
 * Grouping by category happens in `loadAboutRoster()`, one level up, because the
 * section headings are a presentation concern; this is just the scoped read.
 *
 * @returns {Promise<Array<object>>}
 */
export async function listAboutPeople() {
  return listPeopleInScope('about_us');
}

/**
 * EVERY row, both scopes, unscoped.
 *
 * USED BY EXACTLY TWO THINGS, both of which need the whole table:
 *
 *   1. `primePortraits()`, the byline face cache. A reporter on the About page
 *      with no staff profile gets their portrait next to their bylines from
 *      HERE. Scoping this to `credits` would strip the faces off the front page.
 *   2. `listCreditsForOwner()`, because the Owner panel needs to see everything
 *      before deciding which page a row belongs on.
 *
 * Nothing public calls it. If you are adding a page reader, use
 * `listCredits()` or `listAboutPeople()` instead.
 *
 * @returns {Promise<Array<object>>}
 */
export async function listAllPeople() {
  if (config.demoMode) return demoRoster();

  const client = getSupabase();
  if (!client) return [];

  const { data, error } = await client
    .from('credits_people')
    .select(PERSON_COLUMNS)
    .order('page_scope', { ascending: true })
    .order('sort_order', { ascending: true })
    .order('name', { ascending: true });

  if (error) {
    migrationMissing = isMissingSchema(error);
    console.warn('[credits] could not load the roster', error);
    return [];
  }
  migrationMissing = false;
  return data || [];
}

/**
 * The About Us page, grouped into its two rosters.
 *
 * Reads `page_scope = 'about_us'` only. Rows with no category cannot appear
 * here at all — the database CHECK forbids an `about_us` row without one — so
 * the two sections below are guaranteed to cover every row that was fetched.
 *
 * Never rejects. A reader landing on /about with the database unreachable gets an
 * empty roster and a heading that says so, not a blank page.
 *
 * @returns {Promise<Array<{category: string, people: Array<object>}>>}
 *   one entry per category, in ABOUT_CATEGORIES order, always all of them
 */
export async function loadAboutRoster() {
  const people = await listAboutPeople();
  return ABOUT_CATEGORIES.map((category) => ({
    category,
    people: people
      .filter((person) => normaliseAboutCategory(person.category) === category)
      .sort(
        (a, b) =>
          (a.about_order ?? 100) - (b.about_order ?? 100) ||
          String(a.name || '').localeCompare(String(b.name || ''))
      )
  }));
}

/** Paint the About page into `mount`. Safe to call repeatedly. */
export function renderAbout(mount) {
  if (!mount) return;

  loadAboutRoster().then((sections) => {
    // A re-render racing an earlier one would paint a roster the Owner has
    // already changed.
    if (!mount.isConnected) return;
    mount.innerHTML = aboutTemplate(sections);
  });
}

/**
 * One team card.
 *
 * The avatar falls back three ways, in order, because a photo on this page is
 * optional and a broken one must not be worse than none: the stored portrait,
 * then the neutral glyph (imageFallbackAttr covers a URL that 404s), then the
 * initials. The third is a server render rather than an onerror swap because it
 * needs the name, which the browser does not have.
 *
 * THE ROLE BADGE IS A PILL, NOT A BLOCK
 * -------------------------------------
 * It used to be `background: var(--role-colour); color: #fff` — a solid slab of
 * whatever colour the Owner picked, which is unreadable for every dark role
 * colour and shouts at the reader. Now the colour is a WASH: a 12%-alpha
 * background, a faint border, and the accent only on the text. The Owner's
 * colour still identifies the role; it just stops competing with the name.
 *
 * The accent is lightened until it passes 4.5:1 against the card, because the
 * Owner picks from a colour wheel with no contrast guidance and #1d4ed8 on
 * #18181b is 2.1:1. See `rolePalette()`.
 */
function aboutCard(person) {
  const url = safeUrl(person.portrait_url);
  const name = String(person.name || '').trim() || 'Team member';
  const role = String(person.role_label || '').trim();
  const note = String(person.blurb || '').trim();
  const palette = rolePalette(person.role_color);

  const photo = url
    ? `<img class="about-card__photo" src="${escapeHtml(url)}" ${imageFallbackAttr()}
         alt="${escapeHtml(name)}" width="72" height="72" loading="lazy" decoding="async" />`
    : `<span class="about-card__photo about-card__photo--empty" aria-hidden="true">
         <span class="about-card__initials">${escapeHtml(initialsOf(name))}</span>
       </span>`;

  return `
    <li class="about-card">
      ${photo}
      <div class="about-card__body">
        <p class="about-card__name">${escapeHtml(name)}</p>
        ${
          role
            ? `<span class="role-pill about-card__role"${
                palette ? paletteVars(palette) : ''
              }>${escapeHtml(role)}</span>`
            : ''
        }
        ${note ? `<p class="about-card__note">${escapeHtml(note)}</p>` : ''}
      </div>
    </li>
  `;
}

function aboutTemplate(sections) {
  const body = sections
    .map(
      ({ category, people }) => `
      <section class="about-roster" aria-labelledby="about-${slug(category)}">
        <h3 id="about-${slug(category)}" class="about-roster__heading">
          ${escapeHtml(category)}
        </h3>
        ${
          people.length
            ? `<ul class="about-grid">${people.map(aboutCard).join('')}</ul>`
            : `<p class="panel-sunken p-4 text-sm ink-muted">
                 Nobody listed under ${escapeHtml(category)} yet.
               </p>`
        }
      </section>`
    )
    .join('');

  return `
    <div class="mx-auto max-w-5xl px-4 py-10 md:py-14">
      <header class="about-hero">
        <p class="accent-text text-[0.625rem] font-bold tracking-[0.2em] uppercase">
          About us
        </p>
        <h1 class="about-hero__title">Stories that matter. Voices that count.</h1>
      </header>

      <section class="about-mission" aria-labelledby="about-mission-heading">
        <h2 id="about-mission-heading" class="font-headline text-2xl font-black tracking-wide uppercase">
          Our mission &amp; Vision
        </h2>
        <p class="about-mission__tagline">Truth &#8226; Integrity &#8226; Voice</p>

        <h3 class="about-mission__sub">Why we press</h3>
        <p class="about-mission__body">
          Every school has stories worth telling. From the roar in the sports field
          to the quiet achievements of students; From classroom breakthroughs to
          conversations that challenge us. We believe there is always a story
          waiting to be told.
        </p>

        <h3 class="about-mission__sub">Our promise</h3>
        <p class="about-mission__body">
          We promise to listen before we write, verify before we publish and
          respect the people behind every story.
        </p>
      </section>

      <section class="mt-12" aria-labelledby="about-press-heading">
        <h2 id="about-press-heading" class="font-headline text-2xl font-black tracking-wide uppercase">
          Meet the press
        </h2>
        <p class="ink-muted mt-2 text-sm">Behind every story is a team.</p>
        ${body}
      </section>
    </div>
  `;
}

/** An id-safe fragment from a heading. */
function slug(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
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
/* Owner actions                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Everything, both scopes, for the Owner panel.
 *
 * The panel is deliberately the ONE reader that is not scoped. It has to see a
 * row in order to decide which page the row belongs on, so a scoped read here
 * would make entries unreachable rather than tidy. Every PUBLIC read is scoped;
 * this one is not, and that asymmetry is the design.
 *
 * @returns {Promise<Array<object>>} empty array when unreadable
 */
export async function listCreditsForOwner() {
  return listAllPeople();
}

/**
 * The two About Us rosters, in the order they appear on the page.
 *
 * CONSTRAINED IN THREE PLACES, deliberately, because this list is rendered as
 * section headings and offered as a `<select>`: the CHECK constraint on
 * `credits_people.category` (migration 024), the guard in
 * `wire_credits_people_upsert`, and `normaliseAboutCategory` here. If they drift
 * apart, an unrecognised value becomes a heading that no filter matches -- a
 * section that renders for nobody and looks like a layout bug rather than a
 * data error.
 *
 * NOTE THE CHANGE FROM 024: an empty string is no longer "Credits page only".
 * That state is `page_scope`, a separate column that says it directly. This
 * function returning '' now means only "this row has no About Us category",
 * which the database forbids for an `about_us` row anyway.
 */
export const ABOUT_CATEGORIES = ['Board Members', 'Behind the Bylines'];

/**
 * Fold a category onto one this app knows, or '' for "no category".
 *
 * @param {unknown} value
 * @returns {string} one of ABOUT_CATEGORIES, or ''
 */
export function normaliseAboutCategory(value) {
  const wanted = String(value ?? '').trim().toLowerCase();
  if (!wanted) return '';
  return ABOUT_CATEGORIES.find((option) => option.toLowerCase() === wanted) || '';
}

/**
 * Add someone to ONE page.
 *
 * Note there is no `auth_user_id` and no account is created. That is the point:
 * these pages are pages about people, not about who can log in. A photographer
 * who has never opened the site belongs on them.
 *
 * `pageScope` decides which page. `category` is only sent when the scope is
 * `about_us`, and the server refuses an About Us entry without one -- so a typo
 * cannot create a section heading that renders for nobody.
 *
 * @param {{name: string, role: string, color: string, blurb?: string,
 *          portraitUrl?: string, pageScope?: string, category?: string,
 *          order?: number, aboutOrder?: number}} person
 */
export async function addPerson(person) {
  const name = String(person.name || '').trim();
  if (!name) return { ok: false, message: 'Give this person a name.' };

  const role = String(person.role || '').trim() || 'Contributor';
  const color = String(person.color || '').trim() || '#1d4ed8';
  const scope = normaliseScope(person.pageScope);
  // Only meaningful on the About page. normaliseAboutCategory returns '' for an
  // unrecognised value, which the server turns into a loud error rather than a
  // third heading that nothing renders.
  const category = scope === 'about_us' ? normaliseAboutCategory(person.category) : '';

  if (config.demoMode) {
    const rows = demoRoster();
    const entry = {
      id: `demo-${Date.now().toString(36)}`,
      name,
      role_label: role,
      role_color: color,
      blurb: String(person.blurb || '').trim(),
      portrait_url: String(person.portraitUrl || '').trim() || null,
      sort_order: nextDemoOrder(rows, 'sort_order'),
      page_scope: scope,
      // The About page's own order column, independent of sort_order.
      about_order: nextDemoOrder(rows, 'about_order'),
      category: scope === 'about_us' ? category : null
    };
    writeDemoRoster([...rows, entry]);
    return { ok: true, person: entry };
  }

  const client = getSupabase();
  if (!client) return { ok: false, message: 'Not connected to the newsroom server.' };

  // RPC NAME AND ARG NAMES MUST MATCH supabase/migrations/024_about_podcasts_and_layout.sql
  // for p_category/p_about_order, and supabase/migrations/028_page_scopes.sql for
  // p_page_scope.
  //
  // There is no wire_add_credits_person. The server exposes a single upsert,
  // wire_credits_people_upsert, where p_id = NULL means INSERT and p_id = the
  // uuid means UPDATE. Calling the three separate names that no longer exist
  // returned PGRST202 "Could not find the function" for every add, save and
  // remove, which is why the whole Credits tab was dead. The portrait argument
  // is p_portrait, not p_portrait_url.
  //
  // p_category arrived with 024, which DROPPED the old seven-argument signature
  // rather than overloading it -- two candidates for one PostgREST name is
  // PGRST202 again, so the drop in that migration is load-bearing. 028 dropped
  // 024's nine-argument signature for the same reason: adding p_page_scope by
  // OVERLOADING would have resurrected PGRST202 and killed both pages at once.
  const { data, error } = await client.rpc('wire_credits_people_upsert', {
    p_id: null,
    p_name: name,
    p_role_label: role,
    p_role_color: color,
    p_blurb: String(person.blurb || '').trim(),
    p_portrait: String(person.portraitUrl || '').trim(),
    p_sort_order: Number(person.order) > 0 ? Number(person.order) : 100,
    p_about_order: Number(person.aboutOrder) > 0 ? Number(person.aboutOrder) : 100,
    p_category: category,
    p_page_scope: scope
  });

  if (error) return { ok: false, message: describe(error, 'entry') };
  return { ok: true, person: data };
}

/**
 * Save an edit to one person.
 *
 * Every argument is nullable and the function coalesces, so sending only the
 * fields that changed cannot blank the rest. Passing an empty string to
 * `p_portrait` or `p_blurb` clears them on purpose.
 *
 * TWO SPELLINGS ARE ACCEPTED FOR EVERY FIELD, and this is deliberate. The
 * panel sends the database column names (`role_label`, `role_color`,
 * `sort_order`, `portrait_url`) because that is what the form fields are named
 * after, while the parameter list below historically used short names
 * (`role`, `color`, `order`, `portraitUrl`).
 *
 * Reading only one set is not a theoretical risk: it shipped, and it made the
 * entire Credits editor silently do nothing. updatePerson() saw `patch.role` as
 * undefined on every save, reported "Saved." with a success toast, and
 * discarded the new role, colour and order. Only `blurb` worked, purely because
 * that one name happens to be identical in both sets. Normalising here means a
 * caller cannot get this wrong again.
 *
 * @param {string} id
 * @param {{name?: string, role?: string, role_label?: string,
 *          color?: string, role_color?: string, blurb?: string,
 *          portraitUrl?: string, portrait_url?: string,
 *          category?: string|null, pageScope?: string, page_scope?: string,
 *          order?: number, sort_order?: number,
 *          aboutOrder?: number, about_order?: number}} patch
 */
export async function updatePerson(id, patch) {
  // Accept either spelling, short or column-name, for every field.
  const field = (...names) => {
    for (const name of names) {
      if (patch[name] !== undefined) return patch[name];
    }
    return undefined;
  };
  const roleValue = field('role', 'role_label');
  const colorValue = field('color', 'role_color');
  const portraitValue = field('portraitUrl', 'portrait_url');
  const orderValue = field('order', 'sort_order');
  const aboutOrderValue = field('aboutOrder', 'about_order');
  // page_scope is the "which page" column. Absent means "leave it alone", so an
  // editor that never mentions it cannot quietly move somebody between pages.
  // Each of the two Owner tabs always sends its own scope, which is what makes
  // "promote to the board" a deliberate act rather than a side effect.
  const scopeValue = field('pageScope', 'page_scope');
  const scope = scopeValue === undefined ? undefined : normaliseScope(scopeValue);
  // `category` is the other field that cannot use coalesce() semantics on the
  // server, because taking somebody OFF a heading is a real edit. So undefined
  // means "leave it alone" here, and '' or null means "clear it" -- which is
  // exactly the distinction a missing key cannot express in the RPC's argument
  // list. On the credits scope the server clears it regardless, because
  // credits_people_scope_category_check forbids a category there.
  const categoryValue =
    patch.category === undefined ? undefined : normaliseAboutCategory(patch.category);
  // about_order is the About page's own position. Absent means "leave it", which
  // is coalesce()'s job server-side -- see the note on the column in migration
  // 024 for why it is not the same column as sort_order.

  if (config.demoMode) {
    const rows = demoRoster();
    const index = rows.findIndex((row) => row.id === id);
    if (index === -1) return { ok: false, message: 'That entry is no longer on the page.' };

    // Mirror the SQL's coalesce semantics: an absent key means "leave alone",
    // an explicit empty string means "clear it".
    const next = rows[index];
    if (patch.name !== undefined) next.name = String(patch.name).trim() || next.name;
    if (roleValue !== undefined) {
      next.role_label = String(roleValue).trim() || next.role_label;
    }
    if (colorValue !== undefined) next.role_color = String(colorValue).trim() || next.role_color;
    if (patch.blurb !== undefined) next.blurb = String(patch.blurb).trim();
    if (portraitValue !== undefined) {
      next.portrait_url = String(portraitValue).trim() || null;
    }
    if (orderValue !== undefined) next.sort_order = Number(orderValue);
    if (aboutOrderValue !== undefined) next.about_order = Number(aboutOrderValue);
    if (scope !== undefined) {
      next.page_scope = scope;
      // Keep the demo store honest about the CHECK constraint: a credits row
      // carries no category, and an about_us row must carry one.
      if (scope === 'credits') next.category = null;
    }
    if (categoryValue !== undefined) next.category = categoryValue || null;
    if (next.page_scope === 'about_us' && !next.category) {
      next.category = 'Behind the Bylines';
    }

    rows[index] = next;
    writeDemoRoster(rows);
    return { ok: true, message: 'Saved.' };
  }

  const client = getSupabase();
  if (!client) return { ok: false, message: 'Not connected to the newsroom server.' };

  // The same single upsert as addPerson, with p_id set. There is no
  // wire_update_credits_person on the server and there never was; calling it
  // returned PGRST202 on every save, so edits silently did nothing. The
  // portrait argument is p_portrait, not p_portrait_url.
  //
  // Note the normalised values, not `patch.role` / `patch.color`. Reading only
  // the short names is exactly what made this a silent no-op: the panel sends
  // column names, so every argument arrived as null and the server's coalesce()
  // kept the old values while the client reported "Saved."
  const { error } = await client.rpc('wire_credits_people_upsert', {
    p_id: id,
    p_name: patch.name === undefined ? null : String(patch.name).trim(),
    p_role_label: roleValue === undefined ? null : String(roleValue).trim(),
    p_role_color: colorValue === undefined ? null : String(colorValue).trim(),
    p_blurb: patch.blurb === undefined ? null : String(patch.blurb).trim(),
    p_portrait: portraitValue === undefined ? null : String(portraitValue).trim(),
    p_sort_order: orderValue === undefined ? null : Number(orderValue),
    p_about_order: aboutOrderValue === undefined ? null : Number(aboutOrderValue),
    // Absent from the payload entirely when the caller did not mention the
    // scope, so the server keeps the row on the page it is already on.
    ...(scope === undefined ? {} : { p_page_scope: scope }),
    // Absent from the payload entirely when the caller did not mention the
    // category, so the server's unconditional assignment does not clear a
    // heading the panel simply did not render.
    ...(categoryValue === undefined ? {} : { p_category: categoryValue })
  });

  if (error) return { ok: false, message: describe(error, 'entry') };

  // A save that matched no row is a failure, not a success. Confirm the row the
  // caller asked about actually carries the new role, rather than reporting
  // "Saved." over an edit that went nowhere.
  const { data: after } = await client
    .from('credits_people')
    .select('id, role_label')
    .eq('id', id)
    .maybeSingle();

  if (!after) {
    return { ok: false, message: 'That entry no longer exists, so nothing was saved.' };
  }
  if (roleValue !== undefined && String(after.role_label || '') !== String(roleValue).trim()) {
    return { ok: false, message: 'The server did not save that role. Reload the page and try again.' };
  }

  return { ok: true, message: 'Saved.' };
}

/**
 * Remove someone from the Credits page. Only the Owner can reach this: the
 * table has no delete policy at all, and the RPC checks is_owner() before it
 * runs. Removing an entry deletes nobody's account and revokes no access — the
 * two were never connected.
 *
 * @param {string} id
 */
export async function removePerson(id) {
  if (config.demoMode) {
    const rows = demoRoster();
    const next = rows.filter((row) => row.id !== id);
    if (next.length === rows.length) {
      return { ok: false, message: 'That entry is no longer on the page.' };
    }
    writeDemoRoster(next);
    return { ok: true, message: 'Removed from the Credits page.' };
  }

  const client = getSupabase();
  if (!client) return { ok: false, message: 'Not connected to the newsroom server.' };

  const { data, error } = await client.rpc('wire_credits_people_delete', { p_id: id });
  if (error) return { ok: false, message: describe(error, 'credits entry') };

  // The function returns boolean rather than jsonb, and returns FALSE when no
  // row matched. Without this check a removed entry still reported success.
  if (data === false) {
    return { ok: false, message: 'That entry is no longer on the page.' };
  }
  return { ok: true, message: 'Removed from the Credits page.' };
}

/**
 * Approve or reject a submitted portrait on a staffer's row.
 *
 * This is about IDENTITY, not the Credits page: it controls whether a photo may
 * appear next to that person's bylines anywhere on the site. It stays in the
 * Staff tab.
 *
 * @param {string} staffId
 * @param {'approved'|'rejected'|'none'} status
 */
export async function setPortraitStatus(staffId, status) {
  const client = getSupabase();
  if (!client) return { ok: false, message: 'Not connected to the newsroom server.' };

  const { error } = await client.rpc('wire_set_portrait_status', {
    p_staff_id: staffId,
    p_status: status
  });

  if (error) return { ok: false, message: describe(error, 'portrait decision') };

  return {
    ok: true,
    message:
      status === 'approved'
        ? 'Portrait approved. It now appears with this writer’s bylines.'
        : status === 'rejected'
          ? 'Portrait rejected. It stays hidden until a new one is approved.'
          : 'Portrait cleared.'
  };
}

/**
 * Wipe a staffer's portrait so they can submit a properly cropped one.
 *
 * DISTINCT FROM `setPortraitStatus(id, 'rejected')`
 * -----------------------------------------------------------------------------
 * Rejecting leaves the bad photo on the row and only hides it. The Owner is then
 * looking at the very image that is wrong, with no way to judge the replacement,
 * and the staffer's row still carries a URL that a stale byline cache can pick up.
 *
 * A reset clears BOTH halves: `portrait_url` goes to '' and `portrait_status`
 * returns to 'none', the state a new hire starts in. Their bylines fall back to
 * initials immediately and the Owner's review queue stops showing a phantom
 * submission that no longer has a photo attached.
 *
 * It is deliberately not routed through `wire_assign_portrait`, which looks
 * equivalent but is gated on `is_staff()` rather than `is_owner()` and is not
 * granted to `anon`. See supabase/018_portrait_reset.sql for the full argument.
 *
 * @param {string} staffId
 */
export async function resetPortrait(staffId) {
  if (config.demoMode) {
    // Mirror the real write so the Owner's panel is fully usable in demo, and so
    // the suites can exercise the button without a database.
    const member = await updateStaff(staffId, {
      portrait_url: '',
      portrait_status: 'none'
    });
    if (!member) return { ok: false, message: 'That staffer is no longer on the roster.' };
    return {
      ok: true,
      message: 'Portrait cleared. They can submit a new one.'
    };
  }

  const client = getSupabase();
  if (!client) return { ok: false, message: 'Not connected to the newsroom server.' };

  const { error } = await client.rpc('wire_reset_portrait', { p_staff_id: staffId });

  if (error) {
    const message = String(error?.message || '');
    if (/wire_reset_portrait/.test(message)) {
      return {
        ok: false,
        message:
          'The newsroom server is missing the portrait reset function. Paste supabase/018_portrait_reset.sql into the Supabase SQL editor.'
      };
    }
    if (/only the Owner/.test(message)) {
      return { ok: false, message: 'Only the Owner can reset a portrait.' };
    }
    return { ok: false, message: describe(error, 'portrait reset') };
  }

  return { ok: true, message: 'Portrait cleared. They can submit a new one.' };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The Owner attaching a portrait to a staffer's row, e.g. at the moment they
 * hire them. Separate from `wire_submit_portrait`, which can only ever write the
 * caller's OWN row and so is useless from the Staff editor.
 *
 * Passing an empty string clears the portrait.
 * @param {string} staffId
 * @param {string} url
 */
export async function assignPortrait(staffId, url) {
  const client = getSupabase();
  if (!client) return { ok: false, message: 'Not connected to the newsroom server.' };

  const { error } = await client.rpc('wire_assign_portrait', {
    p_staff_id: staffId,
    p_url: String(url || '').trim()
  });

  if (error) {
    if (/wire_assign_portrait/.test(String(error?.message || ''))) {
      return {
        ok: false,
        message:
          'The newsroom server is missing the new portrait function. Re-run supabase/005_portraits_and_credits.sql in the Supabase SQL editor.'
      };
    }
    if (/only the Owner/.test(String(error?.message || ''))) {
      return { ok: false, message: 'Only the Owner can attach a portrait to another record.' };
    }
    return { ok: false, message: describe(error, 'portrait') };
  }

  return {
    ok: true,
    message: url
      ? 'Portrait saved and approved. It will appear with this writer’s bylines.'
      : 'Portrait cleared.'
  };
}

const DEMO_KEY = 'wire.credits.demo.v1';

/**
 * Read the demo roster out of localStorage, seeding it on first run.
 *
 * WHY THIS IS A STORE AND NOT A CONSTANT
 * `demoRoster()` used to return a hardcoded array. `addPerson()` returned a
 * fabricated object without ever storing it, so the next read rebuilt the same
 * four names and every edit made in demo mode vanished on refresh. The Owner
 * could not try the editor at all.
 *
 * Same contract as the Postgres path: read returns the list, writes persist,
 * and a corrupt payload falls back to the seed rather than throwing.
 *
 * THE SEED IS SCOPED, and it is seeded so BOTH pages have something to show:
 * three About Us entries across the two rosters, and two Credits entries that
 * exist only on the Credits page. Before `page_scope` existed every seed row
 * carried an About category, so `/credits` rendered empty in demo mode — which
 * looks exactly like the page being broken.
 *
 * @returns {Array<object>}
 */
export function demoRoster() {
  const fallback = [
    {
      id: 'demo-owner',
      name: 'The Owner',
      role_label: 'Owner',
      role_color: '#8c1d11',
      blurb: 'Sets the line, and answers for it.',
      portrait_url: null,
      sort_order: 1,
      about_order: 1,
      page_scope: 'about_us',
      category: 'Board Members'
    },
    {
      id: 'demo-1',
      name: 'Amara K.',
      role_label: 'Senior Reporter',
      role_color: '#1d4ed8',
      blurb: 'Covers local government and civic affairs.',
      portrait_url: null,
      sort_order: 10,
      about_order: 10,
      page_scope: 'about_us',
      category: 'Behind the Bylines'
    },
    {
      id: 'demo-2',
      name: 'Brian O.',
      role_label: 'Sports Correspondent',
      role_color: '#047857',
      blurb: 'Football, athletics, and the people who fund them.',
      portrait_url: null,
      sort_order: 20,
      about_order: 20,
      page_scope: 'about_us',
      category: 'Behind the Bylines'
    },
    {
      // Credits page only. No category, which credits_people_scope_category_check
      // now REQUIRES for a credits row — the seed has to obey the constraint the
      // migration adds, or demo mode would teach the Owner a shape the database
      // refuses.
      id: 'demo-3',
      name: 'Lilian W.',
      role_label: 'Photo Editor',
      role_color: '#b45309',
      blurb: 'Runs the picture desk and the gallery.',
      portrait_url: null,
      sort_order: 30,
      about_order: 30,
      page_scope: 'credits',
      category: null
    },
    {
      id: 'demo-4',
      name: 'School Athletic Association',
      role_label: 'Special Thanks',
      role_color: '#6d28d9',
      blurb: 'Scorekeeping, fixtures and the scoreboard.',
      portrait_url: null,
      sort_order: 40,
      about_order: 40,
      page_scope: 'credits',
      category: null
    }
  ];

  let rows;
  try {
    const raw = window.localStorage.getItem(DEMO_KEY);
    rows = raw ? JSON.parse(raw) : fallback;
  } catch {
    rows = fallback;
  }

  if (!Array.isArray(rows)) rows = fallback;

  /*
   * SEED MIGRATION. A roster saved by an older build has no `page_scope`, and
   * `normaliseScope('')` returns 'credits' — so every pre-existing demo row
   * would silently jump from the About page to the Credits page on the first
   * load after this change. Re-derive it from `category` instead, which is the
   * rule migration 028 used for real rows, so a demo roster saved before the
   * upgrade keeps the people where the Owner last saw them.
   *
   * Written back on the spot, so the repair happens once rather than on every
   * read.
   */
  let repaired = false;
  for (const row of rows) {
    if (row.page_scope === undefined || row.page_scope === null || row.page_scope === '') {
      row.page_scope = normaliseAboutCategory(row.category) ? 'about_us' : 'credits';
      repaired = true;
    }
    // Same invariant as the CHECK constraint: a credits row carries no category.
    if (row.page_scope === 'credits' && row.category) {
      row.category = null;
      repaired = true;
    }
  }
  if (repaired) {
    try {
      window.localStorage.setItem(DEMO_KEY, JSON.stringify(rows));
    } catch {
      /* private mode / quota: the repair still applies to this page view */
    }
  }

  return [...rows].sort(
    (a, b) =>
      (a.sort_order ?? 100) - (b.sort_order ?? 100) || String(a.name).localeCompare(String(b.name))
  );
}

/** @param {Array<object>} rows */
function writeDemoRoster(rows) {
  try {
    window.localStorage.setItem(DEMO_KEY, JSON.stringify(rows));
  } catch {
    /* private mode / quota: the edit still applies to this page view */
  }
}

/**
 * Highest value in use for one order column, so a new entry lands last.
 *
 * Takes the column name because the two pages order independently: seeding both
 * `sort_order` and `about_order` from a single running maximum would make adding
 * somebody to the Credits page renumber the About page.
 *
 * @param {Array<object>} rows
 * @param {'sort_order'|'about_order'} column
 */
function nextDemoOrder(rows, column) {
  return rows.reduce((max, row) => Math.max(max, Number(row[column]) || 0), 0) + 10;
}

/* -------------------------------------------------------------------------- */
/* Byline portraits                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Approved portraits from BOTH pages, keyed by normalised name.
 *
 * This is the roster of people the Owner hand-picked for the public pages, both
 * of them. It legitimately includes contributors who have no staff profile and
 * no account at all, which is why it stays -- but it is the LOWER-precedence of
 * the two name sources (see `staffPortraitByName` below).
 */
let portraitIndex = new Map();

/**
 * Approved portraits from the STAFF roster, keyed by name.
 *
 * THIS IS THE AUTHORITY, and the byline NAME is the only key that gets here.
 *
 * WHY THERE IS NO FOREIGN-KEY LOOKUP
 * ----------------------------------
 * There was one. `portraitForArticle()` used to resolve `articles.author_account_id`
 * against `staff_accounts.id` and treat that as the author, falling back to the
 * byline text. That premise is wrong, and it is wrong in a way that is visible on
 * the front page.
 *
 * Migration 007 defines the column as "the account the author SIGNS IN WITH", and
 * its own column comment says "NULL means ownership unknown; only the Owner may
 * delete that row". It is a PERMISSIONS pointer -- who may edit and delete the row
 * -- not a statement of who wrote it. The Owner publishing a piece bylined to
 * somebody else is ordinary editorial practice, and it is the normal case for a
 * one-desk paper: the Owner holds the login, the story is credited to a reporter.
 *
 * So the FK-first lookup printed the wrong face next to a real byline. Three
 * articles bylined "Mercy Kamande" resolved to Mercy's profile because they
 * pointed at her account; a fourth, posted by the Owner, resolved to the OWNER's
 * profile because it pointed there -- same byline, two different faces, which is
 * exactly the inconsistency that started this.
 *
 * A byline is a credit. It identifies the person a reader should see, and it is
 * carried as text on the article itself. That text is the key.
 *
 * The Credits roster below is the fallback for people with no staff profile --
 * outside contributors, who by definition have no account and no row in `staff`.
 */
let staffPortraitByName = new Map();

/** Reduce a name to its comparable form. */
function normaliseName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

/**
 * A byline that writes only a surname ("Wanjiku") must still find "Grace
 * Wanjiku" on the roster, and a byline carrying a title ("Photo: Lilian W.")
 * must not be treated as a different person. So a full-name match is tried
 * first, then initials ("G. Wanjiku" / "GW"), then the trailing surname alone.
 *
 * The first candidate that resolves wins, so a full match always beats a loose
 * one and a loose match can never shadow a precise one.
 */
function candidateKeys(name) {
  const raw = String(name || '')
    // Drop honorifics and job labels that appear in bylines but not on the roster.
    .replace(/^\s*(photo|photo:|by|words|words:|story)\s*[:\-]?\s*/i, '')
    .trim();

  const cleaned = normaliseName(raw);
  if (!cleaned) return [];

  const keys = [cleaned];

  // "Grace Wanjiku" -> also try initials+surname, e.g. "gwanjiku", and the
  // inverted "Wanjiku, Grace" form used by some desks and export tools.
  const parts = raw
    .replace(/[^A-Za-z\s'-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length >= 2) {
    keys.push(normaliseName([...parts].reverse().join(' ')));
    const first = normaliseName(parts[0]).charAt(0);
    const last = normaliseName(parts[parts.length - 1]);
    if (first && last) keys.push(`${first}${last}`);
    keys.push(normaliseName(parts[parts.length - 1]));
  }

  // Drop any middle name/initial so "Grace Wanjiku" and "Grace W. Wanjiku"
  // collapse to the same key.
  if (parts.length >= 3) {
    const first = normaliseName(parts[0]).charAt(0);
    const last = normaliseName(parts[parts.length - 1]);
    if (first && last) keys.push(`${first}${last}`);
  }

  return [...new Set(keys.filter(Boolean))];
}

/**
 * Cache the approved portraits so a byline can be rendered synchronously.
 * Called once per roster load; safe to call repeatedly.
 *
 * ROW ORDER IS PART OF THE CONTRACT
 * ---------------------------------
 * A person can now hold TWO rows -- one on About Us, one on Credits -- because
 * `page_scope` gives a row exactly one page. If those two rows carry DIFFERENT
 * photographs, only one can win for the byline, and "first one wins" would make
 * the face depend on the order the database happened to return rows in. So the
 * winner is chosen on purpose instead:
 *
 *   1. `listAllPeople()` sorts `page_scope` ascending, so 'about_us' rows are
 *      handed over first. That is the deterministic input this function relies
 *      on, and the reason the sort is there.
 *   2. Within a name, the FIRST row with a usable portrait keeps the key. Since
 *      About rows come first, an About Us portrait wins over a Credits one.
 *
 * The About page is the better default for this specific reason: its entries are
 * the ones the Owner curates as the paper's identity (board, bylines), whereas
 * the Credits page is the longer tail of one-off contributions.
 *
 * @param {Array<{name: string, portrait_url: string|null}>} people
 */
export function indexPortraits(people) {
  const next = new Map();
  for (const person of people || []) {
    // Index every alias (full name, initials+surname, surname) so a byline can
    // resolve however the desk chose to write it.
    for (const key of candidateKeys(person.name)) {
      const url = safeUrl(person.portrait_url);
      if (key && url && !next.has(key)) next.set(key, url);
    }
  }
  portraitIndex = next;
}

/**
 * The approved portrait for a byline name, or null.
 *
 * The staff roster is consulted before the Credits roster, and the two are
 * deliberately NOT merged into one map: merging would make the answer depend on
 * which page happened to load last, which is how one author came to show two
 * different faces. `staffPortraitByName` wins outright; `portraitIndex` is only
 * reached for a name no staff profile claims.
 *
 * The name is the only key. See the note on `staffPortraitByName` for why the
 * article's `author_account_id` is not consulted here: it points at whoever
 * operated the CMS, which is frequently not the person in the byline.
 */
export function portraitFor(name) {
  for (const key of candidateKeys(name)) {
    const onStaff = staffPortraitByName.get(key);
    if (onStaff) return onStaff;
  }
  for (const key of candidateKeys(name)) {
    const onCredits = portraitIndex.get(key);
    if (onCredits) return onCredits;
  }
  return null;
}

/**
 * The approved portrait for an article -- resolved from its BYLINE.
 *
 * @param {{author?: string}} article
 * @returns {string|null}
 */
export function portraitForArticle(article) {
  return portraitFor(article?.author);
}

/**
 * Rebuild the name-keyed staff index.
 *
 * `indexPortraits` is called from two places with two different shapes:
 * `listCredits()` returns `credits_people` rows, while the Staff tab returns
 * `staff` rows that carry a review state this one requires. So they are two
 * separate indexes rather than one -- see `staffPortraitByName` for which of the
 * two wins.
 *
 * @param {Array<{name?: string, portrait_url?: string,
 *                 portrait_status?: string}>} people
 */
export function indexStaffPortraits(people) {
  const byName = new Map();
  // How many distinct people claim each key. Anything above one is ambiguous.
  const claims = new Map();

  for (const person of people || []) {
    if (String(person.portrait_status || '').toLowerCase() !== 'approved') continue;
    const url = safeUrl(person.portrait_url);
    if (!url) continue;

    // The person's own name, so the claim count is per human rather than per
    // alias: two rows for the same staffer must not make their own name look
    // ambiguous.
    const owner = String(person.name || url);
    for (const key of candidateKeys(person.name)) {
      if (!key) continue;
      const seen = claims.get(key);
      if (seen === undefined) claims.set(key, owner);
      else if (seen !== owner) claims.set(key, false); // ambiguous from here on
      if (!byName.has(key)) byName.set(key, url);
    }
  }

  for (const [key, owner] of claims) {
    if (owner === false) byName.delete(key);
  }

  staffPortraitByName = byName;
}

/**
 * Populate the portrait cache from the public rosters.
 *
 * READS BOTH SCOPES, and that is load-bearing. Scoping this to the Credits page
 * would be the obvious tidy-up after migration 028, and it would strip the face
 * off every byline belonging to a reporter the Owner listed on the About page
 * instead — a regression on the front page, caused by a change to a page nobody
 * was looking at, which is the worst shape a regression takes. `listAllPeople()`
 * is unscoped for exactly this reason.
 *
 * This MUST run before the first paint of the publication. Bylines are rendered
 * synchronously by `bylineSticker`, so if the cache is still empty the article
 * cards are built with the plain-text fallback and the stickers never appear —
 * visiting either roster page later would not retroactively fix them.
 *
 * Safe to call repeatedly; resolves quietly when migration 005 is not applied.
 * @returns {Promise<number>} how many portraits are now cached
 */
export async function primePortraits() {
  const people = await listAllPeople();
  indexPortraits(people);
  // Count people, not index keys — the index holds several aliases per person.
  return people.filter((p) => safeUrl(p.portrait_url)).length;
}

/**
 * Render a story byline with the author's approved portrait as a sticker.
 *
 * Falls back to the plain text byline when the author has no approved portrait,
 * which is always the case until the Owner approves one — so the front page
 * never breaks and never leaks an unreviewed photo.
 *
 * `portrait` overrides the name lookup, for a caller that has already resolved a
 * portrait by some other means. Nothing in the publication does: a byline is
 * credited by NAME, and the article's `author_account_id` is deliberately not
 * used to pick a face -- it records who operated the CMS, which for a
 * single-desk paper is usually the Owner rather than the person in the byline.
 * See the note on `staffPortraitByName`.
 *
 * @param {string} name
 * @param {{tag?: string, cls?: string, suffix?: string, portrait?: string|null}} [opts]
 */
export function bylineSticker(name, { tag = 'p', cls = '', suffix = '', portrait } = {}) {
  const face = safeUrl(portrait) || portraitFor(name);
  const label = escapeHtml(name || 'The Pulse staff');
  const tail = suffix ? escapeHtml(suffix) : '';

  if (!face) {
    return `<${tag} class="${cls}">By ${label}${tail}</${tag}>`;
  }

  return `
    <${tag} class="byline-sticker-row ${cls}">
      <img
        class="byline-sticker"
        src="${escapeHtml(face)}"
        ${imageFallbackAttr()}
        alt=""
        width="128"
        height="128"
        loading="lazy"
        decoding="async"
      />
      <span class="byline-sticker-name">By ${label}</span>
      ${tail}
    </${tag}>
  `;
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Render the credits page into `mount`.
 * @param {HTMLElement} mount
 */
export function renderCredits(mount) {
  if (!mount) return;

  listCredits().then((people) => {
    // Guard against a re-render racing an earlier one.
    if (!mount.isConnected) return;
    // Keep the byline stickers in step with whoever is on the roster.
    indexPortraits(people);
    mount.innerHTML = people.length ? template(people) : emptyState();
  });
}

function emptyState() {
  return `
    <div class="mx-auto max-w-2xl text-center">
      <h1 class="font-headline text-3xl font-bold tracking-[0.06em] uppercase">Credits</h1>
      <p class="rule-soft mt-3 text-sm ink-muted">
        The people behind The Pulse are being assembled. Please check back shortly.
      </p>
    </div>
  `;
}

function template(people) {
  const groups = groupByRole(people);

  return `
    <div class="mx-auto max-w-4xl">
      <header class="mb-8 text-center">
        <p class="eyebrow">About the newsroom</p>
        <h1 class="font-headline text-3xl font-bold tracking-[0.06em] uppercase sm:text-4xl">Credits</h1>
        <p class="rule-soft mx-auto mt-3 max-w-2xl text-sm ink-muted">
          ${people.length} ${people.length === 1 ? 'person makes' : 'people make'} The Pulse.
        </p>
      </header>

      ${groups
        .map(
          (group) => `
        <section class="credits-band" style="--band:${bandColour(group)}">
          <h2 class="credits-band__head">
            <span class="credits-band__rail" aria-hidden="true"></span>
            <span class="credits-band__name">${escapeHtml(group.role)}</span>
            <span class="credits-band__count">${group.members.length}</span>
          </h2>
          <ul class="credits-band__grid credits-grid">
            ${group.members.map(card).join('')}
          </ul>
        </section>`
        )
        .join('')}
    </div>
  `;
}

/**
 * The colour a role band is drawn in: the first member's own role colour, so the
 * band and its members can never disagree.
 *
 * Falls back to the site red only when nobody in the band set one, which is why
 * this is looked up rather than read off the group object.
 */
function bandColour(group) {
  for (const member of group.members) {
    const colour = normaliseColour(member.role_color);
    if (colour) return colour;
  }
  return '#c8102e';
}

/**
 * Bucket people by their role label so two or more people who share a role sit
 * under one heading rather than repeating the same chip on every card.
 *
 * Order follows first appearance, which keeps the Owner first (the roster is
 * ordered by role already) instead of sorting alphabetically and burying the
 * most senior person under "Board Manager".
 *
 * @param {Array<object>} people
 * @returns {Array<{role: string, members: Array<object>}>}
 */
export function groupByRole(people) {
  const order = [];
  const buckets = new Map();

  for (const person of people) {
    // An unlabelled person is a real state, not an error: the Owner's role is
    // stored on the account, not the credits row. Give it a stable name so those
    // people still group together instead of each getting their own heading.
    const role = String(person.role_label || '').trim() || 'Contributor';

    if (!buckets.has(role)) {
      buckets.set(role, []);
      order.push(role);
    }
    buckets.get(role).push(person);
  }

  return order.map((role) => ({ role, members: buckets.get(role) }));
}

/**
 * Persist a whole new display order by handing the server the complete id list
 * in reading order.
 *
 * There is no "move this one up" RPC and there never was. The server owns
 * `sort_order` and rewrites it from the array position, so a single-step move
 * would still need every row sent. Sending the full list is idempotent and
 * cannot half-apply, which is why reordering a ROLE band (which is several
 * people at once) needs nothing new on the database.
 *
 * @param {string[]} ids  every credits id, in the order they should display
 * @returns {Promise<{ok: boolean, message: string, count?: number}>}
 */
export async function reorderPeople(ids) {
  const list = Array.isArray(ids) ? ids.filter(Boolean) : [];
  if (list.length < 2) return { ok: false, message: 'Nothing to reorder.' };

  if (config.demoMode) {
    const rows = demoRoster();
    const byId_ = new Map(rows.map((row) => [row.id, row]));
    let touched = 0;
    const next = list.map((id, index) => {
      const row = byId_.get(id);
      if (!row) return null;
      touched += 1;
      return { ...row, sort_order: (index + 1) * 10 };
    }).filter(Boolean);

    // Anything the caller did not mention keeps its relative order at the end,
    // so a stale list can never silently drop a person off the page.
    for (const row of rows) {
      if (!list.includes(row.id)) next.push({ ...row, sort_order: (next.length + 1) * 10 });
    }

    writeDemoRoster(next);
    return { ok: true, message: 'Order saved.', count: touched };
  }

  const client = getSupabase();
  if (!client) return { ok: false, message: 'Not connected to the newsroom server.' };

  const { data, error } = await client.rpc('wire_credits_people_reorder', { p_ids: list });
  if (error) return { ok: false, message: describe(error, 'credits order') };
  return { ok: true, message: 'Order saved.', count: Number(data) || list.length };
}

/**
 * Move a whole role band one place up or down the Credits page.
 *
 * This is what makes the page behave like a Discord role list: the Owner is not
 * ordering 40 people, they are ordering departments. Everyone holding the role
 * moves together, and nobody inside the band changes place relative to the
 * others.
 *
 * @param {Array<object>} people  the full roster, as the page sees it
 * @param {string} role           the role label to move
 * @param {-1|1} direction        -1 up, +1 down
 * @returns {Promise<{ok: boolean, message: string}>}
 */
export async function moveRoleBand(people, role, direction) {
  const bands = groupByRole(people);
  const from = bands.findIndex((band) => band.role === role);
  const to = from + (direction < 0 ? -1 : 1);

  if (from === -1) return { ok: false, message: 'That role is no longer on the page.' };
  if (to < 0 || to >= bands.length) {
    return { ok: false, message: `"${role}" is already ${direction < 0 ? 'at the top' : 'at the bottom'}.` };
  }

  // Swap the two adjacent bands, then flatten back to one ordered id list.
  [bands[from], bands[to]] = [bands[to], bands[from]];

  const result = await reorderPeople(bands.flatMap((band) => band.members.map((m) => m.id)));
  return result.ok ? { ok: true, message: `"${role}" moved ${direction < 0 ? 'up' : 'down'}.` } : result;
}

/**
 * Normalise an Owner-supplied colour to `#rrggbb`, or null when it is not one.
 *
 * The value reaches an inline `style` attribute, so it has to be validated
 * rather than escaped. Strict by design: six hex digits and nothing else. A role
 * colour is a choice, not a document, so there is nothing to gain from accepting
 * rgb()/hsl()/named colours and a lot to lose from accepting arbitrary CSS.
 *
 * @param {unknown} value
 * @returns {string|null} e.g. "#1d4ed8"
 */
export function normaliseColour(value) {
  const raw = String(value ?? '').trim();
  const hex = raw.startsWith('#') ? raw.slice(1) : raw;
  if (/^[0-9a-f]{6}$/i.test(hex)) return `#${hex.toLowerCase()}`;
  if (/^[0-9a-f]{3}$/i.test(hex)) {
    // Expand #abc into #aabbcc so downstream only ever sees six digits.
    return `#${hex
      .toLowerCase()
      .split('')
      .map((c) => c + c)
      .join('')}`;
  }
  return null;
}

/**
 * A legible text colour for a role chip, given its background.
 *
 * A role colour is free and the Owner may pick black or white, so the label
 * cannot always be light. Relative luminance decides it (WCAG 2.1), because a
 * contrast checker would be overkill for a badge and this is the whole rule.
 *
 * @param {string} hex `#rrggbb`
 * @returns {string} `#ffffff` or `#111111`
 */
export function readableOn(hex) {
  const clean = normaliseColour(hex);
  if (!clean) return '#ffffff';
  const [r, g, b] = [1, 3, 5].map((i) => {
    const channel = parseInt(clean.slice(i, i + 2), 16) / 255;
    return channel <= 0.03928
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });
  // 0.179 is the crossover point between the two contrast ratios on white/black.
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.179 ? '#111111' : '#ffffff';
}

/* -------------------------------------------------------------------------- */
/* Role pills -- the Owner colour, used as a wash instead of a slab            */
/* -------------------------------------------------------------------------- */

/**
 * THE CARD SURFACES A PILL IS READ AGAINST.
 *
 * Both are real: the site ships a light and a dark theme, so a pill has to clear
 * 4.5:1 on EITHER. Hardcoding one of these is not a simplification, it is a
 * bug that only appears in the theme you happened to be looking at while
 * developing -- the first version of this file did exactly that, lightened every
 * accent against the dark surface, and shipped pills at 1.79:1 in light mode.
 *
 * Mirrors --surface-card in src/styles.css.
 */
const CARD_SURFACES = {
  light: '#faf8f5',
  dark: '#18181b'
};

/** WCAG relative luminance of a `#rrggbb`. @param {string} hex */
function luminance(hex) {
  const clean = normaliseColour(hex) || '#000000';
  const [r, g, b] = [1, 3, 5].map((i) => {
    const channel = parseInt(clean.slice(i, i + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Contrast ratio between two colours, WCAG 2.1 form.
 * @returns {number} 1 (identical) to 21 (black on white)
 */
export function contrastRatio(foreground, background) {
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** Linear blend of two `#rrggbb` values. @param {number} amount 0..1 */
function blend(hex, toward, amount) {
  const from = normaliseColour(hex) || '#000000';
  const to = normaliseColour(toward) || '#ffffff';
  const channel = (i) => {
    const a = parseInt(from.slice(i, i + 2), 16);
    const b = parseInt(to.slice(i, i + 2), 16);
    return Math.round(a + (b - a) * amount)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${channel(1)}${channel(3)}${channel(5)}`;
}

/**
 * Nudge a colour toward black or white until it clears a contrast target against
 * a surface.
 *
 * The direction is chosen by which side of the surface we start on, so a
 * near-white accent is darkened for a light card rather than being lightened
 * into invisibility -- which is what a fixed "lighten until it passes" loop does
 * to a colour that is already on the wrong side.
 *
 * @param {string} hex      the Owner's colour
 * @param {string} surface  what it sits on
 * @param {number} target   minimum ratio, 1..21
 * @returns {string} an adjusted `#rrggbb`
 */
function ensureContrast(hex, surface, target) {
  let out = normaliseColour(hex) || '#000000';
  // Toward black on a light surface, toward white on a dark one. Twelve steps of
  // 12% is more than enough to reach an endpoint from anywhere, and the bound
  // keeps a degenerate value from looping.
  const toward = luminance(surface) > 0.5 ? '#000000' : '#ffffff';
  for (let step = 0; step < 12 && contrastRatio(out, surface) < target; step += 1) {
    out = blend(out, toward, 0.12);
  }
  return out;
}

/**
 * The CSS values a role pill needs, derived from one Owner-chosen hex.
 *
 * WHY THIS IS NOT JUST `rgba(${hex}, 0.12)`
 * -----------------------------------------
 * Translating the hex to rgba is the easy half, and on its own it produces an
 * unreadable result. The Owner picks from a colour wheel with no contrast
 * guidance, and roughly a third of the spectrum is too dark to read as text on
 * a card: #1d4ed8 is 2.1:1 on #18181b, #7c2d12 is 1.9:1, #b45309 is 3.4:1. The
 * badge would pass a visual review and fail every reader with low vision.
 *
 * So TWO accents are computed — one for each theme — and CSS picks between them:
 *
 *   accentLight  darkened until it clears 4.5:1 on the light card
 *   accentDark   lightened until it clears 4.5:1 on the dark card
 *
 * Both are emitted, and `.dark .role-pill` selects the second. Doing this in JS
 * for a single surface would break whichever theme it was not tuned for, and
 * doing it in CSS is not possible: contrast depends on the colour VALUES, which
 * only JS knows.
 *
 * 4.5:1 is WCAG AA for text below 18.66px, which is what a 12px uppercase pill
 * is. The wash and the border keep the ORIGINAL saturation, because those are
 * decoration and a washed-out tint would not identify the role.
 *
 * @param {unknown} value  an Owner-supplied hex, in any accepted spelling
 * @returns {{accentLight: string, accentDark: string, wash: string, edge: string,
 *           solid: string}|null}
 *   null when `value` is not a hex at all, so the caller can fall back to CSS
 */
export function rolePalette(value) {
  const clean = normaliseColour(value);
  if (!clean) return null;

  const [r, g, b] = [1, 3, 5].map((i) => parseInt(clean.slice(i, i + 2), 16));

  return {
    accentLight: ensureContrast(clean, CARD_SURFACES.light, 4.5),
    accentDark: ensureContrast(clean, CARD_SURFACES.dark, 4.5),
    // 12% and 28% are the values the design calls for. The wash is deliberately
    // weak: it is a tint behind 12px text, and anything stronger reintroduces
    // the slab this replaced.
    wash: `rgba(${r}, ${g}, ${b}, 0.12)`,
    edge: `rgba(${r}, ${g}, ${b}, 0.28)`,
    // The fully saturated original, for the 3px rail on a card edge and for the
    // swatch in the Owner panel's colour picker.
    solid: clean
  };
}

/**
 * A role palette as an escaped inline `style` attribute.
 *
 * EVERY value here is derived by `rolePalette()` from a hex that has already
 * been through `normaliseColour()`, so none of it can contain a quote or a
 * semicolon of its own accord -- but it is escaped anyway, because the next
 * person to edit `rolePalette()` should not have to know that.
 *
 * @param {ReturnType<typeof rolePalette>} palette
 * @returns {string} ` style="--role-accent-light:…;…"`
 */
export function paletteVars(palette) {
  if (!palette) return '';
  const v = (name, value) => `${name}:${escapeHtml(value)};`;
  return ` style="${v('--role-accent-light', palette.accentLight)}${v(
    '--role-accent-dark',
    palette.accentDark
  )}${v('--role-wash', palette.wash)}${v('--role-edge', palette.edge)}${v(
    '--role-solid',
    palette.solid
  )}"`;
}

/**
 * One card in a Credits role band.
 *
 * NO ROLE BADGE HERE, and that is deliberate rather than an omission: the band
 * heading immediately above already names the role and carries its colour, so a
 * pill on every card said the same thing forty times. The band IS the badge.
 * (The About page is the opposite shape — one section, many roles — so its cards
 * each carry their own pill.)
 *
 * Everything else matches the About card: the same dark surface, the same square
 * 72px avatar, the same muted italic note, so a reader moving between the two
 * pages does not feel the design change underneath them.
 */
function card(person) {
  const portrait = safeUrl(person.portrait_url);

  return `
    <li class="credits-card">
      ${
        portrait
          ? `<img
              class="credits-card__avatar"
              src="${escapeHtml(portrait)}"
              ${imageFallbackAttr()}
              alt=""
              width="72"
              height="72"
              loading="lazy"
              decoding="async"
            />`
          : `<span class="credits-card__avatar credits-card__avatar--empty" aria-hidden="true">
               <i class="fa-solid fa-user"></i>
             </span>`
      }
      <div class="credits-card__body">
        <p class="credits-card__name">${escapeHtml(person.name || 'Staff member')}</p>
        ${
          person.blurb
            ? `<p class="credits-card__blurb">${escapeHtml(person.blurb)}</p>`
            : ''
        }
      </div>
    </li>
  `;
}
