// PATH lookup with the rules of the platform being asked about, not the host.
// #25 traced back to a ':' split of a Windows PATH: every absolute entry has a
// ':' in it, so the list shredded into nonsense and "on PATH" was never true.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findOnPath, candidateNames, resolveBin } from '../src/which.js';

test('findOnPath splits a Windows PATH on ";" and joins with backslashes', () => {
  const files = new Set(['C:\\Program Files\\nodejs\\codex.exe']);
  const env = { PATH: 'C:\\Users\\me\\AppData\\Local\\OpenAI\\Codex\\bin\\dead;C:\\Program Files\\nodejs' };
  const hit = findOnPath(['codex.exe'], { env, exists: p => files.has(p), platform: 'win32' });
  assert.deepEqual(hit, { dir: 'C:\\Program Files\\nodejs', name: 'codex.exe', path: 'C:\\Program Files\\nodejs\\codex.exe' });
  // The same PATH split on ':' finds nothing — the old behaviour.
  assert.equal(findOnPath(['codex.exe'], { env, exists: p => files.has(p), platform: 'linux' }), null);
});

test('findOnPath on POSIX splits on ":" and skips empty and unreadable entries', () => {
  const env = { PATH: ':/nope::/usr/local/bin:' };
  const exists = p => { if (p.startsWith('/nope')) throw new Error('EACCES'); return p === '/usr/local/bin/codex'; };
  assert.deepEqual(findOnPath(['codex'], { env, exists, platform: 'darwin' }),
    { dir: '/usr/local/bin', name: 'codex', path: '/usr/local/bin/codex' });
  assert.equal(findOnPath(['codex'], { env: {}, exists, platform: 'darwin' }), null);
});

test('candidateNames: Windows tries launchable spellings first, then the shims that explain a failure', () => {
  assert.deepEqual(candidateNames('codex', 'win32'), ['codex.exe', 'codex.com', 'codex.cmd', 'codex.bat']);
  assert.deepEqual(candidateNames('codex.exe', 'win32'), ['codex.exe']);
  assert.deepEqual(candidateNames('codex', 'linux'), ['codex']);
});

test('resolveBin: paths are checked as given, bare names searched, shims marked unlaunchable', () => {
  const files = new Set(['C:\\npm\\claude.cmd', 'C:\\x\\codex.exe', '/usr/bin/claude']);
  const exists = p => files.has(p);
  assert.deepEqual(resolveBin('C:\\x\\codex.exe', { env: {}, exists, platform: 'win32' }), { path: 'C:\\x\\codex.exe', launchable: true });
  assert.deepEqual(resolveBin('claude', { env: { PATH: 'C:\\npm' }, exists, platform: 'win32' }), { path: 'C:\\npm\\claude.cmd', launchable: false });
  assert.deepEqual(resolveBin('claude', { env: { PATH: '/usr/bin' }, exists, platform: 'linux' }), { path: '/usr/bin/claude', launchable: true });
  assert.equal(resolveBin('claude', { env: { PATH: '/opt' }, exists, platform: 'linux' }), null);
  assert.equal(resolveBin('/nope/claude', { env: {}, exists, platform: 'linux' }), null);
  // A path of the other platform's shape is still a path, never a PATH search.
  assert.deepEqual(resolveBin('C:\\x\\codex.exe', { env: { PATH: '/usr/bin' }, exists, platform: 'linux' }), { path: 'C:\\x\\codex.exe', launchable: true });
  assert.deepEqual(resolveBin('/usr/bin/claude', { env: { PATH: 'C:\\npm' }, exists, platform: 'win32' }), { path: '/usr/bin/claude', launchable: true });
  assert.equal(resolveBin('', { env: {}, exists }), null);
  assert.equal(resolveBin(null, { env: {}, exists }), null);
});

// spawn (libuv) only ever appends .com/.exe to a bare name, so an .exe later on
// PATH is what runs even when an npm .cmd shim sits in an earlier directory —
// doctor must not call that machine broken.
test('resolveBin on Windows: an .exe anywhere on PATH beats a shim earlier on it', () => {
  const files = new Set(['C:\\npm\\claude.cmd', 'C:\\Users\\me\\.local\\bin\\claude.exe']);
  const exists = p => files.has(p);
  assert.deepEqual(
    resolveBin('claude', { env: { PATH: 'C:\\npm;C:\\Users\\me\\.local\\bin' }, exists, platform: 'win32' }),
    { path: 'C:\\Users\\me\\.local\\bin\\claude.exe', launchable: true });
  // Only the shim: found, as the reason nothing can be launched.
  assert.deepEqual(
    resolveBin('claude', { env: { PATH: 'C:\\npm;C:\\empty' }, exists, platform: 'win32' }),
    { path: 'C:\\npm\\claude.cmd', launchable: false });
});

// Two more places spawn's own Windows search (libuv) is more forgiving than a
// naive lookup: quoted PATH entries, and a path given without its extension.
test('findOnPath strips quotes from Windows PATH entries', () => {
  const exists = p => p === 'C:\\Tools\\codex\\codex.exe';
  assert.deepEqual(
    findOnPath(['codex.exe'], { env: { PATH: '"C:\\Tools\\codex";C:\\npm' }, exists, platform: 'win32' }),
    { dir: 'C:\\Tools\\codex', name: 'codex.exe', path: 'C:\\Tools\\codex\\codex.exe' });
});

test('resolveBin on Windows tries an extensionless path as .com, then .exe', () => {
  const exists = p => p === 'C:\\Tools\\codex\\codex.exe';
  assert.deepEqual(resolveBin('C:\\Tools\\codex\\codex', { env: {}, exists, platform: 'win32' }),
    { path: 'C:\\Tools\\codex\\codex.exe', launchable: true });
  assert.equal(resolveBin('C:\\Tools\\codex\\nope', { env: {}, exists, platform: 'win32' }), null);
});
