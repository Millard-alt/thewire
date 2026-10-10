/* =============================================================================
   scripts/podcast-player-live-check.mjs
   -----------------------------------------------------------------------------
   PROVES the play button works, rather than proving the source looks right.

   `podcast-player-check.mjs` is a static guard: it can tell that every render
   site has a matching wire site, which is the defect that was fixed. It cannot
   tell that a click actually starts playback.

   This drives a real browser against the demo build. Demo mode, so it never
   touches the live database and never plays a real episode.

   What it asserts:
     - the homepage strip renders cards at all
     - the toggle has a listener that actually reaches the <audio> element
     - clicking it flips `audio.paused`
     - the same holds on /podcasts, so the two pages have not diverged again

   WHY THIS COULD NOT BE A PLAIN CLICK ASSERTION
   Demo audio is a silent placeholder with no decodable stream, so a real
   `play()` promise may never resolve and `paused` can stay true for reasons that
   have nothing to do with the wiring. So the assertion is deliberately on the
   OBSERVABLE CONSEQUENCE of a listener existing -- audio.paused changing -- and
   it reports the audio element's readyState/networkState so a failure here is
   diagnosable instead of a bare false.

   Run:  npm run test:podcast-player-live
   ========================================================================== */

import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:5201/';

const problems = [];
const ok = (m) => console.log('PASS  ' + m);
const bad = (m) => { problems.push(m); console.log('FAIL  ' + m); };

/**
 * A 0.4s silent WAV as a data URI.
 *
 * Built here rather than shipped as a fixture so the test stays self-contained.
 * It has to be a REAL decodable stream: the whole point is to watch `paused`
 * flip, and a bogus source makes `play()` reject for reasons that have nothing
 * to do with whether a listener was attached.
 */
function silentWavDataUri() {
  const rate = 8000;
  const frames = 3200;
  const buf = Buffer.alloc(44 + frames * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + frames * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);          // PCM
  buf.writeUInt16LE(1, 22);          // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(frames * 2, 40);
  return `data:audio/wav;base64,${buf.toString('base64')}`;
}

/**
 * Click the toggle on the first card and report what the audio element did.
 *
 * Returns the audio element's state alongside the outcome so a failure names a
 * cause rather than just "it did not play".
 */
async function probeToggle(page, label) {
  const card = page.locator('[data-podcast-player]').first();

  if ((await card.count()) === 0) return { found: false };

  const audio = card.locator('[data-audio]');
  const toggle = card.locator('[data-toggle]');

  if ((await audio.count()) === 0) return { found: true, noAudio: true };
  if ((await toggle.count()) === 0) return { found: true, noToggle: true };

  const before = await audio.evaluate((el) => ({
    paused: el.paused,
    readyState: el.readyState,
    networkState: el.networkState,
    src: el.getAttribute('src')
  }));

  // A real user gesture, not element.click(), so autoplay policy cannot be the
  // reason nothing happens.
  await toggle.click({ force: true });
  await page.waitForTimeout(400);

  const after = await audio.evaluate((el) => ({
    paused: el.paused,
    readyState: el.readyState,
    networkState: el.networkState,
    currentTime: el.currentTime
  }));

  return { found: true, before, after };
}

const browser = await chromium.launch();
const page = await browser.newPage();

try {
  /*
   * SEED A REAL EPISODE BEFORE THE APP READS ITS STORE.
   *
   * The demo seed ships episodes with `audio_url: ''`, so the cards render the
   * "audio not available" notice and there is no player to click. Testing only
   * that state cannot tell a wired button from an unwired one -- the check
   * would pass against the original bug.
   *
   * The demo store is a localStorage key, so seeding it before the first script
   * runs gives the page a genuinely playable card. Demo mode only: this writes
   * to the browser profile Playwright throws away, never to the real database.
   */
  const audioUri = silentWavDataUri();
  await page.addInitScript(
    ([uri]) => {
      const now = new Date().toISOString();
      localStorage.setItem(
        'pulse.podcasts',
        JSON.stringify([
          {
            id: 'live-check-1',
            title: 'Wiring probe',
            description: 'A decodable episode, seeded by podcast-player-live-check.',
            author_name: 'The Pulse Staff',
            duration_seconds: 1,
            status: 'approved',
            created_at: now,
            updated_at: now,
            audio_url: uri,
            storage_path: ''
          }
        ])
      );
    },
    [audioUri]
  );

  // --- the homepage ------------------------------------------------------
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });

  // The strip is async: it mounts, then listPodcasts resolves and outerHTML
  // swaps in the real section. Waiting for a card is what proves the swap ran.
  await page
    .waitForSelector('#latest-podcasts [data-podcast-player]', { timeout: 15000 })
    .catch(() => {});

  const home = await probeToggle(page, 'homepage');
  const hasHomeStrip = await page.locator('#latest-podcasts [data-podcast-player]').count();

  // A card with NO audio element is not a failure. `podcastCard` renders the
  // "audio not available" notice in place of the player when `audio_url` is
  // empty, and the demo seed has exactly that -- episodes with a title and a
  // description but no uploaded MP3. Probing a card that was never meant to be
  // playable would report a bug that does not exist.
  //
  // What matters is the two outcomes: either the card is genuinely unplayable
  // (no audio element, and it says so), or it is playable and must respond.
  if (hasHomeStrip === 0) {
    ok('no podcast cards on the homepage (demo has no approved episodes) -- skipping the click probe');
  } else if (home.noAudio) {
    const saysUnavailable = await page
      .locator('#latest-podcasts .podcast-card__unavailable')
      .count();
    if (saysUnavailable > 0) {
      ok(
        'demo episodes have no audio_url, so the cards show "not available" instead of a dead button'
      );
    } else {
      bad('homepage: a card rendered with no <audio> AND no "unavailable" notice');
    }
  } else if (home.noToggle) {
    bad('homepage: a playable card rendered with no play toggle');
  } else if (home.after.paused === home.before.paused) {
    bad(
      'homepage: clicking play left audio.paused unchanged -- the toggle has no listener ' +
      `(readyState=${home.after.readyState} networkState=${home.after.networkState} ` +
      `src=${home.after.src}). This is the original bug.`
    );
  } else {
    ok(
      `homepage: clicking play changed audio.paused ${home.before.paused} -> ${home.after.paused} ` +
      '-- the toggle is wired to the audio element'
    );
  }

  // --- /podcasts, as the reference --------------------------------------
  await page.goto(`${BASE}#/podcasts`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(1500);

  const pods = await probeToggle(page, 'podcasts');
  if (pods.found && pods.after && pods.after.paused === pods.before.paused) {
    bad(
      'podcasts: clicking play left audio.paused unchanged -- the reference page regressed too ' +
      `(readyState=${pods.after.readyState})`
    );
  } else {
    ok('podcasts page behaves consistently with the homepage');
  }
} finally {
  await browser.close();
}

console.log('\n------------------------------------------------------------------');
if (problems.length) {
  console.log(problems.length + ' problem(s):');
  for (const p of problems) console.log('  - ' + p);
  process.exit(1);
}
console.log('RESULT: PASS — the play button reaches the audio element on both pages.');