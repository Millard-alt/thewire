/* =============================================================================
   src/lib/changelog.js — OWNER CHANGELOG FEED
   -----------------------------------------------------------------------------
   Renders CHANGELOG.md inside the Newsroom Panel.

   The markdown file is imported raw at build time rather than re-typed as a
   JavaScript literal. That means the panel and the repository file can never
   disagree: there is exactly one place to edit, and a forgotten panel update
   is impossible by construction.

   Nothing privileged lives here. The changelog describes what changed, and that
   text is already public in the git history. The *panel* is gated on the Owner
   role in views/admin.js, not on anything in this module.
   ========================================================================== */

import source from '../../CHANGELOG.md?raw';

/** Section heading -> the icon shown beside it. */
const SECTION_ICONS = {
  Added: 'fa-plus',
  Changed: 'fa-arrows-rotate',
  Deprecated: 'fa-triangle-exclamation',
  Removed: 'fa-trash',
  Fixed: 'fa-screwdriver-wrench',
  Security: 'fa-shield-halved',
  'Known limitations': 'fa-circle-info',
  Applied: 'fa-circle-check',
  /*
   * KEYED ON THE BASE TITLE, NOT THE FULL HEADING.
   *
   * This was keyed 'Pending — required before these features work', which can
   * never match: `baseTitle()` reduces any "Word — qualifier" heading to just
   * "Word", so the lookup below was always `SECTION_ICONS['Pending']` ->
   * undefined -> the generic fa-circle-dot, and the section sorted to the end
   * among unknown headings instead of second.
   *
   * The heading a release actually writes is still free to carry a qualifier;
   * `baseTitle()` is what both the icon and the ordering consult, so the key has
   * to be the reduced form. Verified against the real heading below.
   */
  Pending: 'fa-hourglass-half'
};

/**
 * Section order. Known sections first in the conventional order, then anything
 * unrecognised alphabetically, so a new heading in the markdown still shows up
 * rather than disappearing.
 *
 * Keys are BASE TITLES for the same reason as SECTION_ICONS above.
 */
const SECTION_ORDER = [
  'Applied',
  'Pending',
  'Added',
  'Changed',
  'Fixed',
  'Security',
  'Deprecated',
  'Removed',
  'Known limitations'
];

/**
 * The known-kind part of a section heading, e.g. "Applied" from
 * "Applied - `017` is live and verified". Section headings are allowed to carry
 * a trailing qualifier so a release can explain itself, but ordering and icons
 * must still resolve against the bare kind.
 */
function baseTitle(title) {
  const text = String(title || '').trim();
  const cut = text.search(/\s+[-\u2013\u2014]\s+/);
  return (cut === -1 ? text : text.slice(0, cut)).trim();
}

/**
 * Parse a Keep a Changelog document into releases.
 *
 * @returns {Array<{version: string, date: string, sections: Array<{title: string, items: string[]}>}>}
 */
function parse(markdown) {
  const releases = [];
  const lines = String(markdown || '').split(/\r?\n/);

  let current = null;
  let section = null;
  // Paragraph tracking for prose lines. A bullet always opens a new entry; an
  // unindented prose line continues the entry above it unless a blank line came
  // between them. Local state only: items stay plain strings, because that is
  // what the renderer and pendingCount() consume.
  let lastWasBullet = false;
  let sawBlank = false;

  const closeSection = () => {
    if (current && section && section.items.length) current.sections.push(section);
    section = null;
    lastWasBullet = false;
    sawBlank = false;
  };

  for (const line of lines) {
    // "## [1.0.0] — 2026-09-29"
    const heading = line.match(/^##\s+\[?([^\]\s]+)\]?\s*(?:[—–-]\s*(.+))?$/);
    if (heading) {
      closeSection();
      current = {
        version: heading[1],
        date: (heading[2] || '').trim(),
        sections: []
      };
      releases.push(current);
      continue;
    }

    if (!current) continue;

    // "### Added"
    const sub = line.match(/^###\s+(.+)$/);
    if (sub) {
      closeSection();
      section = { title: sub[1].trim(), items: [] };
      continue;
    }

    // "- something"
    const bullet = line.match(/^-\s+(.*)$/);
    if (bullet && section) {
      section.items.push(bullet[1].trim());
      lastWasBullet = true;
      sawBlank = false;
      continue;
    }

    // A wrapped continuation line belongs to the item above it. Bullets are
    // wrapped with two spaces of indent in this file, so this has to be tested
    // before the prose case below.
    const wrapped = line.match(/^\s{2,}(\S.*)$/);
    if (wrapped && section && section.items.length) {
      section.items[section.items.length - 1] += ` ${wrapped[1].trim()}`;
      lastWasBullet = false;
      continue;
    }

    // Unindented prose inside a section is content in its own right. It used to
    // be dropped on the floor, which is what silently emptied this changelog.
    // A blank line starts a new paragraph; consecutive prose lines are joined so
    // a sentence is one entry rather than a column of ragged fragments.
    if (section && line.trim()) {
      const last = section.items.length - 1;
      if (last >= 0 && !lastWasBullet && !sawBlank) {
        section.items[last] += ` ${line.trim()}`;
      } else {
        section.items.push(line.trim());
      }
      lastWasBullet = false;
      sawBlank = false;
      continue;
    }

    // Blank line: remember it so the next prose line opens a fresh paragraph.
    if (section) sawBlank = true;
  }

  closeSection();

  for (const release of releases) {
    release.sections.sort((a, b) => {
      const ai = SECTION_ORDER.indexOf(baseTitle(a.title));
      const bi = SECTION_ORDER.indexOf(baseTitle(b.title));
      if (ai === -1 && bi === -1) return a.title.localeCompare(b.title);
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });
  }

  return releases;
}

/** Every release, newest first (the file is already authored newest-first). */
export function getReleases() {
  return parse(source);
}

/** The `[Unreleased]` block, which is what the Owner acts on. */
export function getPending() {
  return getReleases().find((r) => r.version === 'Unreleased') || null;
}

/** How many items are still marked as blocking. Drives the warning banner. */
export function pendingCount() {
  const pending = getPending();
  if (!pending) return 0;
  return pending.sections.reduce((total, s) => total + s.items.length, 0);
}

/** The icon for a section heading, falling back to a neutral dot. */
export function sectionIcon(title) {
  return SECTION_ICONS[baseTitle(title)] || 'fa-circle-dot';
}
