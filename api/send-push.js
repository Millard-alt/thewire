/**
 * THE PULSE - web push sender.
 *
 * Until now a "broadcast" was only a row in `public.broadcasts` that every
 * opted-in browser discovered by POLLING. That cannot reach a phone with the app
 * closed, which is the entire point of push. This is the missing server: it loads
 * the newest broadcast, loads every subscription that has real keys, and hands
 * each to `web-push`, which does the ECDH handshake and posts an encrypted
 * payload to the push service (FCM on Android, APNs on iOS).
 *
 * Three ways in:
 *   POST /api/send-push   body { broadcastId } or { title, body, audience }
 *                         (the Owner Panel's custom broadcast form posts here)
 *   GET  /api/send-push   flushes anything not yet sent (Vercel Cron)
 *   Supabase Database Webhook on INSERT into public.broadcasts posting
 *   { type: 'INSERT', table: 'broadcasts', record: { id } }
 *
 * `/api/broadcast` is an alias of this route, so the Owner Panel can use either.
 *
 * AUTHENTICATION
 *   Two accepted credentials, so the Owner Panel can call this directly:
 *     1. PUSH_SEND_TOKEN, as `Authorization: Bearer <token>`. This is for the
 *        cron and the Supabase webhook. Header only: `?token=` was removed
 *        because a query string is written to Vercel's request logs and browser
 *        history.
 *     2. The Owner's own browser session, presented in the `x-wire-token`
 *        header. This is the SAME opaque token every other database request in
 *        this app already carries (see src/lib/supabase.js), and it is resolved
 *        server-side through wire_session_diagnostic(), which reports whether the
 *        caller is the Owner. Requiring that header is what stops a third party
 *        spamming the subscriber list, without forcing the VAPID secret or a
 *        second token into the browser bundle.
 *
 *   If PUSH_SEND_TOKEN is unset and no valid Owner session is presented, the
 *   endpoint refuses the call rather than defaulting to open.
 */

import crypto from 'node:crypto';
import webpush from 'web-push';
import { createClient } from '@supabase/supabase-js';

const TAG = '[api/send-push]';

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '';

// service_role is required: the key columns are not readable by anon, and a
// browser must never be able to read another device's subscription keys.
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.VITE_SUPABASE_ANON_KEY ||
  '';

const VAPID_PUBLIC = process.env.VITE_VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT =
  process.env.VAPID_SUBJECT || 'mailto:melvinjonespressclub@gmail.com';
const PUSH_TOKEN = process.env.PUSH_SEND_TOKEN || '';

/** Vercel Cron calls GET once a minute. Keep a run inside the hobby wall-clock. */
const MAX_SENDS = 500;

function fail(res, status, code, detail) {
  console.error(`${TAG} ${code}`, detail || '');
  return res.status(status).json({ ok: false, code, detail: detail || null });
}

/**
 * Compare a candidate against an expected secret without leaking its length or
 * contents through timing.
 *
 * `crypto.timingSafeEqual` throws when the buffers differ in length, so the
 * length is checked first. That check does reveal length, which is acceptable
 * for a fixed-length deployment secret and is what every Node comparison ends
 * up doing.
 *
 * The `if (!expected)` guard is the load-bearing part: without it an unset
 * PUSH_SEND_TOKEN compares equal to an empty bearer and the endpoint opens.
 */
function secretMatches(candidate, expected) {
  if (!expected || !candidate) return false;
  const a = Buffer.from(candidate, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * True when the caller presents PUSH_SEND_TOKEN as a bearer header.
 *
 * Header only. `?token=` was removed: a query string lands in Vercel request
 * logs, in browser history, and in the Referer header of anything the response
 * links to. Vercel Cron sends `Authorization: Bearer <CRON_SECRET|PUSH_SEND_TOKEN>`,
 * and the Supabase webhook can be configured with a header too, so nothing that
 * worked stops working.
 */
function hasSharedSecret(req) {
  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
  return secretMatches(bearer, PUSH_TOKEN);
}

// Exported for scripts/api-auth-check.mjs. Vercel routes on the default export,
// so named exports here do not become endpoints.
export { secretMatches, hasSharedSecret };

/**
 * Is the caller the Owner, using the browser session token the rest of the app
 * already sends?
 *
 * The browser holds an opaque `wire_login` token in localStorage and presents it
 * as `x-wire-token`; the RLS helpers resolve it to a staff account. Here we do
 * the same resolution through `wire_session_diagnostic()`, which explicitly
 * reports `is_owner` and never leaks anything about other accounts.
 *
 * This exists because the Owner Panel cannot hold PUSH_SEND_TOKEN: anything in a
 * VITE_ variable ships to every reader. Without this branch the Owner Panel's
 * POST is rejected with 401 and custom broadcasts can only ever be in-app.
 */
async function isOwnerSession(req, db) {
  const token = req.headers['x-wire-token'] || req.headers['X-Wire-Token'];
  if (!token || !db) return false;
  try {
    const { data, error } = await db.rpc('wire_session_diagnostic');
    if (error) {
      console.warn(`${TAG} owner session check failed`, error.message);
      return false;
    }
    return Boolean(data && data.session_resolved && data.is_owner);
  } catch (error) {
    console.warn(`${TAG} owner session check threw`, error.message);
    return false;
  }
}

/**
 * Accept a staff id only if it really is a UUID.
 *
 * Returns null for anything else, which the sender reads as "broadcast to
 * everyone". That is the safe direction: a mangled id falls back to a normal
 * broadcast rather than erroring or silently matching no rows and reporting
 * success.
 */
function uuidOrNull(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text)
    ? text
    : null;
}

/** Parse a webhook envelope, a cron GET and a direct POST into one shape. */
async function readRequest(req) {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET') return { source: 'cron', broadcastId: null };

  let body = {};
  if (typeof req.body === 'string') {
    try {
      body = JSON.parse(req.body);
    } catch {
      body = {};
    }
  } else if (req.body && typeof req.body === 'object') {
    body = req.body;
  } else if (String(req.headers['content-type'] || '').includes('application/json')) {
    const raw = await new Promise((resolve) => {
      let data = '';
      req.on('data', (chunk) => {
        data += chunk;
        if (data.length > 1e6) req.destroy();
      });
      req.on('end', () => resolve(data));
      req.on('error', () => resolve(''));
    });
    try {
      body = JSON.parse(raw);
    } catch {
      body = {};
    }
  }

  if (body.type === 'INSERT' && body.record) {
    return { source: 'webhook', broadcastId: body.record.id ?? null };
  }

  // The Owner Panel's custom broadcast. `body` is the field name the Service
  // Worker reads; `message` is accepted as an alias because that is what the
  // `broadcasts` table column is called.
  if (body.title) {
    return {
      source: 'api',
      broadcastId: body.broadcastId ?? null,
      // "Specific User" in the Audience picker. Validated as a UUID because it
      // is interpolated into a PostgREST filter; a malformed value would
      // otherwise surface as an opaque 502 from the database.
      targetStaffId: uuidOrNull(body.targetStaffId ?? body.targetUserId),
      inline: {
        title: body.title,
        message: body.body ?? body.message ?? '',
        audience: body.audience || 'Everyone',
        url: body.url || '',
        requiresAction: body.requiresAction !== false
      }
    };
  }

  if (body.broadcastId) return { source: 'api', broadcastId: body.broadcastId };
  return { source: 'api', broadcastId: url.searchParams.get('id') };
}

/**
 * Turn one broadcast (stored row or inline POST) into the JSON payload
 * public/sw.js parses in its `push` handler.
 *
 * `icon` is included because the Service Worker honours it, and
 * `/icons/icon-192.png` is the file that actually exists in `public/` â€”
 * `/icon-192.png` would 404 and the OS would fall back to a generic glyph.
 */
function payloadFor(broadcast) {
  if (broadcast) {
    return {
      title: broadcast.title || 'THE PULSE',
      body: broadcast.message || '',
      icon: '/icons/icon-192.png',
      url: broadcast.url || '/',
      tag: `wire-${broadcast.id}`,
      requireInteraction: broadcast.requiresAction !== false,
      broadcastId: broadcast.id
    };
  }
  return null;
}

export default async function handler(req, res) {
  console.log(`${TAG} invoked`, {
    method: req.method,
    hasToken: Boolean(PUSH_TOKEN),
    hasPublicKey: Boolean(VAPID_PUBLIC),
    hasPrivateKey: Boolean(VAPID_PRIVATE),
  });

  if (req.method !== 'GET' && req.method !== 'POST') {
    return fail(res, 405, 'method_not_allowed', 'Use GET or POST.');
  }

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return fail(res, 500, 'no_supabase_env', 'VITE_SUPABASE_URL / service role key missing.');
  }
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
    return fail(
      res,
      500,
      'no_vapid_keys',
      'VITE_VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY must both be set in Vercel.'
    );
  }

  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
  const db = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Authenticate before doing any real work, so an unauthorised call costs one
  // round-trip and never reaches the subscriber list.
  //
  // The shared secret covers the cron and the Supabase webhook; the Owner's own
  // browser session covers the Owner Panel. Firing a custom broadcast at every
  // subscriber is privileged either way, so an unauthenticated POST is refused
  // rather than silently degrading to in-app only.
  if (hasSharedSecret(req)) {
    // Authorised by PUSH_SEND_TOKEN.
  } else if (!(await isOwnerSession(req, db))) {
    return fail(
      res,
      PUSH_TOKEN ? 401 : 503,
      PUSH_TOKEN ? 'unauthorised' : 'push_send_token_unset',
      PUSH_TOKEN
        ? 'Not the Owner, or no valid session token.'
        : 'PUSH_SEND_TOKEN is not set, and no Owner session was presented. ' +
          'Add the secret in Vercel, or sign in as the Owner.'
    );
  }

  let request;
  try {
    request = await readRequest(req);
  } catch (error) {
    return fail(res, 400, 'bad_body', error.message);
  }

  // ---------------------------------------------------------------- payload
  const targetStaffId = request.targetStaffId ?? null;
  let broadcast = null;
  if (request.inline) {
    broadcast = {
      id: request.broadcastId ?? null,
      title: request.inline.title,
      message: request.inline.message,
      audience: request.inline.audience,
      url: request.inline.url,
      requiresAction: request.inline.requiresAction,
    };
  } else {
    let query = db
      .from('broadcasts')
      .select('id, title, message, audience, pushed_at')
      .order('created_at', { ascending: false })
      .limit(5);

    if (request.broadcastId) query = query.eq('id', request.broadcastId);
    else query = query.is('pushed_at', null);

    const { data, error } = await query;
    if (error) return fail(res, 502, 'broadcasts_unreadable', error.message);
    if (!data || data.length === 0) {
      console.log(`${TAG} nothing to send`, { source: request.source, broadcastId: request.broadcastId });
      return res.status(200).json({ ok: true, sent: 0, reason: 'nothing_pending' });
    }
    broadcast = data[0];
  }

  const payload = payloadFor(broadcast);
  console.log(`${TAG} sending`, {
    source: request.source,
    id: broadcast.id,
    title: payload.title,
    bodyLength: (payload.body || '').length,
  });

  // ---------------------------------------------------------- subscriptions
  // A targeted send goes only to the devices linked to one staff account.
  // `targetStaffId` comes from the Owner's "Specific User" picker; when it is
  // absent every subscription is a candidate, exactly as before.
  let subQuery = db
    .from('push_subscriptions')
    .select('endpoint, p256dh, auth, audience, staff_id');

  if (targetStaffId) subQuery = subQuery.eq('staff_id', targetStaffId);
  subQuery = subQuery.limit(MAX_SENDS);

  const { data: rows, error: rowsError } = await subQuery;

  if (rowsError) return fail(res, 502, 'subscriptions_unreadable', rowsError.message);

  const total = rows ? rows.length : 0;
  // "Specific User" means this is a category filter of "Everyone" as far as the
  // rows are concerned. `syncSubscription()` writes p_audience: 'Everyone' on
  // every device, and the target itself has already been applied above by the
  // staff_id filter. Left in place, the third clause below compared
  // broadcast.audience ('Specific User') against r.audience ('Everyone') for
  // every row, matched nothing, and reported `no_subscribers` for a send whose
  // target had exactly one device.
  const categoryAudience =
    !broadcast.audience || broadcast.audience === 'Everyone'
      ? null
      : broadcast.audience;

  const usable = (rows || []).filter(
    (r) =>
      r.endpoint && r.p256dh && r.auth &&
      (!categoryAudience || r.audience === categoryAudience)
  );
  const skipped = total - usable.length;

  console.log(`${TAG} subscriptions`, {
    targeted: Boolean(targetStaffId),
    rows: total,
    usable: usable.length,
    skipped,
    reason: skipped ? 'missing keys or audience mismatch' : 'none'
  });

  // ----------------------------------------------------------------- send
  const dead = [];
  let sent = 0;
  const failed = [];

  await Promise.all(
    usable.map(async (row) => {
      const subscription = {
        endpoint: row.endpoint,
        keys: { p256dh: row.p256dh, auth: row.auth },
      };
      try {
        await webpush.sendNotification(subscription, JSON.stringify(payload), {
          TTL: 60 * 60 * 12,
          urgency: 'normal',
        });
        sent += 1;
      } catch (error) {
        const status = error.statusCode || (error.status ? Number(error.status) : 0);
        console.warn(`${TAG} send failed`, {
          endpoint: String(row.endpoint).slice(-60),
          status,
          message: error.message
        });
        if (status === 404 || status === 410) dead.push(row.endpoint);
        else failed.push({ endpoint: row.endpoint, status, message: error.message });
      }
    })
  );

  // -------------------------------------------------- prune dead endpoints
  let pruned = 0;
  if (dead.length) {
    const { data: prunedRows, error: pruneError } = await db.rpc('wire_forget_devices', {
      p_endpoints: dead
    });
    if (pruneError) {
      console.error(`${TAG} prune failed`, pruneError.message);
    } else {
      pruned = prunedRows || 0;
      console.log(`${TAG} pruned ${pruned} dead endpoints`);
    }
  }

  // ------------------------------------------------- mark the row as pushed
  // A direct update is fine: this runs as service_role, and the sender must not
  // touch the row when the push failed, or the cron will never retry it.
  if (broadcast.id && sent > 0) {
    const { error: markError } = await db
      .from('broadcasts')
      .update({ pushed_at: new Date().toISOString(), delivered_count: sent })
      .eq('id', broadcast.id);
    if (markError) console.error(`${TAG} could not mark pushed`, markError.message);
  }

  console.log(`${TAG} done`, { sent, pruned, failed: failed.length, skipped });

  // Distinguish "that person has no device" from "your devices have no keys".
  // The two look identical from the panel otherwise, and only one is fixable by
  // the Owner: the first needs the recipient to open the site and allow alerts.
  const targeted = Boolean(targetStaffId);
  const zeroReason =
    sent > 0 ? null
      : total === 0
        ? (targeted ? 'target_has_no_devices' : 'no_subscriptions')
        : 'no_usable_subscriptions';

  return res.status(200).json({
    ok: true,
    sent,
    pruned,
    skipped,
    failed: failed.slice(0, 10),
    broadcastId: broadcast.id,
    targeted,
    // How many devices the staff_id filter matched before the key check. Echoed
    // so a targeted send that found the right devices but could not use them is
    // visibly different from one that never found the person at all.
    matched: total,
    reason: zeroReason,
    // Echoed so the Owner Panel can report exactly what went out, rather than
    // guessing from its own (possibly stale) device count.
    title: payload.title,
    delivered: sent,
  });
}
