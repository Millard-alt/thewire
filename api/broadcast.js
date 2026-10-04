/* =============================================================================
   api/broadcast.js — alias for api/send-push.js
   -----------------------------------------------------------------------------
   The Owner Panel's custom broadcast form posts to `/api/broadcast`, which reads
   better at the call site than `/api/send-push` and matches the route the panel
   was already written against. Both routes are the same handler; there is one
   implementation of the delivery logic, deliberately.
   ========================================================================== */

import handler from './send-push.js';

export default handler;