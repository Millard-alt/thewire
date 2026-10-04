// =============================================================================
//  api/check-deadlines.js - HOURLY DEADLINE REMINDERS
// -----------------------------------------------------------------------------
//  Invoked by Vercel Cron (see vercel.json). Finds assignments whose deadline is
//  approaching, and pushes a reminder to the devices belonging to the person it
//  was assigned to.
//
//  GET  /api/check-deadlines                       run a pass, window = 24h
//  POST /api/check-deadlines { withinHours: 48 }   owner-initiated / test
//
//  Authenticated with PUSH_SEND_TOKEN, same as /api/send-push. Vercel Cron sends
//  CRON_SECRET as `Authorization: Bearer ...` when CRON_SECRET is set, so both
//  are accepted.
//
//  Why the flag is set inside SQL
//    `wire_claim_due_reminders()` marks rows `reminder_sent = true` in the same
//    statement that returns them (`for update skip locked`). That makes the
//    claim safe against overlapping cron invocations, but it also means a send
//    that then fails has already consumed the reminder. This handler therefore
//    RE-OPENS the flag when an assignment produced no delivered push, so the
//    next pass retries instead of silently losing the alert.
// =============================================================================

import webpush from 'web-push';
import { createClient } from '@supabase/supabase-js';

const TAG = '[api/check-deadlines]';

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY || '';
const VAPID_PUBLIC = process.env.VITE_VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:melvinjonespressclub@gmail.com';
const PUSH_TOKEN = process.env.PUSH_SEND_TOKEN || '';
const CRON_SECRET = process.env.CRON_SECRET || '';

/** Enough for any realistic hour; keeps a runaway pass inside the function limit. */
const MAX_PER_PASS = 200;

/**
 * Vercel Cron presents CRON_SECRET as a bearer token, but PUSH_SEND_TOKEN is what
 * the rest of the push stack already uses. Accept either so the schedule works
 * whichever secret the project has configured.
 *
 * With neither configured there is nothing to check against, so this refuses
 * rather than leaving an open relay anyone can trigger to spam staff.
 */
function authorised(req) {
  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
  const query = new URL(req.url, 'http://localhost').searchParams.get('token');

  if (CRON_SECRET && (bearer === CRON_SECRET || query === CRON_SECRET)) return true;
  if (PUSH_TOKEN && (bearer === PUSH_TOKEN || query === PUSH_TOKEN)) return true;
  return false;
}

/** Whole hours until the deadline, rounded up, floored at 1 so it never reads "0 hours". */
function hoursUntil(dueAt) {
  const ms = new Date(dueAt).getTime() - Date.now();
  if (!Number.isFinite(ms)) return null;
  return Math.max(1, Math.ceil(ms / 3_600_000));
}

export default async function handler(req, res) {
  console.log(`${TAG} invoked`, {
    method: req.method,
    hasPushToken: Boolean(PUSH_TOKEN),
    hasCronSecret: Boolean(CRON_SECRET)
  });

  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ ok: false, code: 'method_not_allowed' });
  }

  if (!authorised(req)) {
    return res.status(401).json({
      ok: false,
      code: 'unauthorised',
      detail: PUSH_TOKEN || CRON_SECRET
        ? 'Present the CRON_SECRET or PUSH_SEND_TOKEN as a bearer token.'
        : 'No CRON_SECRET or PUSH_SEND_TOKEN is configured, so this endpoint refuses all callers.'
    });
  }

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ ok: false, code: 'no_supabase_env' });
  }
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
    return res.status(500).json({ ok: false, code: 'no_vapid_keys' });
  }

  let withinHours = 24;
  if (req.method === 'POST') {
    try {
      const raw = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
      const requested = Number(raw.withinHours);
      // Bound the window. An unbounded value would claim every future assignment.
      if (Number.isFinite(requested) && requested > 0) {
        withinHours = Math.min(Math.round(requested), 24 * 14);
      }
    } catch {
      /* keep the 24h default */
    }
  }

  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
  const db = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  // --------------------------------------------------------- claim the work
  // Claiming and flagging are one atomic statement, so two concurrent passes can
  // never pick up the same assignment.
  const { data: due, error: claimError } = await db.rpc('wire_claim_due_reminders', {
    p_within_hours: withinHours
  });

  if (claimError) {
    // The most likely cause is that migration 021 has not been run yet.
    console.error(`${TAG} claim failed`, claimError.message);
    return res.status(502).json({ ok: false, code: 'claim_failed', detail: claimError.message });
  }

  const assignments = due || [];
  console.log(`${TAG} claimed ${assignments.length} due assignment(s)`, { withinHours });

  if (assignments.length === 0) {
    return res.status(200).json({ ok: true, due: 0, reminded: 0, withinHours });
  }

  const batch = assignments.slice(0, MAX_PER_PASS);
  let reminded = 0;
  let failed = 0;
  const requeued = [];

  for (const item of batch) {
    const hours = hoursUntil(item.due_at);

    // No usable deadline means we cannot phrase the reminder; do not spend a
    // notification on it, but leave the flag alone so it is not silently lost.
    if (hours === null) {
      failed += 1;
      requeued.push(item.assignment_id);
      continue;
    }

    // Only this person's devices, not the whole subscriber list.
    const { data: rows, error: rowsError } = await db
      .from('push_subscriptions')
      .select('endpoint, p256dh, auth')
      .eq('staff_id', item.staff_id);

    if (rowsError) {
      console.error(`${TAG} subscriptions unreadable`, rowsError.message);
      failed += 1;
      requeued.push(item.assignment_id);
      continue;
    }

    const usable = (rows || []).filter((r) => r.endpoint && r.p256dh && r.auth);

    // Nobody to tell, or nobody reachable. Not an error: this account simply has
    // no push-capable device yet.
    if (usable.length === 0) {
      console.log(`${TAG} no pushable device for assignment ${item.assignment_id}`);
      continue;
    }

    const payload = JSON.stringify({
      title: 'Assignment Deadline Approaching',
      body: `"${item.assignment_title}" is due in ${hours} hour${hours === 1 ? '' : 's'}.`,
      icon: '/icons/icon-192.png',
      url: '/',
      tag: `assignment-deadline-${item.assignment_id}`,
      requireInteraction: true
    });

    let delivered = 0;
    const dead = [];

    await Promise.all(
      usable.map(async (row) => {
        try {
          await webpush.sendNotification(
            { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
            payload,
            { TTL: 60 * 60 * 6, urgency: 'normal' }
          );
          delivered += 1;
        } catch (error) {
          const status = error.statusCode || (error.status ? Number(error.status) : 0);
          console.warn(`${TAG} reminder send failed`, { status, message: error.message });
          if (status === 404 || status === 410) dead.push(row.endpoint);
        }
      })
    );

    if (dead.length) {
      await db.rpc('wire_forget_devices', { p_endpoints: dead }).catch(() => {});
    }

    if (delivered > 0) {
      reminded += 1;
    } else {
      // Every attempt failed. Undo the claim so the next pass retries rather
      // than treating the assignment as already reminded.
      failed += 1;
      requeued.push(item.assignment_id);
    }
  }

  // Anything claimed beyond MAX_PER_PASS has been flagged but not sent, so
  // re-open those too, otherwise they are lost for good. Slice the FULL set, not
  // `batch`, which is already capped and would always yield nothing here.
  for (const item of assignments.slice(MAX_PER_PASS)) requeued.push(item.assignment_id);

  if (requeued.length) {
    // service_role bypasses RLS, so a direct update is permitted here.
    const { error } = await db
      .from('assignments')
      .update({ reminder_sent: false })
      .in('id', requeued);
    if (error) {
      console.error(`${TAG} could not requeue ${requeued.length} assignment(s)`, error.message);
    }
  }

  console.log(`${TAG} done`, { due: assignments.length, reminded, failed, requeued: requeued.length });

  return res.status(200).json({
    ok: true,
    due: assignments.length,
    reminded,
    failed,
    requeued: requeued.length,
    withinHours
  });
}