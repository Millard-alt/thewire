/**
 * THE PULSE - OneSignal push sender.
 *
 * Sends a push notification through the OneSignal REST API to a single user
 * identified by their external user id. Used by the Owner Panel's approval
 * workflow (account approval, portrait approval) to tell a staffer that their
 * request has been actioned.
 *
 * AUTHENTICATION
 *   Same gate as api/send-push.js: either PUSH_SEND_TOKEN as a Bearer token
 *   (server-to-server / cron) or a valid Owner session presented in the
 *   `x-wire-token` header. The Owner seat is re-checked server-side through
 *   `wire_session_diagnostic()`, so a non-Owner cannot spam arbitrary users.
 *
 * ENVIRONMENT
 *   ONESIGNAL_APP_ID          - the OneSignal app id (public-ish, but read here)
 *   ONESIGNAL_REST_API_KEY    - the REST API key (server-only secret)
 *   VITE_SUPABASE_URL / SUPABASE_URL
 *   VITE_SUPABASE_ANON_KEY / SUPABASE_ANON_KEY   (for the owner-session check)
 */
import { createClient } from '@supabase/supabase-js';

const TAG = '[api/send-onesignal]';
const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '';
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.VITE_SUPABASE_ANON_KEY ||
  '';
const ONESIGNAL_APP_ID = process.env.ONESIGNAL_APP_ID || process.env.VITE_ONESIGNAL_APP_ID || '';
const ONESIGNAL_REST_API_KEY = process.env.ONESIGNAL_REST_API_KEY || '';
const PUSH_TOKEN = process.env.PUSH_SEND_TOKEN || '';

function fail(res, status, code, detail) {
  console.error(`${TAG} ${code}`, detail || '');
  return res.status(status).json({ ok: false, code, detail: detail || null });
}

async function isOwnerSession(req, ownerCheck) {
  const token = req.headers['x-wire-token'] || req.headers['X-Wire-Token'];
  if (!token || !ownerCheck) return false;
  try {
    const { data, error } = await ownerCheck.rpc('wire_session_diagnostic');
    if (error) return false;
    return Boolean(data && data.session_resolved && data.is_owner);
  } catch {
    return false;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return fail(res, 405, 'method_not_allowed', 'Use POST.');
  }

  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const tokenAuthed = Boolean(PUSH_TOKEN) && bearer === PUSH_TOKEN;

  const ownerAnonKey = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '';
  let ownerCheck = null;
  if (ownerAnonKey && SUPABASE_URL) {
    ownerCheck = createClient(SUPABASE_URL, ownerAnonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        fetch: (input, init = {}) => {
          const headers = new Headers(init.headers || {});
          const t = req.headers['x-wire-token'] || req.headers['X-Wire-Token'];
          if (t) headers.set('x-wire-token', t);
          return fetch(input, { ...init, headers });
        }
      }
    });
  }

  if (!tokenAuthed && !(await isOwnerSession(req, ownerCheck))) {
    return fail(res, 401, 'unauthorised', 'Owner session or push token required.');
  }

  if (!ONESIGNAL_APP_ID || !ONESIGNAL_REST_API_KEY) {
    return fail(res, 503, 'onesignal_not_configured', 'ONESIGNAL_APP_ID / ONESIGNAL_REST_API_KEY must be set in Vercel.');
  }

  const body = req.body || {};
  const externalId = String(body.externalId || body.external_id || '').trim();
  const title = String(body.title || '').trim();
  const message = String(body.message || body.body || '').trim();

  if (!externalId) return fail(res, 400, 'missing_external_id', 'externalId is required.');
  if (!title) return fail(res, 400, 'missing_title', 'title is required.');

  try {
    const response = await fetch('https://onesignal.com/api/v1/notifications', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${ONESIGNAL_REST_API_KEY}`
      },
      body: JSON.stringify({
        app_id: ONESIGNAL_APP_ID,
        include_external_user_ids: [externalId],
        headings: { en: title },
        contents: { en: message || title }
      })
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return fail(res, 502, 'onesignal_error', data?.errors || data?.message || response.statusText);
    }
    return res.status(200).json({ ok: true, id: data?.id || null, recipients: data?.recipients ?? null });
  } catch (error) {
    return fail(res, 502, 'onesignal_fetch_failed', error?.message || String(error));
  }
}
