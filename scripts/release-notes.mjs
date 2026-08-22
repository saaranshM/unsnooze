#!/usr/bin/env node
// The body of a GitHub release, built from the CHANGELOG section for a version.
//
//   node scripts/release-notes.mjs [version] > notes.md
//
// Defaults to the version in package.json — the one the release workflow has
// just published. Exits non-zero when that version has no CHANGELOG section,
// because a release whose notes are empty is worse than a failed step.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function changelogSection(changelog, version) {
  const section = changelog
    .split(/\n(?=## )/)
    .find(chunk => {
      if (!chunk.startsWith('## ')) return false;
      // "## 1.16.2 — 2026-08-22" and a bare "## 1.16.2" both match; "## 1.16.20"
      // must not.
      const heading = chunk.slice(3, chunk.indexOf('\n') === -1 ? undefined : chunk.indexOf('\n'));
      return heading.trim() === version || heading.trim().startsWith(`${version} `);
    });
  if (!section) return null;
  const newline = section.indexOf('\n');
  return newline === -1 ? '' : section.slice(newline + 1).trim();
}

export function releaseNotes(changelog, version) {
  const body = changelogSection(changelog, version);
  if (body === null) return null;
  return `\`\`\`sh\nnpm install -g unsnooze@${version}\n\`\`\`\n\n${body}\n`;
}

// Only run when invoked as a script, so the two functions above stay testable.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const version = process.argv[2]
    || JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
  const notes = releaseNotes(readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8'), version);
  if (notes === null) {
    console.error(`release-notes: CHANGELOG.md has no "## ${version}" section`);
    process.exit(1);
  }
  process.stdout.write(notes);
}
