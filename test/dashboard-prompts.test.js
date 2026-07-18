// Task 7 — dashboard Prompts tab: TextInput's applyKey reducer, PromptsTab's
// formReduce wizard reducer, and PromptsTab rendering. In its own file
// (rather than dashboard.test.js) because PromptsTab.js transitively imports
// prompt-queue.js -> state.js -> config.js, which resolves UNSNOOZE_STATE_DIR
// at *import* time — the env var must be set before any src import happens,
// per the convention in test/dashboard-queue.test.js.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'unsnooze-dashboard-prompts-test-'));
process.env.UNSNOOZE_STATE_DIR = DIR;

const { applyKey } = await import('../src/dashboard/components/TextInput.js');
const { PromptsTab, formReduce, initFormState, WHEN_OPTIONS } =
  await import('../src/dashboard/tabs/PromptsTab.js');
const { renderToString } = await import('ink');
const React = (await import('react')).default;

after(() => rmSync(DIR, { recursive: true, force: true }));

// Full ink Key shape with everything false, overridable per test.
function K(overrides = {}) {
  return {
    upArrow: false, downArrow: false, leftArrow: false, rightArrow: false,
    pageDown: false, pageUp: false, home: false, end: false,
    return: false, escape: false, ctrl: false, shift: false, tab: false,
    backspace: false, delete: false, meta: false,
    ...overrides,
  };
}

// -- applyKey (TextInput's pure edit reducer) -------------------------------

test('applyKey: printable char inserts at cursor (mid-string)', () => {
  const out = applyKey({ value: 'ac', cursor: 1 }, 'b', K());
  assert.deepEqual(out, { value: 'abc', cursor: 2 });
});

test('applyKey: backspace at start/mid/end', () => {
  assert.deepEqual(applyKey({ value: 'abc', cursor: 0 }, '', K({ backspace: true })), { value: 'abc', cursor: 0 });
  assert.deepEqual(applyKey({ value: 'abc', cursor: 2 }, '', K({ backspace: true })), { value: 'ac', cursor: 1 });
  assert.deepEqual(applyKey({ value: 'abc', cursor: 3 }, '', K({ backspace: true })), { value: 'ab', cursor: 2 });
});

test('applyKey: delete key behaves as backward-delete too (minimal single-line input)', () => {
  assert.deepEqual(applyKey({ value: 'abc', cursor: 2 }, '', K({ delete: true })), { value: 'ac', cursor: 1 });
});

test('applyKey: left/right arrows move and clamp at both ends', () => {
  assert.deepEqual(applyKey({ value: 'ab', cursor: 0 }, '', K({ leftArrow: true })), { value: 'ab', cursor: 0 });
  assert.deepEqual(applyKey({ value: 'ab', cursor: 1 }, '', K({ leftArrow: true })), { value: 'ab', cursor: 0 });
  assert.deepEqual(applyKey({ value: 'ab', cursor: 2 }, '', K({ rightArrow: true })), { value: 'ab', cursor: 2 });
  assert.deepEqual(applyKey({ value: 'ab', cursor: 1 }, '', K({ rightArrow: true })), { value: 'ab', cursor: 2 });
});

test('applyKey: ctrl+a / ctrl+e jump to start/end; Home/End keys too', () => {
  assert.deepEqual(applyKey({ value: 'hello', cursor: 3 }, 'a', K({ ctrl: true })), { value: 'hello', cursor: 0 });
  assert.deepEqual(applyKey({ value: 'hello', cursor: 3 }, 'e', K({ ctrl: true })), { value: 'hello', cursor: 5 });
  assert.deepEqual(applyKey({ value: 'hello', cursor: 3 }, '', K({ home: true })), { value: 'hello', cursor: 0 });
  assert.deepEqual(applyKey({ value: 'hello', cursor: 3 }, '', K({ end: true })), { value: 'hello', cursor: 5 });
});

test('applyKey: paste chunk strips control bytes (ESC, \\n) but keeps printable text', () => {
  const out = applyKey({ value: '', cursor: 0 }, 'a\x1bb\nc', K());
  assert.deepEqual(out, { value: 'abc', cursor: 3 });
});

test('applyKey: a paste chunk that is ONLY control bytes is a no-op', () => {
  const out = applyKey({ value: 'x', cursor: 1 }, '\n\x1b', K());
  assert.deepEqual(out, { value: 'x', cursor: 1 });
});

test('applyKey: Enter/Escape never mutate value or cursor', () => {
  const state = { value: 'abc', cursor: 1 };
  assert.deepEqual(applyKey(state, '', K({ return: true })), state);
  assert.deepEqual(applyKey(state, '', K({ escape: true })), state);
});

test('applyKey: other ctrl combos (not a/e) are inert, not inserted as text', () => {
  assert.deepEqual(applyKey({ value: 'ab', cursor: 1 }, 'd', K({ ctrl: true })), { value: 'ab', cursor: 1 });
});

// -- formReduce (add-form step reducer) -------------------------------------

test('formReduce: PATH_SUBMIT failure stays on step 1 with an inline error', () => {
  const s0 = initFormState({ path: '/tmp', agents: ['claude'], hosts: [] });
  const s1 = formReduce(s0, { type: 'PATH_SUBMIT', ok: false, error: 'no such directory' });
  assert.equal(s1.step, 'path');
  assert.equal(s1.pathError, 'no such directory');
});

test('formReduce: full local happy path — path -> agent -> when -> prompt (no hosts)', () => {
  let s = initFormState({ path: '/tmp', agents: ['claude', 'codex'], hosts: [] });
  s = formReduce(s, { type: 'PATH_SUBMIT', ok: true, value: '/tmp/proj' });
  assert.equal(s.step, 'agent');
  assert.equal(s.path, '/tmp/proj');
  s = formReduce(s, { type: 'AGENT_SELECT', index: 1 });
  assert.equal(s.agentIndex, 1);
  s = formReduce(s, { type: 'AGENT_CONFIRM' });
  assert.equal(s.step, 'when');
  s = formReduce(s, { type: 'WHEN_CONFIRM' }); // default whenIndex 0 = next-reset
  assert.equal(s.step, 'prompt'); // no hosts -> host step skipped
});

test('formReduce: choosing "at…" routes through the at-text step and validates', () => {
  let s = initFormState({ path: '/tmp', agents: ['claude'], hosts: [] });
  s = formReduce(s, { type: 'WHEN_SELECT', index: WHEN_OPTIONS.indexOf('at') });
  s = formReduce(s, { type: 'WHEN_CONFIRM' });
  assert.equal(s.step, 'at');
  const bad = formReduce(s, { type: 'AT_SUBMIT', ok: false, error: 'could not parse "whenever"' });
  assert.equal(bad.step, 'at');
  assert.equal(bad.atError, 'could not parse "whenever"');
  const good = formReduce(s, { type: 'AT_SUBMIT', ok: true, value: '7pm', atMs: 12345 });
  assert.equal(good.step, 'prompt');
  assert.equal(good.atMs, 12345);
});

test('formReduce: with hosts present, WHEN_CONFIRM routes to the host step', () => {
  let s = initFormState({ path: '/tmp', agents: ['claude'], hosts: ['gpu', 'lap'] });
  s = formReduce(s, { type: 'WHEN_CONFIRM' });
  assert.equal(s.step, 'host');
});

test('formReduce: picking "local" (hostIndex 0) skips straight to prompt, keeping the local path', () => {
  let s = initFormState({ path: '/local/proj', agents: ['claude'], hosts: ['gpu'] });
  s.step = 'host';
  s = formReduce(s, { type: 'HOST_CONFIRM' });
  assert.equal(s.step, 'prompt');
  assert.equal(s.forHost, null);
  assert.equal(s.path, '/local/proj');
});

test('formReduce: picking a remote host clears the path and jumps back to step 1 for re-entry', () => {
  let s = initFormState({ path: '/local/proj', agents: ['claude'], hosts: ['gpu', 'lap'] });
  s.step = 'host';
  s = formReduce(s, { type: 'HOST_SELECT', index: 2 }); // 0=local, 1=gpu, 2=lap
  s = formReduce(s, { type: 'HOST_CONFIRM' });
  assert.equal(s.step, 'path');
  assert.equal(s.forHost, 'lap');
  assert.equal(s.path, '', 'remote paths differ from local — prefill must be cleared');
  // Submitting the re-entered remote path skips straight to prompt (agent/when/host already chosen).
  s = formReduce(s, { type: 'PATH_SUBMIT', ok: true, value: '/remote/proj' });
  assert.equal(s.step, 'prompt');
  assert.equal(s.forHost, 'lap');
});

test('formReduce: BACK from step 1 (no host re-entry in progress) closes the form (null)', () => {
  const s = initFormState({ path: '/tmp', agents: ['claude'], hosts: [] });
  assert.equal(formReduce(s, { type: 'BACK' }), null);
});

test('formReduce: BACK from the agent step returns to step 1, per the brief\'s explicit rule', () => {
  let s = initFormState({ path: '/tmp', agents: ['claude'], hosts: [] });
  s = formReduce(s, { type: 'PATH_SUBMIT', ok: true, value: '/tmp' });
  assert.equal(s.step, 'agent');
  s = formReduce(s, { type: 'BACK' });
  assert.equal(s.step, 'path');
});

test('formReduce: BACK from the host-re-entry path step returns to host (not a form close)', () => {
  let s = initFormState({ path: '/local', agents: ['claude'], hosts: ['gpu'] });
  s.step = 'host';
  s = formReduce(s, { type: 'HOST_SELECT', index: 1 });
  s = formReduce(s, { type: 'HOST_CONFIRM' });
  assert.equal(s.step, 'path');
  assert.equal(s.forHost, 'gpu');
  s = formReduce(s, { type: 'BACK' });
  assert.equal(s.step, 'host');
  assert.equal(s.forHost, null);
});

test('formReduce: unknown event types are a no-op', () => {
  const s = initFormState({});
  assert.equal(formReduce(s, { type: 'NOPE' }), s);
});

// -- PromptsTab rendering ----------------------------------------------------

test('PromptsTab: no data yet renders Loading', () => {
  const out = renderToString(React.createElement(PromptsTab, { data: undefined }));
  assert.match(out, /Loading/);
});

test('PromptsTab: empty queue shows the dim "press a to add" hint', () => {
  const out = renderToString(React.createElement(PromptsTab, { data: [], now: Date.now(), selected: 0 }));
  assert.match(out, /no queued prompts — press a to add/);
});

test('PromptsTab: renders id/agent/status for entries, with a selection marker only on the selected row', () => {
  const now = Date.now();
  const data = [
    { id: 'p-aaaaaaaa', cwd: '/w/one', agent: 'claude', mode: 'now', atMs: null, notBefore: 0, status: 'pending', prompt: 'do the thing' },
    { id: 'p-bbbbbbbb', cwd: '/w/two', agent: 'codex', mode: 'next-reset', atMs: null, notBefore: 0, status: 'launching', prompt: 'do another thing' },
  ];
  const out = renderToString(React.createElement(PromptsTab, { data, now, selected: 1 }));
  assert.match(out, /p-aaaaaaaa/);
  assert.match(out, /p-bbbbbbbb/);
  assert.match(out, /claude/);
  assert.match(out, /codex/);
  assert.match(out, /pending/);
  assert.match(out, /launching/);
  // Selected row (index 1) carries the ❯ marker; the other row doesn't.
  assert.match(out, /❯ p-bbbbbbbb/);
  assert.doesNotMatch(out, /❯ p-aaaaaaaa/);
});

test('PromptsTab: long prompt text is truncated to ~50 chars with an ellipsis', () => {
  const now = Date.now();
  const long = 'x'.repeat(80);
  const data = [{ id: 'p-11111111', cwd: '/w', agent: 'claude', mode: 'now', status: 'pending', prompt: long }];
  const out = renderToString(React.createElement(PromptsTab, { data, now, selected: 0 }));
  assert.match(out, /x{50}…/);
  assert.doesNotMatch(out, /x{51}/);
});

test('PromptsTab: add-form step 1 (project path) render smoke test', () => {
  const form = initFormState({ path: '/tmp/proj', agents: ['claude'], hosts: [] });
  const out = renderToString(React.createElement(PromptsTab, {
    data: [], now: Date.now(), selected: 0, initialForm: form,
  }));
  assert.match(out, /add prompt — project path/);
  assert.match(out, /tmp\/proj/);
});

test('PromptsTab: add-form host-re-entry step 1 shows the "path on <host>" label', () => {
  let form = initFormState({ path: '/local', agents: ['claude'], hosts: ['gpu'] });
  form = { ...form, step: 'path', forHost: 'gpu', path: '' };
  const out = renderToString(React.createElement(PromptsTab, {
    data: [], now: Date.now(), selected: 0, initialForm: form,
  }));
  assert.match(out, /path on gpu/);
});

// -- global-key suppression (the mechanism App.js's `inputCaptured` gate is
// driven by) — App.js has no live-stdin test harness in this suite, and (per
// inspection) the `?` help overlay does not actually gate any keys today, so
// there is no existing suppression seam to extend. This tests the flag's
// actual producer directly: PromptsTab must report "form open" on mount
// whenever it's mounted with a wizard step active, and must report "closed"
// on unmount no matter how the tab went away (e.g. a mouse click to another
// tab) — App.js's global useInput does nothing but forward this boolean, so
// this is the load-bearing part of the mechanism.
test('PromptsTab: reports form-open/closed via onFormOpenChange — App.js\'s only suppression signal', () => {
  const events = [];
  const onFormOpenChange = (open) => events.push(open);

  // Mounting with the wizard already open must report "open" before anything else.
  const form = initFormState({ path: '/tmp', agents: ['claude'], hosts: [] });
  renderToString(React.createElement(PromptsTab, {
    data: [], now: Date.now(), selected: 0, initialForm: form, onFormOpenChange,
  }));
  assert.deepEqual(events, [true, false], 'open on mount, then closed again on renderToString\'s teardown unmount');

  // Mounting with the list (no form) must report "closed", never "open".
  events.length = 0;
  renderToString(React.createElement(PromptsTab, {
    data: [], now: Date.now(), selected: 0, onFormOpenChange,
  }));
  assert.deepEqual(events, [false, false], 'closed on mount, still closed on unmount');
});
