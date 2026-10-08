/* =============================================================================
   scripts/seo-check.mjs — WHAT A CRAWLER SEES
   -----------------------------------------------------------------------------
   Search engines index the HTML they receive. They do not run the app, so every
   claim this site makes about itself has to be true in index.html as served --
   not in the DOM the client paints afterwards. That gap is easy to create: the
   masthead text, the title and the description are all overwritten at runtime
   from site_settings, so an edit to the database can silently contradict the
   markup.

   This asserts the static markup, which is the half that actually gets indexed.

   Run:  npm run test:seo
   ========================================================================== */

import { readFileSync } from 'node:fs';

const problems = [];
const ok = (m) => console.log('PASS  ' + m);
const bad = (m) => { problems.push(m); console.log('FAIL  ' + m); };

const html = readFileSync('index.html', 'utf8');
const robots = readFileSync('public/robots.txt', 'utf8');
const sitemap = readFileSync('public/sitemap.xml', 'utf8');

const meta = (attr, key) => {
  const re = new RegExp(`<meta[^>]*${attr}="${key}"[^>]*content="([^"]*)"`, 'i');
  const m = html.match(re);
  return m ? m[1] : null;
};

// ---------------------------------------------------------------------------
console.log('--- 1. title + description --------------------------------------');

{
  const title = (html.match(/<title>([^<]*)<\/title>/) || [])[1] || '';
  if (title === 'The Pulse | Melvin Jones Press Club') ok(`title is exactly "${title}"`);
  else bad(`title is "${title}", expected "The Pulse | Melvin Jones Press Club"`);
}

{
  const d = meta('name', 'description');
  if (!d) bad('no meta description');
  else {
    for (const term of ['The Pulse', 'Melvin Jones', 'Press Club']) {
      if (d.includes(term)) ok(`description contains "${term}"`);
      else bad(`description is missing "${term}"`);
    }
    // It has to say what the site IS, not just repeat the name.
    if (/publication|news|independent/i.test(d)) ok('description states what the site is');
    else bad('description does not say what the site is');
    if (d.length > 300) bad(`description is ${d.length} chars; Google truncates around 160`);
    else ok(`description is ${d.length} chars`);
  }
}

// ---------------------------------------------------------------------------
console.log('\n--- 2. visible text: h1 + MJLA spelled out ---------------------');

{
  const h1 = (html.match(/<h1[\s\S]*?<\/h1>/) || [''])[0];
  const text = h1.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (/Melvin\s+Jones\s+Press\s+Club/i.test(text)) {
    ok(`h1 carries "Melvin Jones Press Club" as visible text: "${text}"`);
  } else {
    bad(`h1 does not contain "Melvin Jones Press Club". It reads: "${text}"`);
  }
  if (/The\s+Pulse/i.test(text)) ok('h1 names the publication');
  else bad('h1 does not name the publication');
}

{
  // The acronym must be expanded somewhere a reader can see, not left bare.
  const body = html.replace(/<head[\s\S]*?<\/head>/i, '');
  const text = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  if (/Melvin Jones Lions Academy/i.test(text)) {
    ok('MJLA is spelled out in the visible page text');
  } else {
    bad('MJLA is never expanded in the page text -- a reader cannot tell what it stands for');
  }
  if (/\(MJLA\)/.test(text)) ok('the expanded form is tied to the acronym, not just dropped in');
  else bad('the MJLA expansion is not shown next to the acronym');
}

// ---------------------------------------------------------------------------
console.log('\n--- 3. Open Graph + Twitter Card --------------------------------');

const REQUIRED = [
  ['property', 'og:title'],
  ['property', 'og:description'],
  ['property', 'og:image'],
  ['property', 'og:url'],
  ['property', 'og:type'],
  ['name', 'twitter:card']
];

for (const [attr, key] of REQUIRED) {
  const v = meta(attr, key);
  if (!v) bad(`${key} is missing`);
  else if (key === 'og:image' || key === 'twitter:image') {
    if (/^https:\/\//.test(v)) ok(`${key} is absolute (relative paths are ignored by Facebook/X)`);
    else bad(`${key} is "${v}" -- it must be an absolute URL`);
  } else ok(`${key} = ${v.length > 70 ? v.slice(0, 70) + '...' : v}`);
}

{
  const card = meta('name', 'twitter:card');
  if (card === 'summary_large_image') ok('twitter:card is summary_large_image (uses the 1200x630 crop)');
  else bad(`twitter:card is "${card}", expected summary_large_image`);
}

// ---------------------------------------------------------------------------
console.log('\n--- 4. og-image is real and the right size ------------------------');

{
  try {
    const buf = readFileSync('public/og-image.png');
    const w = buf.readUInt32BE(16);
    const h = buf.readUInt32BE(20);
    if (w === 1200 && h === 630) ok(`public/og-image.png is ${w}x${h}`);
    else bad(`public/og-image.png is ${w}x${h}, expected 1200x630`);
  } catch {
    bad('public/og-image.png is missing (regenerate: npm run build:og)');
  }

  const url = meta('property', 'og:image') || '';
  if (url.startsWith('https://thepulse.us.ci/')) {
    ok('og:image is served from this site, not a third-party image host');
  } else bad(`og:image points off-site: ${url}`);
}

// ---------------------------------------------------------------------------
console.log('\n--- 5. Organization JSON-LD --------------------------------------');

{
  const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (!m) bad('no Organization JSON-LD block');
  else {
    let j = null;
    try { j = JSON.parse(m[1]); ok('JSON-LD is valid JSON'); }
    catch (e) { bad(`JSON-LD does not parse: ${e.message}`); }

    if (j) {
      if (j['@type'] === 'Organization') ok('@type is Organization');
      else bad(`@type is "${j['@type']}", expected Organization`);

      if (j.name === 'The Pulse') ok('name is "The Pulse"');
      else bad(`name is "${j.name}", expected "The Pulse"`);

      if (j.alternateName === 'The Pulse Melvin Jones Press Club') {
        ok('alternateName is "The Pulse Melvin Jones Press Club"');
      } else bad(`alternateName is "${j.alternateName}"`);

      if (j.url === 'https://thepulse.us.ci/') ok(`url is ${j.url}`);
      else bad(`url is "${j.url}"`);

      if (typeof j.logo === 'string' && j.logo.startsWith('https://')) ok(`logo is absolute: ${j.logo}`);
      else bad(`logo is "${j.logo}" -- it must be an absolute URL`);
    }
  }
}

// ---------------------------------------------------------------------------
console.log('\n--- 6. crawlability ---------------------------------------------');

{
  if (/^User-agent:\s*\*/m.test(robots)) ok('robots.txt has a User-agent group');
  else bad('robots.txt has no User-agent group');

  if (/^Allow:\s*\/\s*$/m.test(robots)) ok('robots.txt allows the site root');
  else bad('robots.txt does not Allow /');

  const sm = (robots.match(/^Sitemap:\s*(\S+)/m) || [])[1];
  if (!sm) bad('robots.txt has no Sitemap directive');
  else if (/^https:\/\//.test(sm)) ok(`Sitemap directive is absolute: ${sm}`);
  else bad(`Sitemap directive is "${sm}" -- use the absolute URL`);
}

{
  if (/<urlset[\s\S]*<\/urlset>/.test(sitemap)) ok('sitemap.xml is a well-formed urlset');
  else bad('sitemap.xml is not a urlset');

  const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  if (locs.length) ok(`sitemap.xml lists ${locs.length} URLs`);
  else bad('sitemap.xml lists no URLs');

  const foreign = locs.filter((l) => !l.startsWith('https://thepulse.us.ci/'));
  if (foreign.length) bad(`sitemap.xml lists URLs off the canonical host: ${foreign.join(', ')}`);
  else ok('every sitemap URL is on the canonical host thepulse.us.ci');
}

// Nothing may ask a crawler to stay away.
{
  const inHead = (html.match(/<head[\s\S]*?<\/head>/) || [''])[0];
  const robotsMeta = (inHead.match(/<meta[^>]*name="robots"[^>]*content="([^"]*)"/i) || [])[1];
  if (!robotsMeta) bad('no meta robots tag -- state the index policy explicitly');
  else if (/noindex/i.test(robotsMeta)) bad(`meta robots says "${robotsMeta}" -- the site is hidden`);
  else ok(`meta robots is "${robotsMeta}"`);

  if (/noindex/i.test(robots)) bad('robots.txt mentions noindex');
  else ok('robots.txt contains no noindex');

  if (/<meta[^>]*name="robots"[^>]*noindex/i.test(html)) bad('index.html contains a noindex tag');
  else ok('index.html contains no noindex tag');
}

// ---------------------------------------------------------------------------
console.log('\n--- 7. no invented volume/number in anything served --------------');

{
  const served = html + readFileSync('src/lib/seed.js', 'utf8');
  if (/32,?\s*841|CXIV/i.test(served)) {
    bad('the invented "Vol. CXIV - No. 32,841" placeholder is still present');
  } else {
    ok('the invented volume/issue placeholder is gone from index.html and the demo seed');
  }
}

// ---------------------------------------------------------------------------
console.log('\n------------------------------------------------------------------');
if (problems.length) {
  console.log(`${problems.length} problem(s):`);
  for (const p of problems) console.log('  - ' + p);
  process.exit(1);
}
console.log('RESULT: PASS — the static markup matches what a crawler needs.');
console.log('This validates index.html only. The database row that overwrites the');
console.log('masthead at runtime needs migration 036 applied separately.');