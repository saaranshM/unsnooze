import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { changelogSection, releaseNotes } from '../scripts/release-notes.mjs';

const CHANGELOG = `# Changelog

## 1.16.20 — 2026-09-01

- twentieth

## 1.16.2 — 2026-08-22

- **A thing changed.**
  With a second line.

## 1.16.1 — 2026-08-16

- something older
`;

test('changelogSection returns the body for exactly that version', () => {
  assert.equal(changelogSection(CHANGELOG, '1.16.2'),
    '- **A thing changed.**\n  With a second line.');
});

// "## 1.16.2" must not match the "## 1.16.20" heading that precedes it — a
// prefix match would ship the wrong release's notes.
test('changelogSection does not match a longer version that starts the same', () => {
  assert.equal(changelogSection(CHANGELOG, '1.16.20'), '- twentieth');
  assert.equal(changelogSection(CHANGELOG, '1.16.'), null);
  assert.equal(changelogSection(CHANGELOG, '1.16'), null);
});

test('changelogSection returns null for a version that is not there', () => {
  assert.equal(changelogSection(CHANGELOG, '9.9.9'), null);
});

test('releaseNotes leads with the install command for that exact version', () => {
  const notes = releaseNotes(CHANGELOG, '1.16.2');
  assert.match(notes, /^```sh\nnpm install -g unsnooze@1\.16\.2\n```\n\n/);
  assert.match(notes, /A thing changed/);
  assert.equal(releaseNotes(CHANGELOG, '9.9.9'), null);
});

// The workflow runs this against the real files after publishing, and fails the
// job when it comes back empty. If a release commit forgets its CHANGELOG
// section, this catches it before the tag rather than after.
test('the version being shipped has a CHANGELOG section of its own', () => {
  const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  const notes = releaseNotes(readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8'), version);
  assert.ok(notes, `CHANGELOG.md has no "## ${version}" section`);
  assert.ok(notes.length > 100, 'the notes say something');
});
