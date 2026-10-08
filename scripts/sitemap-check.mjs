/**
 * Validate public/sitemap.xml.
 *
 * The failure this exists to catch: an XML comment may not contain `--` anywhere
 * in its body. The previous sitemap carried a comment explaining why no fragment
 * appears in it, and that comment contained the literal `/#about` plus several
 * em-dash-ruled sentences -- so Google Search Console rejected the file with a
 * syntax error, and the reason was invisible in most editors because a comment is
 * still valid XML *shape* while being invalid by the spec.
 *
 *   node scripts/sitemap-check.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.cwd());

const FILE = 'public/sitemap.xml';
const raw = readFileSync(FILE, 'utf8');

/**
 * Every file the public domain is allowed to appear in.
 *
 * Deliberately NOT a whole-tree scan of every `.md`. The repository contains
 * `users.thewire.press` -- the hidden shadow-email domain, documented in DEPLOY.md
 * as never changing once accounts exist -- and rewriting that to chase a substring
 * would lock every staffer out of their login to change nothing an indexer sees.
 * A service-worker cache name, a temp-directory prefix and this checker's own
 * mutation fixture are in the same category: they contain the word without being
 * a URL.
 */
const DOMAIN_SCAN = [
  'index.html',
  'vercel.json',
  'package.json',
  'CNAME',
  'public/robots.txt',
  'public/manifest.webmanifest',
  'public/sitemap.xml',
  'public/sw.js'
];
for (const dir of ['src', 'scripts']) {
  for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    if (entry.isFile() && /\.(js|mjs|css)$/.test(entry.name)) {
      DOMAIN_SCAN.push(path.join(dir, entry.name));
    }
  }
}

let problems = 0;
const fail = (msg) => {
  problems += 1;
  console.log(`  FAIL ${msg}`);
};

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`);
};

/* 1. No comments at all, and specifically no `--` anywhere outside a tag ----- */
const comments = raw.match(/<!--[\s\S]*?-->/g) || [];
check('no XML comments', comments.length === 0, `${comments.length} found`);
if (comments.length) {
  fail(
    `found ${comments.length}: ` +
      comments.map((c) => JSON.stringify(c.slice(0, 60))).join(', ')
  );
}

// The bare `--` count matters independently of the comment regex, because a
// stray `--` in prose outside any comment is what a spec-strict parser objects
// to first.
const bareDoubleHyphen = (raw.match(/--/g) || []).length;
check('no `--` anywhere in the file', bareDoubleHyphen === 0, `${bareDoubleHyphen} occurrence(s)`);
if (bareDoubleHyphen) fail(`found ${bareDoubleHyphen} occurrence(s) of --`);

/* 2. Declaration and root -------------------------------------------------------- */
check('declares XML 1.0 with UTF-8', /^<\?xml version="1\.0" encoding="UTF-8"\?>/.test(raw.trim()));
check(
  'root is a urlset in the sitemaps.org namespace',
  /<urlset\s+xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9"\s*>/.test(raw)
);

/* 3. Every element balanced, in order ------------------------------------------- */
const OPEN = /<(\/?)([a-z]+)([^>]*?)(\/?)>/g;
const stack = [];
let m;
while ((m = OPEN.exec(raw))) {
  const [, closing, name, , selfClosing] = m;
  if (closing === '/') {
    const top = stack.pop();
    if (top !== name) fail(`</${name}> closes <${top}>`);
  } else if (!selfClosing) {
    stack.push(name);
  }
}
check('every element is balanced', stack.length === 0, stack.length ? `unclosed: ${stack}` : '');

/* 4. Every url has the three required children --------------------------------- */
const urls = [...raw.matchAll(/<url>([\s\S]*?)<\/url>/g)].map((x) => x[1]);
check('exactly six <url> entries', urls.length === 6, `${urls.length} found`);

for (const [i, body] of urls.entries()) {
  const loc = /<loc>([^<]+)<\/loc>/.exec(body)?.[1] ?? '';
  const freq = /<changefreq>([^<]+)<\/changefreq>/.exec(body)?.[1] ?? '';
  const pri = /<priority>([^<]+)<\/priority>/.exec(body)?.[1] ?? '';
  check(
    `url ${i + 1} (${loc}) has loc, changefreq and priority`,
    Boolean(loc && freq && pri),
    `changefreq="${freq}" priority="${pri}"`
  );
  // The root is `https://host/` -- a bare host with no path is not the same URL,
  // and this pattern has to accept the trailing slash or it fails on entry one.
  if (!/^https:\/\/thepulse\.us\.ci(\/[\w-]+)*\/?$/.test(loc)) {
    fail(`url ${i + 1} loc is not a bare absolute URL on the canonical host: ${loc}`);
  }
  if (!/^(always|hourly|daily|weekly|monthly|yearly|never)$/.test(freq)) {
    fail(`url ${i + 1} changefreq is not in the allowed set: ${freq}`);
  }
  if (!/^(0\.\d|1\.0)$/.test(pri)) {
    fail(`url ${i + 1} priority is out of range: ${pri}`);
  }
}

/* 5. No fragment, and no duplicates -------------------------------------------- */
check('no fragment in any URL', !raw.includes('#'));
const locs = [...raw.matchAll(/<loc>([^<]+)<\/loc>/g)].map((x) => x[1]);
check('no duplicate URLs', new Set(locs).size === locs.length, `${locs.length} urls`);

/* 6. Every loc is a route the app can actually serve --------------------------- */
const app = readFileSync('src/app.js', 'utf8');
const vercel = JSON.parse(readFileSync('vercel.json', 'utf8'));
const rewrites = new Set((vercel.rewrites || []).map((r) => r.source));

for (const loc of locs) {
  const path = new URL(loc).pathname;
  if (path === '/') continue;
  check(
    `${path} has a rewrite in vercel.json, or it is the root`,
    rewrites.has(path),
    'a sitemap listing a URL that 404s gets the domain flagged in Search Console'
  );
  const key = path.replace(/\/$/, '') || '/';
  check(
    `${path} is a route PATH_ROUTES knows`,
    app.includes(`'${key}':`) || app.includes('ASSIGNMENTS_PATH'),
    `PATH_ROUTES in src/app.js has no '${key}' entry`
  );
}

/* 7. The host agrees with the canonical tag AND the CNAME ------------------- */
const indexHtml = readFileSync('index.html', 'utf8');
const canonical = /<link rel="canonical" href="https:\/\/([^/"]+)/.exec(indexHtml)?.[1];
const host = new URL(locs[0]).host;
check(
  'the canonical tag and the sitemap agree on the host',
  canonical === host,
  `canonical=${canonical} sitemap=${host}`
);

/*
 * CNAME, because it is where the domain actually LIVES.
 *
 * This is the file that drifted. Every SEO artifact had been moved to
 * thepulse.us.ci while CNAME still read thewire.us.ci, which is the worst shape
 * the configuration can take: the sitemaps told Google one host and the
 * deployment told it another. A check that only compared the SEO files to each
 * other would have passed throughout, because they all agreed -- with each other,
 * and not with the domain.
 */
let cname = null;
try {
  cname = readFileSync('CNAME', 'utf8').trim();
} catch {
  fail('CNAME is missing, so nothing declares the canonical host');
}
if (cname !== null) {
  check('CNAME declares the same host as the sitemap', cname === host, `CNAME=${cname} sitemap=${host}`);
}

/* 8. Nothing in the SEO surface still names the old domain ------------------ */
const OLD_HOST = 'thewire.us.ci';

/*
 * Two files MUST name the old host, and exempting them is the point rather than a
 * loophole: a check that detects a string cannot avoid containing it. This one
 * holds the constant, and `sitemap-selfcheck.mjs` mutates a URL to the old domain
 * to prove the check bites. Without the exemption the check reports itself on
 * every run, and a check that is permanently red about its own source is one
 * somebody turns off.
 */
const EXEMPT = new Set(['scripts/sitemap-check.mjs', 'scripts/sitemap-selfcheck.mjs']);

// Compared with forward slashes on both sides: `path.join` emits a backslash on
// Windows and a slash elsewhere, so a set written with the wrong separator
// matches on one platform and silently stops matching on the other.
const normalised = (rel) => rel.replace(/\\/g, '/');

const offenders = DOMAIN_SCAN.filter((rel) => {
  if (EXEMPT.has(normalised(rel))) return false;
  try {
    return readFileSync(path.join(ROOT, rel), 'utf8').includes(OLD_HOST);
  } catch {
    return false;
  }
});
check(
  `no file in the SEO surface still names ${OLD_HOST}`,
  offenders.length === 0,
  offenders.join(', ')
);

/*
 * THE EXIT CODE IS DERIVED FROM THE CHECKS, NOT ONLY FROM fail().
 *
 * The first version of this file called check() for most assertions and never
 * raised, so the self-check saw exit 0 for an unbalanced document and for a URL
 * with no rewrite behind it -- both of which the output printed as FAIL and the
 * process reported as success. A checker that prints the failure and then exits
 * green is worse than no checker, because a caller watching the exit code learns
 * to trust it wrongly.
 */
const failed = checks.filter((c) => !c.ok).length;
const passed = checks.length - failed;
console.log(`\n${passed} passed, ${failed} failed`);
if (problems) console.log(`${problems} problem(s) raised`);
process.exit(problems || failed ? 1 : 0);