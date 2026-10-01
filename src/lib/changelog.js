/* =============================================================================
   src/lib/changelog.js — OWNER CHANGELOG FEED
   -----------------------------------------------------------------------------
   Renders CHANGELOG.md inside the Owner Control Center.

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
  'Pending — required before these features work': 'fa-hourglass-half'
};

/**
 * Section order. Known sections first in the conventional order, then anything
 * unrecognised alphabetically, so a new heading in the markdown still shows up
 * rather than disappearing.
 */
const SECTION_ORDER = [
  'Pending — required before these features work',
  'Added',
  'Changed',
  'Fixed',
  'Security',
  'Deprecated',
  'Removed',
  'Known limitations'
];

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

  const closeSection = () => {
    if (current && section && section.items.length) current.sections.push(section);
    section = null;
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

    // "- something"  (two spaces = the wrapped continuation of the last item)
    const bullet = line.match(/^-\s+(.*)$/);
    if (bullet && section) {
      section.items.push(bullet[1].trim());
      continue;
    }

    // A wrapped continuation line belongs to the bullet above it.
    const wrapped = line.match(/^\s{2,}(\S.*)$/);
    if (wrapped && section && section.items.length) {
      section.items[section.items.length - 1] += ` ${wrapped[1].trim()}`;
      continue;
    }

    if (!line.trim()) closeSection();
  }

  closeSection();

  for (const release of releases) {
    release.sections.sort((a, b) => {
      const ai = SECTION_ORDER.indexOf(a.title);
      const bi = SECTION_ORDER.indexOf(b.title);
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
  return SECTION_ICONS[title] || 'fa-circle-dot';
}
