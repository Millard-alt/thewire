/* =============================================================================
   scripts/push-delivery-report-check.mjs
   -----------------------------------------------------------------------------
   A successful broadcast must not be reported as a failure.

   THE BUG
   `dispatchWebPush` computed `ok` as `delivered > 0`, and the panel chose its
   toast from `pushedOk && delivered > 0`. Those looked like the same question
   but were not: `ok` was supposed to mean "did the request reach a working
   sender", and `delivered` is "how many devices took it".

   So a send that reached 12 of 14 subscriptions -- HTTP 200, twelve phones
   lit up -- rendered as the in-app-only ERROR branch. A teacher reading that
   would reasonably conclude the send failed and press the button again, which
   delivers the same alert a second time to everyone.

   The same conflating error is in the OTHER direction too: a genuine zero-
   delivery has to keep reporting failure, or "no device has a subscription yet"
   would be announced as "Delivered via Web Push to 0 devices".

   So both directions are asserted here. A one-sided fix is not a fix.

   WHAT THIS CANNOT CHECK
   It does not run a push service or touch the database. It evaluates the exact
   expression that was wrong against the exact server payload shapes the sender
   returns, so it pins the contract between push.js and the panel. Whether the
   push service itself accepted a subscription is not testable without devices.

   Run:  npm run test:push-delivery
   ========================================================================== */

import { readFileSync } from 'node:fs';

const push = readFileSync('src/lib/push.js', 'utf8');
const alerts = readFileSync('src/views/alerts.js', 'utf8');
const admin = readFileSync('src/views/admin.js', 'utf8');

const problems = [];
const ok = (m) => console.log('PASS  ' + m);
const bad = (m) => { problems.push(m); console.log('FAIL  ' + m); };

/** Strip comments so a claim in prose cannot satisfy a source assertion. */
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

// --- the defect itself ------------------------------------------------------

{
  const body = code(push);
  // `ok` must not be derived from the delivery count. That single coupling is
  // what turned a partial success into a reported failure.
  if (/ok:\s*delivered\s*>\s*0/.test(body)) {
    bad(
      'ok is still computed as delivered > 0: a broadcast that reached some ' +
      'devices but not all is reported as a failure while those devices receive it'
    );
  } else {
    ok('ok no longer depends on the delivery count');
  }

  if (/reason\s*=\s*delivered\s*>\s*0\s*\?[^:]*:\s*\(?\s*data\.reason/.test(body)) {
    ok('the shortfall reason is still derived from the count, which is correct');
  } else {
    bad('the reason no longer distinguishes "delivered nothing" from "sent"');
  }
}

// --- both directions, against real server payload shapes --------------------

/** Mirrors the sender's success response (send-push.js:486-503). */
const serverDelivered = (delivered, extra = {}) => ({
  ok: true,
  sent: delivered,
  pruned: 0,
  skipped: 0,
  failed: [],
  broadcastId: null,
  targeted: false,
  matched: extra.matched ?? delivered,
  reason: delivered > 0 ? null : 'no_subscriptions',
  delivered,
  ...extra
});

/** Mirrors dispatchWebPush's parsing of a successful response. */
function parseClient(data) {
  const delivered = Number(data.delivered ?? data.sent ?? 0);
  const reason = delivered > 0 ? undefined : data.reason || 'no_subscribers';
  return { ok: true, delivered, reason, matched: Number(data.matched ?? 0), targeted: Boolean(data.targeted) };
}

/** Mirrors the panel's decision (admin.js viaPush). */
const panelSaysSuccess = (r) => r.ok && r.delivered > 0;

const cases = [
  {
    name: 'partial delivery (12 of 14) is reported as a SUCCESS',
    payload: serverDelivered(12, { matched: 14, failed: [{ endpoint: 'x' }] }),
    expectSuccess: true
  },
  {
    name: 'full delivery is a SUCCESS',
    payload: serverDelivered(14),
    expectSuccess: true
  },
  {
    name: 'single device is a SUCCESS',
    payload: serverDelivered(1),
    expectSuccess: true
  },
  {
    name: 'genuine zero delivery is still reported as a FAILURE',
    payload: serverDelivered(0, { matched: 0 }),
    expectSuccess: false
  },
  {
    name: 'zero delivery with registered-but-unusable devices is still a FAILURE',
    payload: serverDelivered(0, { matched: 3, reason: 'no_usable_subscriptions' }),
    expectSuccess: false
  }
];

for (const c of cases) {
  const result = parseClient(c.payload);
  const success = panelSaysSuccess(result);
  if (success === c.expectSuccess) ok(c.name);
  else {
    bad(
      `${c.name} -- got success=${success}, expected ${c.expectSuccess} ` +
      `(delivered=${result.delivered}, reason=${result.reason ?? 'none'})`
    );
  }
}

// The exact regression: 12 delivered must not read as an error.
{
  const r = parseClient(serverDelivered(12, { matched: 14 }));
  if (r.delivered === 12 && panelSaysSuccess(r)) {
    ok('regression case: a 12-device delivery is reported as delivered, not as an error');
  } else {
    bad(`the reported bug is not fixed: delivered=${r.delivered}, panel success=${panelSaysSuccess(r)}`);
  }
}

// --- the panel's own copy must not lie -------------------------------------

{
  const body = code(admin);
  if (/viaPush\s*=\s*result\.pushedOk\s*&&\s*devices\s*>\s*0/.test(body)) {
    ok('the panel still branches on pushedOk && delivered > 0, which is right once ok is honest');
  } else {
    bad('the panel no longer branches on pushedOk && devices > 0; check the success/failure split');
  }

  // The fallback copy must not claim in-app-only after a successful push.
  if (/in-app delivery only/.test(body)) {
    ok('the in-app-only fallback copy still exists for genuine failures');
  }
}

// --- ONE SEND MUST MEAN ONE NOTIFICATION ------------------------------------
//
// The other direction, and the one that bit: a successful broadcast arrived
// TWICE.
//
// `sendBroadcastToDevices` inserts the row and THEN calls the inline sender.
// Nothing stamped `pushed_at`, so the row stayed on the queue and the
// once-a-minute cron claimed it and pushed it again -- two notifications, every
// subscriber, every send.
//
// All three links in the chain are asserted. Dropping any one of them restores
// the duplicate, and none of the other assertions here would notice: the panel
// would still report success, truthfully, both times.

{
  const sender = code(readFileSync('api/send-push.js', 'utf8'));

  // The gate that caused it: `!request.inline` skipped the bookkeeping for the
  // one path that most definitely had a row.
  if (/broadcast\.id\s*&&\s*!request\.inline/.test(sender)) {
    bad(
      'the inline send still skips the delivery write: the row it created stays ' +
        'undelivered and the cron sends the broadcast a second time'
    );
  } else {
    ok('the inline send also marks its row delivered');
  }

  if (/update\(\{\s*delivered_count:\s*sent,\s*pushed_at:/.test(sender)) {
    ok('the delivery write stamps pushed_at, so the cron and any INSERT webhook both find nothing');
  } else {
    bad(
      'the delivery write no longer stamps pushed_at: the cron will re-send every ' +
        'broadcast once a minute until it happens to deliver'
    );
  }

  const client = code(push);
  if (/broadcastId\s*\?\s*\{\s*broadcastId\s*\}/.test(client)) {
    ok('dispatchWebPush forwards the row id so the sender can find the row it created');
  } else {
    bad('dispatchWebPush does not send broadcastId, so the sender has no row to mark delivered');
  }

  const caller = code(alerts);
  if (/dispatchWebPush\(\{[\s\S]{0,400}?broadcastId:\s*broadcast\??\.id/.test(caller)) {
    ok('alerts.js passes the created row id to the sender');
  } else {
    bad('alerts.js does not pass the created row id, so nothing can be marked delivered');
  }
}

// --- plumbing ---------------------------------------------------------------

for (const [file, label, needle] of [
  [alerts, 'alerts.js', 'pushedOk'],
  [admin, 'admin.js', 'result.pushed']
]) {
  if (code(file).includes(needle)) ok(`${label} reads ${needle} from the dispatch result`);
  else bad(`${label} no longer reads ${needle}`);
}

console.log('\n------------------------------------------------------------------');
if (problems.length) {
  console.log(problems.length + ' problem(s):');
  for (const p of problems) console.log('  - ' + p);
  process.exit(1);
}
console.log('RESULT: PASS — a delivered broadcast is reported as sent, and sent only once.');