/* =============================================================================
   src/lib/podcasts.js — PODCAST SUBMISSIONS AND PUBLICATION
   -----------------------------------------------------------------------------
   Writers file an episode; the Owner decides whether readers ever hear it. That
   is the whole shape of the feature, and it is why `status` exists: a submission
   is a request, not a publication.

   Two storage decisions worth stating up front:

     • A DEDICATE BUCKET, not a folder in wire-media. The storage policies can
       then say "audio only", and purging a rejected episode can never touch a
       portrait. Sharing one bucket would make a delete bug in one feature a data
       loss in another.

     • NO LOCAL DATA-URL FALLBACK, unlike upload.js. An MP3 is orders of
       magnitude larger than a thumbnail; inlining one into localStorage would
       blow the 5 MB quota on the first episode and take the whole session's
       state with it. If Storage is unreachable the writer is told so and keeps
       their file, rather than silently losing an hour of recorded audio.
   ========================================================================== */

import { config } from './config.js';
import { getSupabase } from './supabase.js';
import { getSession, isOwner } from './auth.js';

/** The storage bucket. Created by migration 024. */
const BUCKET = 'podcasts';

/**
 * MP3 only, and 25 MB.
 *
 * The extension AND the MIME type are both checked, and both must agree, because
 * either alone is forgeable: a `.mp3` name on a text file, or
 * `audio/mpeg` on whatever the browser happened to guess. A mismatch is refused
 * rather than sniffed, because the only thing this bucket serves back to readers
 * is an <audio> element, and a mislabelled file there is a broken page.
 */
const MAX_BYTES = 25 * 1024 * 1024;
const MP3_MIME = 'audio/mpeg';

/** The description is a one-line standfirst; the database enforces 140 too. */
export const MAX_DESCRIPTION = 140;

const STATUSES = ['pending', 'approved', 'rejected'];

/**
 * Whoever is signed in, for display.
 *
 * The episode stores a NAME, not an id, so that the public page can render a
 * byline without a join -- and so a submission still reads correctly after the
 * account behind it is renamed or removed. Same reasoning as the byline on an
 * article.
 *
 * @returns {string} never empty
 */
function displayName() {
  const user = getSession()?.user;
  return String(user?.name || user?.username || 'A contributor').trim() || 'A contributor';
}

/** @param {File} file @returns {string} an error message, or '' when fine */
export function validateAudioFile(file) {
  if (!file) return 'Choose an MP3 from your device first.';

  const nameLooksRight = /\.mp3$/i.test(file.name || '');
  const typeLooksRight = String(file.type || '').toLowerCase() === MP3_MIME;

  // Some browsers report an empty type for a file dragged from a desktop, and
  // some report `audio/mp3`. Accept those two spellings alongside the canonical
  // one, but ONLY if the extension agrees, so a renamed .wav still cannot in.
  const looseType = /^(audio\/mpeg|audio\/mp3|application\/octet-stream)$/i.test(
    String(file.type || '')
  );

  if (!nameLooksRight || (!typeLooksRight && !looseType)) {
    return 'Podcasts must be MP3 files. That one is not.';
  }
  if (file.size > MAX_BYTES) {
    return `That episode is ${Math.round(file.size / (1024 * 1024))} MB. The limit is 25 MB.`;
  }
  return '';
}

/** A collision-resistant object name that keeps the extension. */
function objectName(file) {
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `episodes/${stamp}-${rand}.mp3`;
}

/**
 * Turn a Storage failure into something the Owner can act on.
 *
 * The browser logs "Failed to load resource" for any response whose body it
 * cannot read, so a 404 from Storage and a CORS rejection look identical in the
 * console. Supabase's own message is the only thing that distinguishes them, and
 * the previous version of this code threw it away and showed a generic sentence
 * -- which is how a missing bucket gets reported as "the upload is broken".
 *
 * The four causes this distinguishes, in the order they actually occur:
 *
 *   • the bucket does not exist          -> run the repair migration
 *   • the bucket exists but is not public-> readers get a 400 on <audio src>
 *   • RLS refused the insert             -> the signed-in account is not staff
 *   • the object is too large           -> lower the client ceiling
 *
 * @param {object} error  the Supabase error object
 * @param {string} what   what was being attempted, for the message
 * @returns {string}
 */
export function describeStorageError(error, what = 'the episode') {
  const message = String(error?.message || error || 'no message').trim();
  const status = Number(error?.statusCode || error?.status || 0);
  const code = String(error?.errorCode || error?.code || '');
  const lower = message.toLowerCase();

  if (/bucket not found|not_found|404/.test(lower) || (status === 404 && !code)) {
    return (
      `The "podcasts" storage bucket does not exist, so ${what} could not be saved. ` +
      'Run supabase/migrations/025_podcasts_storage_repair.sql in the Supabase SQL editor. ' +
      `(Storage said: ${message})`
    );
  }

  if (/row-level security|violates row-level|new row/.test(lower) || code === '42501') {
    return (
      'Supabase Storage refused the upload: the signed-in account is not allowed to write ' +
      `to the "podcasts" bucket. (Storage said: ${message})`
    );
  }

  if (/exceeded the maximum allowed size|payload too large|413/.test(lower) || status === 413) {
    return (
      `That episode is too large for Supabase Storage (${message}). ` +
      `The ceiling is ${Math.round(MAX_BYTES / (1024 * 1024))} MB -- try a lower bitrate.`
    );
  }

  if (status === 401 || /jwt|token|not authenticated|authorization/i.test(lower)) {
    return (
      `Supabase Storage rejected the request as unauthenticated (${message}). ` +
      'The upload needs a signed-in staffer session; sign out and back in and retry.'
    );
  }

  if (status === 400) {
    return `Supabase Storage refused ${what} (400: ${message}).`;
  }

  return `Supabase Storage could not save ${what} (${status || 'no status'}: ${message}).`;
}

/**
 * Does the `podcasts` bucket exist and is it writable by this session?
 *
 * Runs BEFORE an upload so a misconfigured bucket costs one cheap read instead
 * of a wasted multi-megabyte POST, and so the writer is told what is wrong while
 * the file is still on their device.
 *
 * @returns {Promise<{ok: boolean, message?: string}>}
 */
export async function checkPodcastStorage() {
  if (config.demoMode) return { ok: true };
  const client = getSupabase();
  if (!client) return { ok: false, message: 'Not connected to the newsroom server.' };

  try {
    // A one-item list is the cheapest call that still exercises the bucket AND
    // this session's read access. It reads no object data.
    const { error } = await client.storage.from(BUCKET).list('', { limit: 1 });
    if (error) return { ok: false, message: describeStorageError(error, 'the podcast bucket') };
    return { ok: true };
  } catch (error) {
    return { ok: false, message: describeStorageError(error, 'the podcast bucket') };
  }
}

/* -------------------------------------------------------------------------- */
/* Demo store                                                                  */
/* -------------------------------------------------------------------------- */

const DEMO_KEY = 'pulse.podcasts';

/**
 * Demo episodes live in localStorage with an object URL for the audio.
 *
 * The URL cannot survive a reload -- an object URL is bound to the document that
 * created it -- so a restored episode comes back with a dead src and the player
 * shows its own "audio unavailable in demo" state. That is honest: pretending
 * otherwise would mean a player that appears to work and produces silence.
 */
function readDemo() {
  try {
    const raw = globalThis.localStorage?.getItem(DEMO_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function writeDemo(rows) {
  try {
    globalThis.localStorage?.setItem(DEMO_KEY, JSON.stringify(rows));
  } catch (error) {
    console.warn('[podcasts] demo store unavailable', error);
  }
}

function demoSeed() {
  return [
    {
      id: 'demo-pod-1',
      title: 'Season opener: what the county budget actually says',
      description: 'The Chair, the line items, and the three numbers worth arguing about.',
      author_name: 'The Pulse Staff',
      duration_seconds: 512,
      status: 'approved',
      created_at: '2026-09-18T07:30:00.000Z',
      updated_at: '2026-09-18T07:30:00.000Z',
      audio_url: '',
      storage_path: ''
    },
    {
      id: 'demo-pod-2',
      title: 'Interview: the coach behind three championships',
      description: 'Unrecorded in demo mode - the player needs a real uploaded MP3.',
      author_name: 'Amara K.',
      duration_seconds: 1284,
      status: 'approved',
      created_at: '2026-09-21T11:00:00.000Z',
      updated_at: '2026-09-21T11:00:00.000Z',
      audio_url: '',
      storage_path: ''
    },
    {
      id: 'demo-pod-3',
      title: 'Sports desk: the season so far',
      description: 'Awaiting the Owner. Present so the approval queue is not empty.',
      author_name: 'Brian O.',
      duration_seconds: 640,
      status: 'pending',
      created_at: '2026-09-24T16:45:00.000Z',
      updated_at: '2026-09-24T16:45:00.000Z',
      audio_url: '',
      storage_path: ''
    }
  ];
}

function demoRows() {
  const stored = readDemo();
  return stored.length ? stored : demoSeed();
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Episodes, newest first.
 *
 * @param {{status?: string, mine?: boolean}} [options]
 *   `status` narrows to one state; omit it for the public feed. `mine` returns
 *   the signed-in writer's own submissions, whatever their state.
 * @returns {Promise<Array<object>>} never rejects; an unreachable database
 *   resolves to an empty list so a reader sees "nothing yet" rather than a
 *   broken page.
 */
export async function listPodcasts({ status = '', mine = false } = {}) {
  if (config.demoMode) {
    const rows = demoRows().filter((row) => {
      if (mine) return row.author_name === displayName();
      if (status) return row.status === status;
      return row.status === 'approved';
    });
    return rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  }

  const client = getSupabase();
  if (!client) return [];

  let query = client
    .from('podcasts')
    .select(
      'id, title, description, audio_url, storage_path, duration_seconds, status, author_name, created_at, updated_at'
    )
    .order('created_at', { ascending: false });

  // The public feed asks for approved explicitly rather than relying on the RLS
  // policy, so the intent is legible here and the policy is the backstop.
  query = query.eq('status', status || 'approved');

  const { data, error } = await query;
  if (error) {
    console.warn('[podcasts] could not load episodes', error);
    return [];
  }
  return data || [];
}

/** Pending submissions, oldest first: the Owner works a queue in order. */
export function listPendingPodcasts() {
  return listPodcasts({ status: 'pending' });
}

/* -------------------------------------------------------------------------- */
/* Writes                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * File a submission. Always 'pending' -- the client cannot approve its own work,
 * and the INSERT policy pins the status and the filer from the session anyway,
 * so a crafted request gains nothing by lying here.
 *
 * @param {{title: string, description?: string, file: File,
 *          durationSeconds?: number}} input
 * @returns {Promise<{ok: boolean, message?: string, podcast?: object}>}
 */
export async function submitPodcast({ title, description = '', file, durationSeconds = null } = {}) {
  const cleanTitle = String(title || '').trim();
  if (!cleanTitle) return { ok: false, message: 'Give the episode a title.' };

  const cleanDescription = String(description || '').trim();
  if (cleanDescription.length > MAX_DESCRIPTION) {
    return {
      ok: false,
      message: `The description is ${cleanDescription.length} characters. The limit is ${MAX_DESCRIPTION}.`
    };
  }

  const problem = validateAudioFile(file);
  if (problem) return { ok: false, message: problem };

  const seconds = Number.isFinite(Number(durationSeconds))
    ? Math.max(0, Math.round(Number(durationSeconds)))
    : null;

  const who = displayName();

  if (config.demoMode) {
    const path = objectName(file);
    const url = URL.createObjectURL(file);
    const row = {
      id: `demo-pod-${Date.now().toString(36)}`,
      title: cleanTitle,
      description: cleanDescription || null,
      author_name: who,
      duration_seconds: seconds,
      status: 'pending',
      audio_url: url,
      storage_path: path,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    writeDemo([row, ...demoRows()]);
    return { ok: true, podcast: row };
  }

  const client = getSupabase();
  if (!client) return { ok: false, message: 'Not connected to the newsroom server.' };

  // Pre-flight the bucket. Uploading 25 MB to discover the bucket is missing
  // wastes the writer's data allowance and their time, and the failure they see
  // is a bare "Failed to load resource" in a console they may never open.
  const ready = await checkPodcastStorage();
  if (!ready.ok) return { ok: false, message: ready.message };

  const path = objectName(file);

  const { error: uploadError } = await client.storage
    .from(BUCKET)
    // `contentType` is set explicitly rather than left to the browser's guess:
    // the object is served back to an <audio> tag, and some browsers report an
    // mp3 as `application/octet-stream`, which makes the response download
    // rather than play. There is no multipart form here -- a supabase-js upload
    // is a single binary PUT -- so nothing about this is a CORS preflight beyond
    // the Authorization header the client always sends.
    .upload(path, file, { cacheControl: '31536000', upsert: false, contentType: MP3_MIME });

  if (uploadError) {
    // No data-URL fallback here, unlike upload.js: an MP3 will not fit in
    // localStorage and silently "succeeding" would lose a recorded episode. Say
    // so plainly and leave the writer's file untouched on their device.
    return {
      ok: false,
      message: `${describeStorageError(uploadError, 'the episode')} Your file is still on this device.`
    };
  }

  const { data: urlData } = client.storage.from(BUCKET).getPublicUrl(path);

  const { data, error } = await client
    .from('podcasts')
    .insert({
      title: cleanTitle,
      description: cleanDescription || null,
      audio_url: urlData?.publicUrl || null,
      storage_path: path,
      duration_seconds: seconds,
      status: 'pending',
      author_name: who
    })
    .select()
    .single();

  if (error) {
    // The row failed, so the object is orphaned. Remove it rather than leaving
    // an unplayable file accruing in a bucket nobody will ever list.
    await client.storage.from(BUCKET).remove([path]).catch(() => {});
    return { ok: false, message: 'The submission was refused by the server.' };
  }

  return { ok: true, podcast: data };
}

/**
 * Approve a submission, or reject it.
 *
 * Rejecting DELETES the row and purges the file, per the brief. Deleting the row
 * rather than storing status='rejected' is a deliberate trade: a 'rejected' row
 * keeps the object in Storage forever with nothing pointing at it, and the
 * alternative -- keeping it and hiding it -- needs the public read policy to be
 * right about a third state forever. There is no editorial value in a rejected
 * episode nobody can hear.
 *
 * @param {string} id
 * @param {'approved'|'rejected'} decision
 */
export async function decidePodcast(id, decision) {
  if (!STATUSES.includes(decision)) return { ok: false, message: 'Unknown decision.' };
  if (decision === 'pending') return { ok: false, message: 'A submission cannot be un-decided.' };

  if (config.demoMode) {
    const rows = demoRows();
    const row = rows.find((entry) => entry.id === id);
    if (!row) return { ok: false, message: 'That submission is no longer in the queue.' };

    if (decision === 'rejected') {
      if (row.audio_url?.startsWith('blob:')) URL.revokeObjectURL(row.audio_url);
      writeDemo(rows.filter((entry) => entry.id !== id));
      return { ok: true, message: 'Submission refused and its audio purged.' };
    }

    writeDemo(rows.map((entry) => (entry.id === id ? { ...entry, status: 'approved' } : entry)));
    return { ok: true, message: 'Episode published.' };
  }

  const client = getSupabase();
  if (!client) return { ok: false, message: 'Not connected to the newsroom server.' };

  if (decision === 'approved') {
    const { data, error } = await client
      .from('podcasts')
      .update({ status: 'approved' })
      .eq('id', id)
      .select()
      .single();

    if (error) return { ok: false, message: 'That submission could not be published.' };
    return { ok: true, message: 'Episode published.', podcast: data };
  }

  // Read the path BEFORE deleting: afterwards there is nothing left to learn it
  // from, and the file would sit in the bucket unreferenced forever.
  const { data: existing } = await client
    .from('podcasts')
    .select('storage_path')
    .eq('id', id)
    .maybeSingle();

  const { error } = await client.from('podcasts').delete().eq('id', id);
  if (error) return { ok: false, message: 'That submission could not be removed.' };

  if (existing?.storage_path) {
    const { error: purgeError } = await client.storage.from(BUCKET).remove([existing.storage_path]);
    if (purgeError) {
      // The row is gone, so the episode is definitively not published. An
      // orphaned object costs storage, not correctness -- and saying so is
      // better than reporting a failure that did not happen.
      console.warn('[podcasts] could not purge the rejected audio', purgeError);
      return {
        ok: true,
        message: 'Submission refused. Its audio could not be purged from storage.'
      };
    }
  }

  return { ok: true, message: 'Submission refused and its audio purged.' };
}

/** Can the signed-in session approve? The tab is owner-only; this is the copy. */
export function canDecidePodcasts() {
  return isOwner();
}

/* -------------------------------------------------------------------------- */
/* Owner: direct publication                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Publish an episode as the Owner, skipping the queue.
 *
 * The Owner's own upload is not a submission, so it lands 'approved'. This is a
 * DIFFERENT function from `submitPodcast` on purpose rather than a flag on it:
 * `submitPodcast` always writes 'pending', and the INSERT policy pins that, so
 * the one path a writer can reach cannot be widened by adding a parameter to it.
 *
 * @param {{title: string, description?: string, file?: File, audioUrl?: string,
 *          durationSeconds?: number}} input
 */
export async function publishPodcast({
  title,
  description = '',
  file = null,
  audioUrl = '',
  durationSeconds = null
} = {}) {
  const cleanTitle = String(title || '').trim();
  if (!cleanTitle) return { ok: false, message: 'Give the episode a title.' };

  const cleanDescription = String(description || '').trim();
  if (cleanDescription.length > MAX_DESCRIPTION) {
    return {
      ok: false,
      message: `The description is ${cleanDescription.length} characters. The limit is ${MAX_DESCRIPTION}.`
    };
  }

  const who = displayName();

  // A pasted URL is accepted as well as an upload, matching every other media
  // field in this panel. It is validated with safeUrl by the caller-facing form;
  // here it only has to be a non-empty string.
  if (!file && !String(audioUrl).trim()) {
    return { ok: false, message: 'Upload an MP3, or paste a link to one.' };
  }

  if (config.demoMode) {
    const path = file ? objectName(file) : '';
    const row = {
      id: `demo-pod-${Date.now().toString(36)}`,
      title: cleanTitle,
      description: cleanDescription || null,
      author_name: who,
      duration_seconds: Number.isFinite(Number(durationSeconds))
        ? Math.round(Number(durationSeconds))
        : null,
      status: 'approved',
      audio_url: file ? URL.createObjectURL(file) : String(audioUrl).trim(),
      storage_path: path,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    writeDemo([row, ...demoRows()]);
    return { ok: true, message: 'Episode published.', podcast: row };
  }

  const client = getSupabase();
  if (!client) return { ok: false, message: 'Not connected to the newsroom server.' };

  let path = '';
  let url = String(audioUrl).trim();

  if (file) {
    const ready = await checkPodcastStorage();
    if (!ready.ok) return { ok: false, message: ready.message };

    const problem = validateAudioFile(file);
    if (problem) return { ok: false, message: problem };

    path = objectName(file);
    const { error } = await client.storage
      .from(BUCKET)
      .upload(path, file, {
        cacheControl: '31536000',
        upsert: false,
        contentType: MP3_MIME
      });
    if (error) {
      return {
        ok: false,
        message: `${describeStorageError(error, 'the episode')} Your file is still on this device.`
      };
    }
    url = client.storage.from(BUCKET).getPublicUrl(path).data?.publicUrl || '';
  }

  const { data, error } = await client
    .from('podcasts')
    .insert({
      title: cleanTitle,
      description: cleanDescription || null,
      audio_url: url || null,
      storage_path: path || null,
      duration_seconds: Number.isFinite(Number(durationSeconds))
        ? Math.round(Number(durationSeconds))
        : null,
      status: 'approved',
      author_name: who
    })
    .select()
    .single();

  if (error) {
    if (path) await client.storage.from(BUCKET).remove([path]).catch(() => {});
    return { ok: false, message: `The episode could not be saved: ${error.message}` };
  }

  return { ok: true, message: 'Episode published.', podcast: data };
}

/**
 * Edit an episode's text. Deliberately NOT audio: swapping the file would orphan
 * the old object in the bucket, and the row cannot tell which object is live
 * without a second write. Replacing audio is "upload a new one and delete this".
 *
 * @param {string} id
 * @param {{title?: string, description?: string, authorName?: string}} patch
 */
export async function updatePodcastText(id, patch) {
  const title = patch.title === undefined ? undefined : String(patch.title).trim();
  if (title === '') return { ok: false, message: 'An episode needs a title.' };

  const description =
    patch.description === undefined ? undefined : String(patch.description).trim();
  if (description !== undefined && description.length > MAX_DESCRIPTION) {
    return {
      ok: false,
      message: `The description is ${description.length} characters. The limit is ${MAX_DESCRIPTION}.`
    };
  }

  if (config.demoMode) {
    const rows = demoRows();
    const next = rows.map((row) =>
      row.id === id
        ? {
            ...row,
            ...(title === undefined ? {} : { title }),
            ...(description === undefined ? {} : { description: description || null }),
            ...(patch.authorName === undefined
              ? {}
              : { author_name: String(patch.authorName).trim() || row.author_name })
          }
        : row
    );
    if (!next.some((row) => row.id === id)) {
      return { ok: false, message: 'That episode is no longer listed.' };
    }
    writeDemo(next);
    return { ok: true, message: 'Episode updated.' };
  }

  const client = getSupabase();
  if (!client) return { ok: false, message: 'Not connected to the newsroom server.' };

  const row = {};
  if (title !== undefined) row.title = title;
  if (description !== undefined) row.description = description || null;
  if (patch.authorName !== undefined) {
    row.author_name = String(patch.authorName).trim() || 'The Pulse Staff';
  }
  if (!Object.keys(row).length) return { ok: true, message: 'Nothing to change.' };

  const { data, error } = await client
    .from('podcasts')
    .update(row)
    .eq('id', id)
    .select()
    .single();

  if (error) return { ok: false, message: `The episode could not be updated: ${error.message}` };
  return { ok: true, message: 'Episode updated.', podcast: data };
}

/**
 * Delete an episode and purge its audio.
 *
 * Used by BOTH "remove" and "refuse": they are the same act on different rows,
 * and having two paths was how the first version ended up orphaning objects.
 *
 * @param {string} id
 */
export async function deletePodcast(id) {
  if (config.demoMode) {
    const rows = demoRows();
    const row = rows.find((entry) => entry.id === id);
    if (!row) return { ok: false, message: 'That episode is no longer listed.' };
    if (row.audio_url?.startsWith('blob:')) URL.revokeObjectURL(row.audio_url);
    writeDemo(rows.filter((entry) => entry.id !== id));
    return { ok: true, message: 'Episode deleted and its audio purged.' };
  }

  const client = getSupabase();
  if (!client) return { ok: false, message: 'Not connected to the newsroom server.' };

  const { data: existing } = await client
    .from('podcasts')
    .select('storage_path')
    .eq('id', id)
    .maybeSingle();

  const { error } = await client.from('podcasts').delete().eq('id', id);
  if (error) return { ok: false, message: `The episode could not be deleted: ${error.message}` };

  if (existing?.storage_path) {
    const { error: purgeError } = await client.storage
      .from(BUCKET)
      .remove([existing.storage_path]);
    if (purgeError) {
      console.warn('[podcasts] could not purge the deleted audio', purgeError);
      return {
        ok: true,
        message: 'Episode deleted. Its audio could not be purged from storage.'
      };
    }
  }

  return { ok: true, message: 'Episode deleted and its audio purged.' };
}
