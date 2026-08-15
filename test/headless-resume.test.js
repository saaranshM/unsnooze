// A headless revive has no pane, so the resume prompt cannot be typed — it has
// to travel in argv. Verified against the real CLI on 2026-08-16:
//   claude --resume <id> "<prompt>"      -> resumes that exact session id and
//                                           acts on the prompt (no -p needed).
// The old comment in src/agents/claude.js claimed no such form existed; it did.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getAgent } from '../src/agents/index.js';
import { createHeadless } from '../src/multiplexers/headless.js';
import tmux from '../src/multiplexers/tmux.js';
import { backendCanType } from '../src/multiplexer.js';

test('claude keeps typing into a real pane when one exists', () => {
  const claude = getAgent('claude');
  const resume = claude.resumeArgs('abc-123', 'go on');
  assert.deepEqual(resume.args, ['--resume', 'abc-123']);
  assert.equal(resume.messageViaPane, true,
    'the tmux path is unchanged — the prompt is still typed into the TUI');
});

test('claude carries the prompt in argv when the backend cannot type', () => {
  const claude = getAgent('claude');
  const resume = claude.resumeArgs('abc-123', 'go on', { canType: false });
  assert.deepEqual(resume.args, ['--resume', 'abc-123', 'go on']);
  assert.equal(resume.messageViaPane, false,
    'nothing will be typed, so the resumer must not wait for a TUI prompt');
});

test('a headless resume with no session id continues the last conversation', () => {
  const claude = getAgent('claude');
  const resume = claude.resumeArgs(null, 'go on', { canType: false });
  assert.deepEqual(resume.args, ['-c', 'go on']);
  assert.equal(resume.messageViaPane, false);
});

test('an empty resume message never appends a blank argv entry', () => {
  const claude = getAgent('claude');
  assert.deepEqual(claude.resumeArgs('abc-123', '', { canType: false }).args,
    ['--resume', 'abc-123']);
  assert.deepEqual(claude.resumeArgs('abc-123', undefined, { canType: false }).args,
    ['--resume', 'abc-123']);
});

test('backendCanType singles out headless and leaves every pane backend alone', () => {
  assert.equal(backendCanType(createHeadless({ env: {} })), false);
  assert.equal(backendCanType(tmux), true);
  // Only headless is special-cased. A partial object — every fake mux in
  // test/resumer.test.js, and any bound wrapper — must still read as able to
  // type, or a working typed resume silently becomes an argv one.
  assert.equal(backendCanType({ name: 'zellij' }), true);
  assert.equal(backendCanType({}), true);
});
