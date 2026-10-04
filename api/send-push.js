/**
 * THE WIRE - web push sender.
 *
 * Until now a "broadcast" was only a row in `public.broadcasts` that every
 * opted-in browser discovered by POLLING. That cannot reach a phone with the app
 * closed, which is the entire point of push. This is the missing server: it loads
 * the newest broadcast, loads every subscription that has real keys, and hands
 * each to `web-push`, which does the ECDH handshake and posts an encrypted
 * payload to the push service (FCM on Android, APNs on iOS).
 *
 * Three ways in:
 *   POST /api/send-push   body { broadcastId } or { title, message }
 *   GET  /api/send-push   flushes anything not yet sent (Vercel Cron)
 *   Supabase Database Webhook on INSERT into public.broadcasts posting
 *   { type: 'INSERT', table: 'broadcasts', record: { id } }
 *
 * Set PUSH_SEND_TOKEN in Vercel and this refuses unauthenticated callers, so a
 * third party cannot use it to spam every subscriber. Unset, it still works but
 * anyone who learns the URL can trigger a send.
 */

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

function authorised(req) {
  if (!PUSH_TOKEN) return true;
  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
  const query = new URL(req.url, 'http://localhost').searchParams.get('token');
  return bearer === PUSH_TOKEN || query === PUSH_TOKEN;
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
  if (body.broadcastId) return { source: 'api', broadcastId: body.broadcastId };
  if (body.title) {
    return {
      source: 'api',
      broadcastId: null,
      inline: { title: body.title, message: body.message || '' },
    };
  }
  return { source: 'api', broadcastId: url.searchParams.get('id') };
}

/** Turn one stored row into the payload shape public/sw.js expects. */
function payloadFor(broadcast) {
  if (broadcast) {
    return {
      title: broadcast.title || 'THE WIRE',
      body: broadcast.message || '',
      url: broadcast.url || '/',
      tag: `wire-${broadcast.id}`,
      broadcastId: broadcast.id,
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

  if (!authorised(req)) {
    return fail(res, 401, 'unauthorised', 'PUSH_SEND_TOKEN mismatch.');
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

  let request;
  try {
    request = await readRequest(req);
  } catch (error) {
    return fail(res, 400, 'bad_body', error.message);
  }

  // ---------------------------------------------------------------- payload
  let broadcast = null;
  if (request.inline) {
    broadcast = {
      id: null,
      title: request.inline.title,
      message: request.inline.message,
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
  const { data: rows, error: rowsError } = await db
    .from('push_subscriptions')
    .select('endpoint, p256dh, auth, audience')
    .limit(MAX_SENDS);

  if (rowsError) return fail(res, 502, 'subscriptions_unreadable', rowsError.message);

  const total = rows ? rows.length : 0;
  const usable = (rows || []).filter(
    (r) => r.endpoint && r.p256dh && r.auth &&
      (!broadcast.audience || broadcast.audience === 'Everyone' || r.audience === broadcast.audience)
  );
  const skipped = total - usable.length;

  console.log(`${TAG} subscriptions`, {
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

  return res.status(200).json({
    ok: true,
    sent,
    pruned,
    skipped,
    failed: failed.slice(0, 10),
    broadcastId: broadcast.id,
  });
}
