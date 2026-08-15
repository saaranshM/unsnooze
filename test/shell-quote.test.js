// The quoting that stands between a resume message and the user's shell.
//
// herdr has no exec path: `pane run` types its operands into the pane's
// interactive shell. Asserting the string we produce only proves we produce
// the string we expected, so the round-trip tests hand the line to a real
// /bin/sh and compare the argv that comes out the other side.

import { test as baseTest } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import { shQuote, shellLine, UnquotableArgError } from '../src/multiplexers/shell-quote.js';

// /bin/sh round-trips are a unix surface; the quoting itself is asserted
// everywhere.
const test = process.platform === 'win32'
  ? (name, fn) => baseTest(name, { skip: 'unix-only (/bin/sh round-trip)' }, fn)
  : baseTest;

// Everything a resume message, a project path or an agent flag can contain and
// that a shell would otherwise interpret.
const NASTY = [
  'a b', "it's", '', '$(id)', '`id`', 'a;b|c', '*', '?', '[a-z]', '--flag=va lue',
  'ü', 'back\\slash', '$HOME', '${HOME}', 'quote"dbl', '~', 'a&&b', 'a>out', '#hash',
  'new  double  spaces', '!bang', '%(pct)', 'a b',
];

test('every shell-significant argument survives a real /bin/sh round-trip', () => {
  // printf %s\n per argument: the shell parses our quoted words, and we read
  // back the argv it built. shellLine() is the same map+join over the same
  // quoter, with the untypeable-character guard in front.
  const script = `printf '%s\\n' ${NASTY.map(shQuote).join(' ')}`;
  const out = execFileSync('/bin/sh', ['-c', script], { encoding: 'utf8' });
  assert.deepEqual(out.split('\n').slice(0, NASTY.length), NASTY);
});

test('an empty argument survives as an empty argument, not as nothing', () => {
  const out = execFileSync('/bin/sh', ['-c', `printf '[%s]' ${shQuote('')} ${shQuote('x')}`], { encoding: 'utf8' });
  assert.equal(out, '[][x]');
});

test('command substitution is inert, not executed', () => {
  const out = execFileSync('/bin/sh', ['-c', `printf '%s' ${shQuote('$(echo pwned)')}`], { encoding: 'utf8' });
  assert.equal(out, '$(echo pwned)', 'the text is the text');
});

test('the real default resume message survives verbatim', async () => {
  const { DEFAULTS } = await import('../src/settings.js');
  const message = DEFAULTS.resumeMessage;
  assert.ok(message.includes(' '), 'the message is a sentence, which is the whole problem');
  const out = execFileSync('/bin/sh', ['-c', `printf '%s' ${shQuote(message)}`], { encoding: 'utf8' });
  assert.equal(out, message);
});

test('the real Codex and Kimi resume argv survive verbatim', async () => {
  const { DEFAULTS } = await import('../src/settings.js');
  const codex = await import('../src/agents/codex.js');
  const resume = codex.default.resumeArgs('01JABCDEF', DEFAULTS.resumeMessage);
  const script = `printf '%s\\n' ${shellLine('_run', ['codex', ...resume.args])}`;
  const out = execFileSync('/bin/sh', ['-c', script], { encoding: 'utf8' });
  const got = out.split('\n').filter(Boolean);
  assert.equal(got.at(-1), DEFAULTS.resumeMessage, 'the prompt arrives as ONE argument');
  assert.equal(got[0], '_run');
  assert.equal(got[1], 'codex');
});

// Quoting governs how the shell PARSES the bytes. It has no authority over what
// the terminal does with them on the way in, so these cannot be made safe and
// must be refused instead of silently mangled.
test('characters that are keystrokes, not text, are refused', () => {
  for (const [value, label] of [['a\nb', 'newline'], ['a\rb', 'carriage return'],
    ['a\tb', 'tab'], ['a\0b', 'null byte']]) {
    assert.throws(
      () => shellLine('node', [value]),
      err => err instanceof UnquotableArgError && err.arg === value,
      `${label} must be refused`,
    );
  }
});

test('a tab really is swallowed by an interactive shell (why it is refused)', () => {
  // Verified against real herdr 0.8.0: 'tab\there' arrived as "tabhere".
  // Documented here so the refusal is not mistaken for over-caution.
  assert.throws(() => shellLine('node', ['tab\there']), UnquotableArgError);
});

test('the refusal names the offending argument so the user can fix their setting', () => {
  try {
    shellLine('node', ['fine', 'oops\nhere']);
    assert.fail('should have thrown');
  } catch (err) {
    assert.match(err.message, /newline/);
    assert.match(err.message, /oops/);
  }
});
