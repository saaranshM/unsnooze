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
const { PromptsTab, formReduce, initFormState, WHEN_OPTIONS, submitFinal, removeEntry } =
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

// -- submitFinal (add-form write path) --------------------------------------
// Injected-deps stubs only — never a real spawn/ssh round trip. Spy helpers
// record calls in plain arrays rather than pulling in a mock library.

function spy(impl) {
  const fn = (...args) => { fn.calls.push(args); return impl ? impl(...args) : undefined; };
  fn.calls = [];
  return fn;
}

test('submitFinal: local success — queueAddFn called, form closed, onRefresh + status message', () => {
  const state = initFormState({ path: '/local/proj', agents: ['claude'], hosts: [] });
  const setForm = spy();
  const dispatch = spy();
  const onRefresh = spy();
  const onStatus = spy();
  const queueAddFn = spy(() => ({ ok: true, entry: { id: 'p-aaaa1111' } }));

  submitFinal(state, 'do the thing', { setForm, dispatch, onRefresh, onStatus, queueAddFn });

  assert.equal(queueAddFn.calls.length, 1);
  assert.deepEqual(queueAddFn.calls[0][0], {
    cwd: '/local/proj', agent: 'claude', prompt: 'do the thing', mode: 'next-reset', atMs: null,
  });
  assert.deepEqual(setForm.calls, [[null]], 'form closes on success');
  assert.equal(onRefresh.calls.length, 1);
  assert.equal(onStatus.calls.length, 1);
  assert.match(onStatus.calls[0][0], /queued p-aaaa1111/);
  assert.match(onStatus.calls[0][0], /claude/);
  assert.equal(dispatch.calls.length, 0, 'no SUBMIT_ERROR on success');
});

test('submitFinal: duplicate error — message names the existing id, form stays open (no setForm/onRefresh)', () => {
  const state = initFormState({ path: '/local/proj', agents: ['claude'], hosts: [] });
  const setForm = spy();
  const dispatch = spy();
  const onRefresh = spy();
  const onStatus = spy();
  const queueAddFn = spy(() => ({ ok: false, error: 'duplicate', existing: { id: 'p-oldold01' } }));

  submitFinal(state, 'do the thing', { setForm, dispatch, onRefresh, onStatus, queueAddFn });

  assert.equal(dispatch.calls.length, 1);
  assert.equal(dispatch.calls[0][0].type, 'SUBMIT_ERROR');
  assert.match(dispatch.calls[0][0].error, /duplicate/);
  assert.match(dispatch.calls[0][0].error, /p-oldold01/);
  assert.equal(setForm.calls.length, 0, 'form must stay open on error');
  assert.equal(onRefresh.calls.length, 0);
  assert.equal(onStatus.calls.length, 0);
});

test('submitFinal: validation-shaped {ok:false} error passes the raw error through unchanged', () => {
  const state = initFormState({ path: '/local/proj', agents: ['claude'], hosts: [] });
  const setForm = spy();
  const dispatch = spy();
  const queueAddFn = spy(() => ({ ok: false, error: 'unknown agent: ghost' }));

  submitFinal(state, 'do the thing', { setForm, dispatch, onRefresh: spy(), onStatus: spy(), queueAddFn });

  assert.equal(dispatch.calls.length, 1);
  assert.deepEqual(dispatch.calls[0][0], { type: 'SUBMIT_ERROR', error: 'unknown agent: ghost' });
  assert.equal(setForm.calls.length, 0);
});

test('submitFinal: "at" mode carries atMs through to queueAddFn', () => {
  let state = initFormState({ path: '/local/proj', agents: ['claude'], hosts: [] });
  state = { ...state, whenIndex: WHEN_OPTIONS.indexOf('at'), atMs: 999999 };
  const queueAddFn = spy(() => ({ ok: true, entry: { id: 'p-atat0001' } }));

  submitFinal(state, 'later thing', { setForm: spy(), dispatch: spy(), onRefresh: spy(), onStatus: spy(), queueAddFn });

  assert.equal(queueAddFn.calls[0][0].mode, 'at');
  assert.equal(queueAddFn.calls[0][0].atMs, 999999);
});

test('submitFinal: remote branch — closes the form immediately (fire-and-forget), then calls remoteQueueAddFn with the right entry', async () => {
  let state = initFormState({ path: '/remote/proj', agents: ['claude'], hosts: ['gpu'] });
  state = { ...state, forHost: 'gpu' };
  const setForm = spy();
  const onStatus = spy();
  const hostEntry = { host: '1.2.3.4' };
  const readHostsFn = spy(() => ({ gpu: hostEntry }));
  const remoteQueueAddFn = spy(async () => ({ ok: true, id: 'p-remote01' }));

  submitFinal(state, 'remote thing', { setForm, dispatch: spy(), onRefresh: spy(), onStatus, remoteQueueAddFn, readHostsFn });

  // Fire-and-forget: the form closes synchronously, before the ssh round trip settles.
  assert.deepEqual(setForm.calls, [[null]]);
  assert.equal(remoteQueueAddFn.calls.length, 1);
  assert.equal(remoteQueueAddFn.calls[0][0], 'gpu');
  assert.deepEqual(remoteQueueAddFn.calls[0][1], {
    cwd: '/remote/proj', agent: 'claude', prompt: 'remote thing', mode: 'next-reset', atMs: null,
  });
  assert.deepEqual(remoteQueueAddFn.calls[0][2], { entryOrDest: hostEntry });

  await Promise.resolve(); // let the .then() handler run
  await Promise.resolve();
  assert.equal(onStatus.calls.length, 1);
  assert.match(onStatus.calls[0][0], /queued p-remote01/);
  assert.match(onStatus.calls[0][0], /gpu/);
});

test('submitFinal: remote branch — a resolved-but-failed result routes into onStatus with the error', async () => {
  let state = initFormState({ path: '/remote/proj', agents: ['claude'], hosts: ['gpu'] });
  state = { ...state, forHost: 'gpu' };
  const onStatus = spy();
  const remoteQueueAddFn = spy(async () => ({ ok: false, error: 'auth failed' }));

  submitFinal(state, 'remote thing', {
    setForm: spy(), dispatch: spy(), onRefresh: spy(), onStatus,
    remoteQueueAddFn, readHostsFn: spy(() => ({})),
  });

  await Promise.resolve();
  await Promise.resolve();
  assert.equal(onStatus.calls.length, 1);
  assert.match(onStatus.calls[0][0], /gpu/);
  assert.match(onStatus.calls[0][0], /auth failed/);
});

test('submitFinal: remote branch — a rejected promise (catch path) also routes into onStatus, never throws', async () => {
  let state = initFormState({ path: '/remote/proj', agents: ['claude'], hosts: ['gpu'] });
  state = { ...state, forHost: 'gpu' };
  const onStatus = spy();
  const remoteQueueAddFn = spy(async () => { throw new Error('connection refused'); });

  assert.doesNotThrow(() => submitFinal(state, 'remote thing', {
    setForm: spy(), dispatch: spy(), onRefresh: spy(), onStatus,
    remoteQueueAddFn, readHostsFn: spy(() => ({})),
  }));

  await Promise.resolve();
  await Promise.resolve();
  assert.equal(onStatus.calls.length, 1);
  assert.match(onStatus.calls[0][0], /gpu/);
  assert.match(onStatus.calls[0][0], /connection refused/);
});

// -- removeEntry (list-view y/n remove confirmation) -------------------------

test('removeEntry: success — queueRemoveFn called with the id, confirm cleared, onRefresh fired, returns true', () => {
  const setConfirmId = spy();
  const onRefresh = spy();
  const queueRemoveFn = spy(() => true);

  const out = removeEntry('p-removeme', { setConfirmId, onRefresh, queueRemoveFn });

  assert.equal(out, true);
  assert.deepEqual(queueRemoveFn.calls, [['p-removeme']]);
  assert.deepEqual(setConfirmId.calls, [[null]]);
  assert.equal(onRefresh.calls.length, 1);
});

test('removeEntry: queueRemoveFn returning false (already-terminal/unknown id) is passed through unchanged', () => {
  const setConfirmId = spy();
  const onRefresh = spy();
  const queueRemoveFn = spy(() => false);

  const out = removeEntry('p-gone', { setConfirmId, onRefresh, queueRemoveFn });

  assert.equal(out, false);
  assert.deepEqual(setConfirmId.calls, [[null]]);
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
