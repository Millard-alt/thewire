/* =============================================================================
   api/_security.js — SECURITY HEADERS FOR EVERY API RESPONSE
   -----------------------------------------------------------------------------
   These serverless routes previously returned JSON with NO security headers at
   all: no CSP, no nosniff, no frame options. Static documents get their headers
   from vercel.json (`headers` on `/(.*)`), but nothing guaranteed the same on
   the function responses, so every handler now applies this set first thing.

   The Content-Security-Policy here is the SAME string as vercel.json's — keep
   the two in sync. It is the allowlist of the third parties this site actually
   loads (fonts.googleapis.com / fonts.gstatic.com, cdn.onesignal.com,
   api.onesignal.com, the iguzwwqjufzzdblkqroj Supabase project, YouTube embeds,
   owner-curated https image/audio hosts) and it carries no wildcard origins,
   no 'unsafe-inline', and a default-src 'self' fallback. The one 'unsafe-hashes'
   hash pins the exact inline `onload` media-swap attribute on the Google Fonts
   stylesheet; the image-fallback `onerror` attributes were replaced with a
   delegated listener, so no other inline script surface exists.

   On a JSON response these are cheap and satisfy header scanners; the values
   only take effect in a browser when the response is navigated to as a
   document, so they cannot break `fetch()` callers.
   ========================================================================== */

const CSP =
  "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'self'; " +
  "img-src 'self' https: data: blob:; media-src 'self' https: blob:; " +
  "font-src 'self' https://fonts.gstatic.com; style-src 'self' https://fonts.googleapis.com; " +
  "script-src 'self' https://cdn.onesignal.com 'unsafe-hashes' " +
  "'sha256-p5PnWJvMOnsZyLjxblLBMDwBfOASHA7CQcLYb5mwepY='; " +
  "connect-src 'self' https://iguzwwqjufzzdblkqroj.supabase.co " +
  "wss://iguzwwqjufzzdblkqroj.supabase.co https://api.onesignal.com https://onesignal.com; " +
  "worker-src 'self' https://cdn.onesignal.com; manifest-src 'self'; " +
  "frame-src 'self' https://www.youtube-nocookie.com https://www.youtube.com; " +
  'upgrade-insecure-requests';

/**
 * Set every security header this project wants on an API response.
 *
 * Call it at the top of a handler, before any await: headers set on the Node
 * response object are flushed with the final `res.json(...)`, so one call per
 * request is enough no matter which branch returns.
 *
 * @param {import('http').ServerResponse} res
 */
export function applySecurityHeaders(res) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
}
