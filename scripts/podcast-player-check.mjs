/* =============================================================================
   scripts/podcast-player-check.mjs
   -----------------------------------------------------------------------------
   Every place that emits a podcast card must also wire it.

   `podcastCard()` renders the whole custom transport -- the <audio> element, the
   play/pause toggle, the scrubber, the speed control -- but none of it is
   interactive until `wirePodcastPlayer()` attaches the listeners. The card
   therefore looks perfect and does nothing.

   That is exactly what happened on the homepage: `fillPodcastStrip` emitted the
   cards at line 312 and never wired them, so the play button rendered, the audio
   source was correct, and clicking it did nothing. /podcasts worked because
   `renderPodcastsPage` has always wired its cards.

   The failure is invisible to a screenshot and to a "no console errors" check.
   It is visible to exactly one question, which is the one this file asks: does
   every render site have a matching wire site?

   Run:  npm run test:podcast-player
   ========================================================================== */

import { readFileSync } from 'node:fs';

const src = readFileSync('src/views/public.js', 'utf8');

const problems = [];
const ok = (m) => console.log('PASS  ' + m);
const bad = (m) => { problems.push(m); console.log('FAIL  ' + m); };

// --- the render sites and the wire sites must be in one-to-one correspondence --

const renderSites = [...src.matchAll(/\.map\(\s*podcastCard\s*\)/g)];
const wireSites = [...src.matchAll(/wirePodcastPlayer\)/g)];

if (renderSites.length === 0) {
  bad('no podcastCard call sites found: the file changed shape and this check no longer applies');
} else {
  ok(`found ${renderSites.length} place(s) that render podcast cards`);
}

// `wirePodcastPlayer);` counts only real CALLS. The bare declaration
// `function wirePodcastPlayer(card)` and mentions inside comments do not match,
// because the declaration has a parameter list before the closing paren and
// comments are stripped first.
{
  const real = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const calls = (real.match(/wirePodcastPlayer\)/g) || []).length;
  const renders = (real.match(/\.map\(\s*podcastCard\s*\)/g) || []).length;

  if (calls < renders) {
    bad(
      `${renders} render site(s) but only ${calls} wire site(s): at least one set of ` +
      'cards is emitted without listeners, so its play button does nothing'
    );
  } else {
    ok(`every render site has a wire site (${renders} render, ${calls} wire)`);
  }
}

// --- the homepage specifically. The bug was here, so name it. ----------------

{
  const stripStart = src.indexOf('async function fillPodcastStrip');
  const stripEnd = src.indexOf('\n}', src.indexOf('mount.outerHTML', stripStart));
  const strip = src.slice(stripStart, stripEnd > 0 ? stripEnd : stripStart + 3000);

  if (/\.map\(\s*podcastCard\s*\)/.test(strip)) {
    if (/wirePodcastPlayer/.test(strip)) {
      ok('the homepage podcast strip wires its players');
    } else {
      bad('the homepage podcast strip renders cards but never wires them -- dead play button');
    }
  }
}

// --- outerHTML replaces the node, so wiring must not query the old mount ------
//
// `mount.outerHTML = ...` detaches `mount` and puts a replacement in the
// document. Querying `mount` afterwards finds nothing, and the wiring silently
// does nothing -- the same bug wearing a different hat. The lookup has to go
// through the new section by id.
{
  const stripStart = src.indexOf('async function fillPodcastStrip');
  const strip = src.slice(stripStart, stripStart + 3500);
  const afterSwap = strip.slice(strip.indexOf('outerHTML'));

  if (/byId\(\s*'latest-podcasts'\s*\)/.test(afterSwap)) {
    ok('the strip looks the players up on the NEW section, not the detached mount');
  } else {
    bad(
      "after mount.outerHTML the old mount is detached: querying it would wire nothing. " +
      "Look the cards up on the replacement section instead."
    );
  }
}

// --- the card must still be the same component on both pages -----------------

{
  // If the two pages ever diverge, fixing one no longer fixes the other, which
  // is how this bug stayed invisible: the pages looked like they shared code.
  if (/class="podcast-card" data-podcast-player/.test(src)) {
    ok('the card carries data-podcast-player, the hook both pages wire on');
  } else {
    bad('podcastCard no longer emits data-podcast-player, so nothing can be wired');
  }

  if (/card\.querySelector\('\[data-toggle\]'\)/.test(src) && /audio\.play\(\)/.test(src)) {
    ok('wirePodcastPlayer still binds the toggle to the audio element');
  } else {
    bad('wirePodcastPlayer no longer connects the toggle to the audio element');
  }
}

// --- the audio source must still be rendered ---------------------------------

{
  if (/src="\$\{escapeHtml\(episode\.audio_url\)\}"/.test(src)) {
    ok('the card still renders the escaped audio_url into the audio src');
  } else {
    bad('the card no longer renders audio_url; a wired button with no source plays nothing');
  }
}

console.log('\n------------------------------------------------------------------');
if (problems.length) {
  console.log(problems.length + ' problem(s):');
  for (const p of problems) console.log('  - ' + p);
  process.exit(1);
}
console.log('RESULT: PASS — every podcast card that is rendered is also wired.');