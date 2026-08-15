// Delivering an argument that cannot be typed.
//
// herdr starts a pane command by typing it into the pane's shell, so a newline
// in a resume message would submit half a command and a tab would be a
// completion request. Quoting cannot help: it governs how the shell parses
// bytes, not what the terminal does with them on the way in.
//
// It does not have to be typed, though. The multiplexer passes real argv to
// `workspace create --env`, so the value can travel as environment and the
// typed line can reference it — the shell expands it back to the original
// bytes. Verified against real herdr 0.8.0.

import { test as baseTest } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import { shellCommand, UnquotableArgError } from '../src/multiplexers/shell-quote.js';

const test = process.platform === 'win32'
  ? (name, fn) => baseTest(name, { skip: 'unix-only (/bin/sh round-trip)' }, fn)
  : baseTest;

const NUL = String.fromCharCode(0);

test('an argument that cannot be typed is delivered as environment and expands back', () => {
  const message = 'first line\nsecond line\tafter a tab\nthird';
  const { line, env } = shellCommand('printf', ['%s', message]);

  assert.deepEqual(Object.keys(env), ['UNSNOOZE_ARGV_2'], 'only the untypeable argument is hoisted');
  assert.equal(env.UNSNOOZE_ARGV_2, message);
  assert.doesNotMatch(line, /\n/, 'the line itself stays typeable');
  assert.match(line, /"\$UNSNOOZE_ARGV_2"/);

  // The shell in the pane is what has to reconstruct it.
  const out = execFileSync('/bin/sh', ['-c', line], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  assert.equal(out, message, 'the value survives the round trip byte for byte');
});

test('typeable arguments are still quoted inline, not hoisted', () => {
  const { line, env } = shellCommand('node', ['-e', 'x', 'a b', '$(id)']);
  assert.deepEqual(env, {}, 'nothing needs the environment');
  assert.equal(line, "'node' '-e' 'x' 'a b' '$(id)'");
});

test('a mixed command hoists only what it must', () => {
  const { line, env } = shellCommand('node', ['ok', 'has\nnewline', 'also ok']);
  assert.deepEqual(Object.keys(env), ['UNSNOOZE_ARGV_2']);
  assert.equal(line, `'node' 'ok' "$UNSNOOZE_ARGV_2" 'also ok'`);
});

test('a null byte has nowhere to go, and says so', () => {
  // An environment value is a NUL-terminated string, so hoisting cannot save
  // this one either.
  assert.throws(() => shellCommand('node', [`a${NUL}b`]),
    err => err instanceof UnquotableArgError && /null byte/.test(err.message));
});

test('a multi-line resume message reaches the agent as ONE argument', async () => {
  const { DEFAULTS } = await import('../src/settings.js');
  const multiline = `${DEFAULTS.resumeMessage}\n\nSecond paragraph, with a\ttab.`;
  const codex = await import('../src/agents/codex.js');
  const resume = codex.default.resumeArgs('01JABCDEF', multiline);

  // A distinctive separator makes "one argument" checkable: the message itself
  // contains newlines, so newline-delimited output could not tell us that.
  const { line, env } = shellCommand('printf', ['%s<END>', ...resume.args]);
  const out = execFileSync('/bin/sh', ['-c', line], { encoding: 'utf8', env: { ...process.env, ...env } });
  const args = out.split('<END>').filter(Boolean);
  assert.equal(args.at(-1), multiline, 'the whole paragraph arrived as a single argument');
  assert.equal(args[0], 'resume', 'and the flags around it are untouched');
});
