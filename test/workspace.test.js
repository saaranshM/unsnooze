import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workspaceFingerprint, workspaceChanged, describeChange } from '../src/workspace.js';

const DIR = mkdtempSync(join(tmpdir(), 'unsnooze-workspace-test-'));
after(() => rmSync(DIR, { recursive: true, force: true }));

function git(cwd, ...args) {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
}

function makeRepo(name) {
  const repo = join(DIR, name);
  mkdirSync(repo);
  git(repo, 'init', '-q');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'init');
  return repo;
}

test('fingerprint is stable when nothing changes', () => {
  const repo = makeRepo('stable');
  const a = workspaceFingerprint(repo);
  const b = workspaceFingerprint(repo);
  assert.ok(a && a.head && a.dirtyHash);
  assert.deepEqual(a, b);
  assert.equal(workspaceChanged({ workspace: a }, b), null);
});

test('a new commit changes the fingerprint and is described', () => {
  const repo = makeRepo('commit');
  const before = workspaceFingerprint(repo);
  writeFileSync(join(repo, 'a.txt'), 'two\n');
  git(repo, 'commit', '-aqm', 'change');
  const now = workspaceFingerprint(repo);
  const d = workspaceChanged({ workspace: before }, now);
  assert.ok(d, 'change must be detected');
  assert.equal(d.oldHead, before.head);
  assert.equal(d.newHead, now.head);
  assert.match(describeChange(d), /HEAD \w{7} → \w{7}/);
});

test('dirtying a file changes the fingerprint (same HEAD)', () => {
  const repo = makeRepo('dirty');
  const before = workspaceFingerprint(repo);
  writeFileSync(join(repo, 'a.txt'), 'dirty\n');
  const now = workspaceFingerprint(repo);
  const d = workspaceChanged({ workspace: before }, now);
  assert.ok(d);
  assert.equal(d.oldHead, d.newHead);
  assert.equal(d.dirtyChanged, true);
  assert.match(describeChange(d), /uncommitted changes/i);
});

test('non-git directory and null cwd yield null (guard skipped)', () => {
  const plain = join(DIR, 'plain');
  mkdirSync(plain);
  assert.equal(workspaceFingerprint(plain), null);
  assert.equal(workspaceFingerprint(null), null);
  assert.equal(workspaceChanged({ workspace: null }, null), null);
  assert.equal(workspaceChanged({}, workspaceFingerprint(plain)), null);
});
