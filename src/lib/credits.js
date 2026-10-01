/* =============================================================================
   src/lib/credits.js — THE CREDITS ROSTER
   -----------------------------------------------------------------------------
   The public "Credits" page: who works on The Wire, in the order the Owner chose,
   with their role, their blurb and their approved portrait.

   The roster is read from the `credits_roster` view rather than the `staff`
   table. That matters for two reasons:

     * `staff` holds e-mail and shadow addresses. Readers must never see a column
       they do not need, so the view exposes name, role, blurb, portrait and
       ordering — nothing else.
     * The view only returns rows the Owner has both listed AND whose portrait
       the Owner has approved, so an unreviewed selfie cannot leak by being
       referenced from a public page.

   Everything the Owner controls (visibility, blurb, order, permissions) is
   written through SECURITY DEFINER functions in migration 005, never by a
   direct client-side update.
   ========================================================================== */

import { getSupabase } from './supabase.js';
import { config } from './config.js';
import { escapeHtml, safeUrl } from './dom.js';

const VIEW = 'credits_roster';

/**
 * Set when the last roster read failed because the credits columns do not exist
 * yet. Migration 005 has to be run in the Supabase SQL Editor before any of this
 * can work, and an empty tab gives the Owner no way to tell that apart from
 * "nobody is on the roster". The flag lets the UI say which it is.
 */
let migrationMissing = false;

/** @returns {boolean} true when `credits_roster` / the credits columns are absent. */
export function isCreditsMigrationMissing() {
  return migrationMissing;
}

/**
 * The published roster, in the Owner's chosen order.
 * @returns {Promise<Array<object>>} empty array when the view is missing
 */
export async function listCredits() {
  if (config.demoMode) return demoRoster();

  const client = getSupabase();
  if (!client) return [];

  const { data, error } = await client
    .from(VIEW)
    .select('id, name, role, portrait_url, credits_blurb, credits_order')
    .order('credits_order', { ascending: true })
    .order('name', { ascending: true });

  if (error) {
    // Migration 005 not applied yet. An empty credits page is a far better
    // failure than a page of console noise for a reader.
    migrationMissing = isMissingSchema(error);
    console.warn('[credits] could not load the roster', error);
    return [];
  }
  migrationMissing = false;
  return data || [];
}

/**
 * PostgREST reports an absent table and an absent column as the same
 * "schema cache" error, which is also what a transient network blip looks like.
 * Only the explicit cache/column wording counts as "migration not run".
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

/* -------------------------------------------------------------------------- */
/* Owner actions                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Every staff member, with the credits fields, for the Owner's editing tab.
 *
 * This deliberately reads the `staff` table rather than `credits_roster`:
 * the view filters to listed-and-approved rows, which is exactly what an
 * editor must not see (it would hide the people they still need to approve).
 * `staff` is readable by authenticated staff members under RLS.
 *
 * @returns {Promise<Array<object>>} empty array when unreadable
 */
export async function listRoster() {
  if (config.demoMode) return demoRoster();

  const client = getSupabase();
  if (!client) return [];

  const { data, error } = await client
    .from('staff')
    .select(
      'id, name, role, status, portrait_url, portrait_status, credits_visible, credits_blurb, credits_order, permissions'
    )
    .order('credits_order', { ascending: true })
    .order('name', { ascending: true });

  if (error) {
    migrationMissing = isMissingSchema(error);
    console.warn('[credits] could not load the staff roster', error);
    return [];
  }
  migrationMissing = false;
  return data || [];
}


/**
 * Approve or reject a submitted portrait.
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
 * Update one row of the credits roster.
 * @param {string} staffId
 * @param {{visible: boolean, blurb: string, order: number, permissions: object}} patch
 */
export async function setCredits(staffId, patch) {
  const client = getSupabase();
  if (!client) return { ok: false, message: 'Not connected to the newsroom server.' };

  const { error } = await client.rpc('wire_set_credits', {
    p_staff_id: staffId,
    p_visible: patch.visible,
    p_blurb: patch.blurb,
    p_order: patch.order,
    p_permissions: patch.permissions || {}
  });

  if (error) return { ok: false, message: describe(error, 'credits entry') };
  return { ok: true, message: 'Credits entry saved.' };
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

/** Turn a Postgres error into something a newsroom owner can act on. */
function describe(error, what) {
  const text = error?.message || '';
  if (error?.code === '42883' || /wire_set_(portrait_status|credits)/.test(text)) {
    return 'The newsroom server is missing the credits tables. Run supabase/005_portraits_and_credits.sql in the Supabase SQL editor.';
  }
  if (/not on the staff roster/.test(text)) {
    return 'Only someone on the staff roster can do that.';
  }
  return `Could not save the ${what}: ${text || 'unknown error'}`;
}

/**
 * Demo roster, so the credits page is never empty while previewing offline.
 * Mirrors the seed's staff so the page looks believable in demo mode.
 */
export function demoRoster() {
  return [
    {
      id: 'demo-owner',
      name: 'The Owner',
      role: 'Owner',
      portrait_url: null,
      credits_blurb: 'Editor-in-chief. Sets the line, and answers for it.',
      credits_order: 1
    },
    {
      id: 'demo-1',
      name: 'Amara K.',
      role: 'Senior Reporter',
      portrait_url: null,
      credits_blurb: 'Covers local government and civic affairs.',
      credits_order: 10
    },
    {
      id: 'demo-2',
      name: 'Brian O.',
      role: 'Sports Correspondent',
      portrait_url: null,
      credits_blurb: 'Football, athletics, and the people who fund them.',
      credits_order: 20
    },
    {
      id: 'demo-3',
      name: 'Lilian W.',
      role: 'Photo Editor',
      portrait_url: null,
      credits_blurb: 'Runs the picture desk and the gallery.',
      credits_order: 30
    }
  ];
}

/* -------------------------------------------------------------------------- */
/* Byline portraits                                                            */
/* -------------------------------------------------------------------------- */

/**
 * name -> approved portrait, for the sticker bylines under each story.
 *
 * Articles record their author as a free-text name, not a foreign key, so the
 * match is by name. It is deliberately forgiving — case, punctuation and
 * surrounding whitespace are ignored — because "Amara K." on a story and
 * "amara k" on the roster must still resolve to the same person.
 */
let portraitIndex = new Map();

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
 * Called once per credits load; safe to call repeatedly.
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

/** The approved portrait for a byline name, or null. */
export function portraitFor(name) {
  for (const key of candidateKeys(name)) {
    const hit = portraitIndex.get(key);
    if (hit) return hit;
  }
  return null;
}

/**
 * Populate the portrait cache from the public roster.
 *
 * This MUST run before the first paint of the publication. Bylines are rendered
 * synchronously by `bylineSticker`, so if the cache is still empty the article
 * cards are built with the plain-text fallback and the stickers never appear —
 * visiting the Credits page later would not retroactively fix them.
 *
 * Safe to call repeatedly; resolves quietly when migration 005 is not applied.
 * @returns {Promise<number>} how many portraits are now cached
 */
export async function primePortraits() {
  const people = await listCredits();
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
 * @param {string} name
 * @param {{tag?: string, cls?: string, suffix?: string}} [opts]
 */
export function bylineSticker(name, { tag = 'p', cls = '', suffix = '' } = {}) {
  const portrait = portraitFor(name);
  const label = escapeHtml(name || 'The Wire staff');
  const tail = suffix ? escapeHtml(suffix) : '';

  if (!portrait) {
    return `<${tag} class="${cls}">By ${label}${tail}</${tag}>`;
  }

  return `
    <${tag} class="byline-sticker-row ${cls}">
      <img
        class="byline-sticker"
        src="${escapeHtml(portrait)}"
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
      <h1 class="font-headline text-3xl font-bold">Credits</h1>
      <p class="rule-soft mt-3 text-sm ink-muted">
        The people behind The Wire are being assembled. Please check back shortly.
      </p>
    </div>
  `;
}

function template(people) {
  const editors = people.filter((p) => p.role !== 'Owner').length;

  return `
    <div class="mx-auto max-w-4xl">
      <header class="mb-8 text-center">
        <p class="eyebrow">About the newsroom</p>
        <h1 class="font-headline text-3xl font-bold sm:text-4xl">Credits</h1>
        <p class="rule-soft mx-auto mt-3 max-w-2xl text-sm ink-muted">
          ${people.length} ${people.length === 1 ? 'person' : 'people'} make
          The Wire${editors ? `, ${editors} reporting and editing for it` : ''}.
        </p>
      </header>

      <ul class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        ${people.map(card).join('')}
      </ul>
    </div>
  `;
}

function card(person) {
  const portrait = safeUrl(person.portrait_url);

  return `
    <li class="panel-raised flex flex-col items-center p-5 text-center">
      ${
        portrait
          ? `<img
              class="byline-sticker byline-sticker-lg"
              src="${escapeHtml(portrait)}"
              alt=""
              width="512"
              height="512"
              loading="lazy"
              decoding="async"
            />`
          : `<span class="byline-sticker byline-sticker-lg byline-sticker-empty" aria-hidden="true">
               <i class="fa-solid fa-user"></i>
             </span>`
      }
      <h2 class="mt-3 font-headline text-lg font-bold">${escapeHtml(person.name || 'Staff member')}</h2>
      <p class="mt-0.5 text-[0.6875rem] font-bold tracking-[0.12em] uppercase text-[var(--color-newsred)]">
        ${escapeHtml(person.role || 'Contributor')}
      </p>
      ${
        person.credits_blurb
          ? `<p class="mt-2 text-sm ink-muted">${escapeHtml(person.credits_blurb)}</p>`
          : ''
      }
    </li>
  `;
}
