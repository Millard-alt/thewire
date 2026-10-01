/* =============================================================================
   src/lib/credits.js — THE CREDITS PAGE
   -----------------------------------------------------------------------------
   The public "Credits" page: only the people the Owner has chosen to list, in the
   order they chose, each with a role, a role colour and a photo.

   It reads the `credits_people` table (migration 009), NOT `staff`. That
   distinction is the whole point of the feature:

     * An account does not put you on the Credits page. The Owner does. Someone
       can be credited without ever signing in — a photographer, a designer, a
       patron — and someone with an account can be left off entirely.
     * `staff` holds e-mail and shadow addresses, so a page reading it would need
       a SECURITY DEFINER view purely to avoid leaking them. `credits_people`
       holds only what the page already shows.

   `role_label` is free text and `role_color` is a hex triplet, so the Owner can
   invent a role that does not exist anywhere else and give it its own colour.
   Two people sharing a role colour is normal, which is what "Copy role colour"
   is for.

   ONLY THE OWNER CAN WRITE. There is no insert/update/delete policy on the
   table — RLS denies by default — so every save goes through a SECURITY DEFINER
   function that calls `is_owner()` first. An anon key cannot change this page.
   ========================================================================== */

import { getSupabase } from './supabase.js';
import { config } from './config.js';
import { escapeHtml, safeUrl } from './dom.js';

/**
 * Set when a roster read failed because `credits_people` does not exist yet.
 * Migration 009 has to be run in the Supabase SQL Editor before any of this can
 * work, and an empty page gives the Owner no way to tell that apart from
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
    return 'The newsroom server is missing the credits page. Run supabase/009_credits_page.sql in the Supabase SQL editor.';
  }
  if (/only the Owner can change the Credits page/.test(text)) {
    return 'Only the Owner can change the Credits page.';
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

/**
 * Everyone the Owner has listed, in the Owner's chosen order.
 *
 * Rows come back snake_case because that is what the table stores. The public
 * renderer reads them as-is, and the byline portrait index needs `name` and
 * `portrait_url`, which kept their original column names.
 *
 * @returns {Promise<Array<object>>} empty array when the table is missing
 */
export async function listCredits() {
  if (config.demoMode) return demoRoster();

  const client = getSupabase();
  if (!client) return [];

  const { data, error } = await client
    .from('credits_people')
    .select('id, name, role_label, role_color, blurb, portrait_url, sort_order')
    .order('sort_order', { ascending: true })
    .order('name', { ascending: true });

  if (error) {
    // Migration 009 not applied yet. An empty credits page is a far better
    // failure for a reader than a wall of console noise.
    migrationMissing = isMissingSchema(error);
    console.warn('[credits] could not load the page', error);
    return [];
  }
  migrationMissing = false;
  return data || [];
}

/* -------------------------------------------------------------------------- */
/* Owner actions                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The full Credits page as the Owner sees it, for editing.
 *
 * Same table the public page reads, plus `sort_order` for reordering. There is
 * deliberately no second "roster" concept: if the Owner can see it here, it is
 * on the page, and if it is on the page, it is editable here.
 *
 * @returns {Promise<Array<object>>} empty array when unreadable
 */
export async function listCreditsForOwner() {
  return listCredits();
}

/**
 * Add someone to the Credits page.
 *
 * Note there is no `auth_user_id` and no account is created. That is the point:
 * the Credits page is a page about people, not about who can log in. A
 * photographer who has never opened the site belongs on it.
 *
 * @param {{name: string, role: string, color: string, blurb?: string,
 *          portraitUrl?: string}} person
 */
export async function addPerson(person) {
  const name = String(person.name || '').trim();
  if (!name) return { ok: false, message: 'Give this person a name.' };

  const role = String(person.role || '').trim() || 'Contributor';
  const color = String(person.color || '').trim() || '#1d4ed8';

  if (config.demoMode) {
    const rows = demoRoster();
    const entry = {
      id: `demo-${Date.now().toString(36)}`,
      name,
      role_label: role,
      role_color: color,
      blurb: String(person.blurb || '').trim(),
      portrait_url: String(person.portraitUrl || '').trim() || null,
      sort_order: nextDemoOrder(rows)
    };
    writeDemoRoster([...rows, entry]);
    return { ok: true, person: entry };
  }

  const client = getSupabase();
  if (!client) return { ok: false, message: 'Not connected to the newsroom server.' };

  // RPC NAME AND ARG NAMES MUST MATCH supabase/009_credits_page.sql.
  //
  // There is no wire_add_credits_person. The server exposes a single upsert,
  // wire_credits_people_upsert, where p_id = NULL means INSERT and p_id = the
  // uuid means UPDATE. Calling the three separate names that no longer exist
  // returned PGRST202 "Could not find the function" for every add, save and
  // remove, which is why the whole Credits tab was dead. The portrait argument
  // is p_portrait, not p_portrait_url.
  const { data, error } = await client.rpc('wire_credits_people_upsert', {
    p_id: null,
    p_name: name,
    p_role_label: role,
    p_role_color: color,
    p_blurb: String(person.blurb || '').trim(),
    p_portrait: String(person.portraitUrl || '').trim(),
    p_sort_order: 100
  });

  if (error) return { ok: false, message: describe(error, 'credits entry') };
  return { ok: true, person: data };
}

/**
 * Save an edit to one person.
 *
 * Every argument is nullable and the function coalesces, so sending only the
 * fields that changed cannot blank the rest. Passing an empty string to
 * `p_portrait` or `p_blurb` clears them on purpose.
 *
 * @param {string} id
 * @param {{name?: string, role?: string, color?: string, blurb?: string,
 *          portraitUrl?: string, order?: number}} patch
 */
export async function updatePerson(id, patch) {
  if (config.demoMode) {
    const rows = demoRoster();
    const index = rows.findIndex((row) => row.id === id);
    if (index === -1) return { ok: false, message: 'That entry is no longer on the page.' };

    // Mirror the SQL's coalesce semantics: an absent key means "leave alone",
    // an explicit empty string means "clear it".
    const pick = (key, field, fallback = '') =>
      patch[key] === undefined ? rows[index][field] : String(patch[key]).trim() || fallback;

    const next = rows[index];
    next.name = pick('name', 'name', next.name);
    next.role_label = pick('role', 'role_label', next.role_label);
    next.role_color = pick('color', 'role_color', next.role_color);
    next.blurb = patch.blurb === undefined ? next.blurb : String(patch.blurb).trim();
    next.portrait_url =
      patch.portraitUrl === undefined
        ? next.portrait_url
        : String(patch.portraitUrl).trim() || null;
    if (patch.order !== undefined) next.sort_order = Number(patch.order);

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
  const { error } = await client.rpc('wire_credits_people_upsert', {
    p_id: id,
    p_name: patch.name === undefined ? null : String(patch.name).trim(),
    p_role_label: patch.role === undefined ? null : String(patch.role).trim(),
    p_role_color: patch.color === undefined ? null : String(patch.color).trim(),
    p_blurb: patch.blurb === undefined ? null : String(patch.blurb).trim(),
    p_portrait: patch.portraitUrl === undefined ? null : String(patch.portraitUrl).trim(),
    p_sort_order: patch.order === undefined ? null : Number(patch.order)
  });

  if (error) return { ok: false, message: describe(error, 'credits entry') };
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
      sort_order: 1
    },
    {
      id: 'demo-1',
      name: 'Amara K.',
      role_label: 'Senior Reporter',
      role_color: '#1d4ed8',
      blurb: 'Covers local government and civic affairs.',
      portrait_url: null,
      sort_order: 10
    },
    {
      id: 'demo-2',
      name: 'Brian O.',
      role_label: 'Sports Correspondent',
      role_color: '#047857',
      blurb: 'Football, athletics, and the people who fund them.',
      portrait_url: null,
      sort_order: 20
    },
    {
      id: 'demo-3',
      name: 'Lilian W.',
      role_label: 'Photo Editor',
      role_color: '#b45309',
      blurb: 'Runs the picture desk and the gallery.',
      portrait_url: null,
      sort_order: 30
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

  return [...rows].sort(
    (a, b) => (a.sort_order ?? 100) - (b.sort_order ?? 100) || String(a.name).localeCompare(String(b.name))
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

/** Highest sort_order in use, so a new entry lands last. */
function nextDemoOrder(rows) {
  return rows.reduce((max, row) => Math.max(max, Number(row.sort_order) || 0), 0) + 10;
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
  return `
    <div class="mx-auto max-w-4xl">
      <header class="mb-8 text-center">
        <p class="eyebrow">About the newsroom</p>
        <h1 class="font-headline text-3xl font-bold sm:text-4xl">Credits</h1>
        <p class="rule-soft mx-auto mt-3 max-w-2xl text-sm ink-muted">
          ${people.length} ${people.length === 1 ? 'person makes' : 'people make'} The Wire.
        </p>
      </header>

      <ul class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        ${people.map(card).join('')}
      </ul>
    </div>
  `;
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

function card(person) {
  const portrait = safeUrl(person.portrait_url);
  const colour = normaliseColour(person.role_color);
  const role = String(person.role_label || 'Contributor').trim();

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
      <p
        class="mt-1.5 inline-block rounded-full px-2.5 py-1 text-[0.6875rem] font-bold tracking-[0.12em] uppercase"
        style="${
          colour
            ? `background:${colour};color:${readableOn(colour)}`
            : 'background:var(--color-newsred);color:#ffffff'
        }"
      >${escapeHtml(role)}</p>
      ${
        person.blurb
          ? `<p class="mt-2 text-sm ink-muted">${escapeHtml(person.blurb)}</p>`
          : ''
      }
    </li>
  `;
}
