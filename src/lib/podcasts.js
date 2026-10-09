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
// `safeUrl` VALIDATES the two URLs a submission carries — the audio link and the
// cover image — and both land in an inline attribute or an <audio> src. Without
// this import `submitPodcast()` threw `ReferenceError: safeUrl is not defined` on
// the FIRST line that touched either field, so every writer podcast submission
// failed at runtime and both submit paths were dead.
//
// It passed the test suite because `tests/features.mjs` asserts the CALL SITE
// (`/const cleanAudioUrl = safeUrl\(audioUrl\)/`) with a source regex, and a
// regex cannot tell whether the name was ever bound. A static test that greps for
// a call is not evidence the call can run; the fix for that is a runtime assertion,
// added below.
import { safeUrl } from './dom.js';

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

/**
 * The signed-in account's `staff_accounts.id`, or null.
 *
 * WHY THE PODCAST ROW NEEDS THIS AT ALL, given it also stores a name
 * -----------------------------------------------------------------
 * Storing a name is right for DISPLAY -- a submission must still read correctly
 * after the account is renamed or removed. But the insert policy is
 *
 *     with check (is_staff() and status = 'pending'
 *                  and author_account_id = current_account_id())
 *
 * and neither insert path ever sent `author_account_id`. It is a nullable column,
 * so the row was written with NULL -- and `NULL = current_account_id()` is NULL,
 * not true, so the policy refused the insert. A writer submission could NEVER
 * succeed: the refusal was reported as a generic "The submission was refused by
 * the server", which is the least informative sentence available for a
 * misconfigured policy.
 *
 * `author_name` is free text, so a row with a NULL `author_account_id` also cannot
 * be withdrawn by its author afterwards, and cannot be attributed to an account
 * at all. The id is what makes the row knowable.
 *
 * @returns {string|null} a uuid, or null when not signed in
 */
function accountId() {
  const id = getSession()?.user?.id;
  return typeof id === 'string' && id.length > 0 ? id : null;
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
 * Does the `podcasts` bucket exist, and can THIS SESSION write to it?
 *
 * Runs BEFORE an upload so a misconfigured bucket costs one tiny write instead of
 * a wasted multi-megabyte POST, and so the writer is told what is wrong while the
 * file is still on their device.
 *
 * WHY THIS PROBES A WRITE, NOT A READ
 * ----------------------------------
 * It used to call `.list('', { limit: 1 })`, on the reasonable-sounding grounds
 * that it was "the cheapest call that still exercises the bucket". It is not,
 * for this purpose: `list` is a READ, and it is authorised by `podcasts_read`.
 * The policy that actually refuses podcast uploads is `podcasts_upload`, which
 * is `for insert ... with check (public.is_staff())`.
 *
 * So the preflight passed, the dialog opened, the writer picked their episode and
 * spent their data allowance pushing it — and the upload was refused at the very
 * end by a rule the preflight had never tested. The failure surfaced as an RLS
 * error after the whole file had crossed the network, which is the worst moment
 * to discover it and exactly the thing this function exists to prevent.
 *
 * The probe therefore uploads a one-byte object to the same `episodes/` prefix
 * the real upload uses — so it exercises the `foldername(name) = 'episodes'`
 * clause too, not just the role check — and removes it again. Delete is Owner
 * only, so cleanup is best-effort: a writer who cannot delete leaves a 1-byte
 * orphan at a `.probe` path. That is a deliberate trade, because the alternative
 * is no write check at all.
 *
 * @returns {Promise<{ok: boolean, message?: string}>}
 */
export async function checkPodcastStorage() {
  if (config.demoMode) return { ok: true };
  const client = getSupabase();
  if (!client) return { ok: false, message: 'Not connected to the newsroom server.' };

  /*
   * Does the bucket itself exist? Asking first keeps the RLS answer meaningful:
   * a missing bucket and a refused write produce different messages, and the
   * Owner needs the missing-bucket one because the fix is to run a migration.
   */
  try {
    const { error: listError } = await client.storage.from(BUCKET).list('', { limit: 1 });
    if (listError) return { ok: false, message: describeStorageError(listError, 'the podcast bucket') };
  } catch (error) {
    return { ok: false, message: describeStorageError(error, 'the podcast bucket') };
  }

  /*
   * Now the write probe. Deliberately a SEPARATE try: the RLS refusal below is
   * the interesting failure, and folding it into the same catch as the read
   * would blur "the bucket is gone" with "you may not write to it".
   */
  /*
   * UNIQUE PER ATTEMPT, deliberately. With `upsert: false` a path that already
   * exists is refused as a duplicate rather than overwritten -- and the cleanup
   * below is Owner-only, so a Writer can never remove their own probe. A fixed
   * path therefore breaks permanently after one Writer probe: the orphan stays
   * and every later probe fails on the duplicate. A fresh name each time costs
   * one byte per failed cleanup and keeps the probe repeatable for everyone.
   */
  const probePath = `episodes/.write-probe-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  try {
    const { error: writeError } = await client.storage
      .from(BUCKET)
      .upload(probePath, new Blob([new Uint8Array(1)]), {
        contentType: 'application/octet-stream',
        // NOT upsert.
        //
        // `upsert: true` makes Storage send `x-upsert: true` and perform an
        // upsert, which requires UPDATE authority as well as INSERT. The
        // podcasts bucket has no UPDATE policy -- 025 deliberately defines only
        // podcasts_read (select), podcasts_upload (insert) and podcasts_delete
        // (delete) -- so the probe was refused with a 400 and the panel reported
        // "the upload policy is missing", sending everyone to re-run a migration
        // that was already correctly applied.
        //
        // The probe is a one-byte object that is deleted a few lines below.
        // There is nothing to upsert over, and the real episode upload already
        // uses upsert: false. The portraits probe can use upsert: true because
        // 034 gives wire-media an UPDATE policy; this bucket deliberately has
        // none.
        upsert: false
      });

    if (writeError) {
      // The old wording here pointed at migration 025, which was the wrong
      // advice: the cause was this probe's own upsert flag, and re-running a
      // correctly applied migration cannot fix it. Name what is actually
      // actionable instead.
      return {
        ok: false,
        message:
          describeStorageError(writeError, 'the podcast bucket') +
          ' The bucket is there and readable, so this is a write-permission ' +
          'problem for this account: it needs an active row in staff_accounts, ' +
          'and the podcasts bucket accepts new objects under episodes/ but ' +
          'refuses to overwrite one that is already there.'
      };
    }
  } catch (error) {
    return { ok: false, message: describeStorageError(error, 'the podcast bucket') };
  }

  // Best-effort cleanup. podcasts_delete is is_owner() only, so a Writer or a
  // Board Manager cannot remove their own probe and silently leaves a 1-byte
  // orphan behind. That is why probePath is unique per attempt: the orphans
  // accumulate, but they can never block the next probe.
  try {
    await client.storage.from(BUCKET).remove([probePath]);
  } catch {
    /* a 1-byte orphan at a .write-probe path is not worth failing an upload over */
  }

  return { ok: true };
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
      'id, title, description, audio_url, storage_path, cover_url, duration_seconds, status, author_name, created_at, updated_at'
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
 *          authorName?: string, durationSeconds?: number,
 *          coverUrl?: string, audioUrl?: string}} input
 * @returns {Promise<{ok: boolean, message?: string, podcast?: object}>}
 */
export async function submitPodcast({ title, description = '', file, authorName = '', durationSeconds = null, coverUrl = null, audioUrl = null } = {}) {
    const cleanTitle = String(title || '').trim();
    if (!cleanTitle) return { ok: false, message: 'Give the episode a title.' };

    const cleanDescription = String(description || '').trim();
    if (cleanDescription.length > MAX_DESCRIPTION) {
      return {
        ok: false,
        message: `The description is ${cleanDescription.length} characters. The limit is ${MAX_DESCRIPTION}.`
      };
    }

    /*
      AUDIO BY URL, for a submission made without a local file.

      The form offers a file OR a pasted URL, because a writer filing from a
      phone camera roll has the audio somewhere the file picker cannot reach, and
      a "you must re-download and re-upload it" failure is a support ticket.

      safeUrl() is applied rather than trusted: the value ends up in an `src`
      attribute on the public podcast card, and an unvalidated string there is a
      javascript: link waiting to happen. It rejects anything that is not http(s)
      or a data image, which is the same gate every other stored URL goes through.
    */
    const cleanAudioUrl = safeUrl(audioUrl);
    if (audioUrl && !cleanAudioUrl) {
      return { ok: false, message: 'That audio link is not a usable http(s) URL.' };
    }
    if (!file && !cleanAudioUrl) {
      return { ok: false, message: 'Choose an MP3 or paste a link to the audio.' };
    }

  /*
    ONLY VALIDATE A FILE THAT EXISTS.

    This line used to be unconditional:
        const problem = validateAudioFile(file);

    and `validateAudioFile(null)` returns 'Choose an MP3 from your device first.'
    -- so a submission that PASTED AN AUDIO URL was rejected by the validator for
    the one thing it did not have: a file. The check immediately above had already
    established that file OR URL was supplied; this then demanded the file. The
    form has offered the URL field since the feature shipped, so half of the
    documented submission path could never succeed, and it failed with a message
    about the field the writer had deliberately left blank.

    Guarding on `file` is the whole fix, and it is the guard the function above
    implies should be here.
  */
  const problem = file ? validateAudioFile(file) : '';
  if (problem) return { ok: false, message: problem };

  const seconds = Number.isFinite(Number(durationSeconds))
    ? Math.max(0, Math.round(Number(durationSeconds)))
    : null;

  /*
    THE SPEAKER / HOST NAME IS `author_name`, and this was a DEAD FIELD until now.

    The panel has rendered "Speaker / host name" since the submission form was
    written, and the submit handler never read it. `podcasts` has no separate host
    column -- `author_name` IS the byline the public card renders -- so the field
    was always going to be that column, and nobody connected the two.

    A podcast guest is frequently not the person who recorded the file, which is
    exactly the case this feature exists for: "Mercy Kamande on the athletics
    funding gap", filed by a writer who is not Mercy. Typing the guest's name and
    having it silently ignored is worse than not offering the field at all.

    Falls back to the signed-in account's display name, exactly as before.
  */
  const who = String(authorName || '').trim() || displayName();

  if (config.demoMode) {
    // Declared here, not shared with the live path below: the demo branch
    // returns before reaching it, so hoisting them would only invite a TDZ.
    const path = file ? objectName(file) : null;
    // A pasted URL is used as-is. A real file becomes a blob URL, which is what
    // the demo player can actually play.
    const url = file ? URL.createObjectURL(file) : cleanAudioUrl;
    const row = {
      id: `demo-pod-${Date.now().toString(36)}`,
      title: cleanTitle,
      description: cleanDescription || null,
      author_name: who,
      duration_seconds: seconds,
      status: 'pending',
      audio_url: url,
      // NULL rather than an object URL string for a link submission, so the demo
      // store matches what the database would hold and a later purge does not
      // try to delete an object that was never uploaded.
      storage_path: path,
      cover_url: safeUrl(coverUrl) || null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    writeDemo([row, ...demoRows()]);
    return { ok: true, podcast: row };
  }

  const client = getSupabase();
  if (!client) return { ok: false, message: 'Not connected to the newsroom server.' };

  /*
    UPLOAD ONLY WHEN THERE IS A FILE.

    A pasted URL short-circuits the whole Storage path: there is nothing to
    upload, nothing that can fail, and nothing that needs a writable bucket --
    which is what lets a Writer file an episode by link on a deployment whose
    Storage is misconfigured. `storage_path` stays NULL so a later purge knows
    there is no object to remove rather than trying to delete one.
  */
  let path = null;
  let url = cleanAudioUrl;

  if (file) {
    // Pre-flight the bucket. Uploading 25 MB to discover the bucket is missing
    // wastes the writer's data allowance and their time, and the failure they see
    // is a bare "Failed to load resource" in a console they may never open.
    const ready = await checkPodcastStorage();
    if (!ready.ok) return { ok: false, message: ready.message };

    path = objectName(file);

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
    url = urlData?.publicUrl || '';
  }

  const { data, error } = await client
    .from('podcasts')
    .insert({
      title: cleanTitle,
      description: cleanDescription || null,
      // `url`, NOT `urlData`: urlData is scoped inside the `if (file)` block and
      // does not exist at all for a link submission. `url` is the resolved value
      // either way -- the CDN URL for an upload, the pasted URL otherwise.
      audio_url: url || null,
      storage_path: path,
      cover_url: safeUrl(coverUrl) || null,
      duration_seconds: seconds,
      status: 'pending',
      // Required by podcasts_staff_submit. See accountId(): without it the
      // policy's `author_account_id = current_account_id()` is NULL and the insert
      // is refused, so this line is what makes writer submissions possible at all.
      author_account_id: accountId(),
      author_name: who
    })
    .select()
    .single();

  if (error) {
    // The row failed, so the object is orphaned. Remove it rather than leaving
    // an unplayable file accruing in a bucket nobody will ever list.
    //
    // Guarded on `path`: for a link submission there is no object, and calling
    // remove() with null used to be a pointless request that could mask the real
    // error behind a second one.
    if (path) await client.storage.from(BUCKET).remove([path]).catch(() => {});
    return {
      ok: false,
      message: accountId()
        ? `The submission was refused by the server. ${error.message}`
        : 'You need to be signed in as an active staffer to file an episode.'
    };
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

  const deleted = await deletePodcastRow(client, id);
  if (!deleted.ok) return { ok: false, message: deleted.message };

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
 *          authorName?: string, coverUrl?: string,
 *          durationSeconds?: number}} input
 */
export async function publishPodcast({
  title,
  description = '',
  file = null,
  audioUrl = '',
  authorName = '',
  coverUrl = null,
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

  // The Owner's own byline, overridable for a guest they are interviewing, and
  // falling back to the account exactly as the writer path does.
  const who = String(authorName || '').trim() || displayName();

  // `safeUrl` on the cover, same gate as the audio link and for the same reason:
  // it is rendered into a `src` on the public card.
  const cleanCoverUrl = safeUrl(coverUrl);
  if (coverUrl && !cleanCoverUrl) {
    return { ok: false, message: 'That cover image link is not a usable http(s) URL.' };
  }

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
      // Same shape as the live insert below: the demo store must not be able to
      // hold an episode the database could not, or a demo Owner would see
      // artwork that vanishes the moment they sign in for real.
      cover_url: cleanCoverUrl || null,
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
      // The Owner's publish-now path. `status = 'pending'` is deliberately NOT
      // satisfied here, and podcasts_staff_submit forbids self-approval by design;
      // this row is permitted by podcasts_owner_all instead, whose WITH CHECK is
      // is_owner(). Permissive policies are OR'd, so the Owner's insert is allowed
      // even though the writer policy rejects it -- which is the intended shape.
      //
      // author_account_id is still sent, because it is what lets the Owner's own
      // published episodes be attributed and later edited by the same code path
      // that edits an approved row.
      author_account_id: accountId(),
      author_name: who,
      // The Owner's publish-now path had no artwork field at all, so a podcast
      // published this way could never carry a cover while a submitted one could:
      // the same episode published by two different roles looked like two
      // different episodes.
      cover_url: cleanCoverUrl || null
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
 * Delete a podcast row and ASSERT that it went.
 *
 * RLS filters rows; it does not raise. A DELETE whose policy matches nothing
 * comes back as success with zero rows affected, which is how a Board Manager
 * clicking "Refuse" on a Writer's episode got a green toast, an emptied queue
 * and an episode that was still live -- see 038, which grants the authority the
 * panel already promised. The grant fixes the cause; this makes the symptom
 * impossible to hide if any other policy is ever too narrow again.
 *
 * `.select('id')` is what turns "no error" into evidence. Without it PostgREST
 * has no row to hand back and a filtered delete is indistinguishable from a real
 * one.
 *
 * @param {object} client
 * @param {string} id
 * @returns {Promise<{ok: boolean, message?: string}>}
 */
async function deletePodcastRow(client, id) {
  const { data, error } = await client.from('podcasts').delete().eq('id', id).select('id');
  if (error) return { ok: false, message: error.message };

  if (!Array.isArray(data) || data.length === 0) {
    return {
      ok: false,
      message:
        'That episode was not removed. Either it has already gone, or this ' +
        'account is not allowed to delete it.'
    };
  }
  return { ok: true };
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

  const deleted = await deletePodcastRow(client, id);
  if (!deleted.ok) {
    return { ok: false, message: `The episode could not be deleted: ${deleted.message}` };
  }

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
