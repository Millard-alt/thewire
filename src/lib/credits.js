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
 *          order?: number, sort_order?: number}} patch
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
    p_sort_order: orderValue === undefined ? null : Number(orderValue)
  });

  if (error) return { ok: false, message: describe(error, 'credits entry') };

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
      <h1 class="font-headline text-3xl font-bold tracking-[0.06em] uppercase">Credits</h1>
      <p class="rule-soft mt-3 text-sm ink-muted">
        The people behind The Wire are being assembled. Please check back shortly.
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
          ${people.length} ${people.length === 1 ? 'person makes' : 'people make'} The Wire.
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

function card(person) {
  const portrait = safeUrl(person.portrait_url);

  /*
    Sharp-cornered, left-aligned row card. The role chip is deliberately NOT
    repeated here: the heading above the grid already names the role and carries
    its colour, so a per-card chip said the same thing twice.
  */
  return `
    <li class="credits-card">
      ${
        portrait
          ? `<img
              class="credits-card__avatar"
              src="${escapeHtml(portrait)}"
              alt=""
              width="48"
              height="48"
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
