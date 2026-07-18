// Prompts tab: list + manage the one-shot prompt queue (src/prompt-queue.js)
// straight from the dashboard. Writes go through the same locked
// updateState() the daemon uses — safe to call next to it.
import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { homedir } from 'node:os';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { theme } from '../theme.js';
import { fmtCountdown } from '../data.js';
import { TextInput } from '../components/TextInput.js';
import { queueAdd, queueRemove } from '../../prompt-queue.js';
import { listAgents } from '../../agents/index.js';
import { getConfig } from '../../settings.js';
import { readHosts, remoteQueueAdd } from '../../fleet.js';
import { parseAtTime } from '../../prompt.js';

const h = React.createElement;

// -- small local helpers ---------------------------------------------------

// Duplicated from cli.js's shortenHome rather than imported: cli.js pulls in
// this dashboard module transitively (cli.js -> dashboard/run.js -> App.js),
// so importing it back here would be a real import cycle, not just a scary
// one. Five lines is cheaper than untangling that.
function shortenCwd(p) {
  if (typeof p !== 'string' || !p) return p;
  const home = homedir();
  if (p === home) return '~';
  return p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
}

// Same enablement rule the CLI's `unsnooze prompt add` picker uses.
function enabledAgentIds() {
  return listAgents().map(a => a.id).filter(id => getConfig(`agents.${id}`) !== false);
}

function fmtDue(e, now) {
  const futureBackoff = Number.isFinite(e.notBefore) && e.notBefore > now ? e.notBefore : null;
  const futureAt = Number.isFinite(e.atMs) && e.atMs > now ? e.atMs : null;
  const future = futureBackoff ?? futureAt;
  if (future != null) return fmtCountdown(future - now);
  return e.mode === 'now' ? 'now' : 'next reset';
}

function truncate(text, n = 50) {
  const s = String(text || '');
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

// -- add-form: pure step reducer (unit-test surface) -----------------------

export const WHEN_OPTIONS = ['next-reset', 'now', 'at'];
export const WHEN_LABELS = { 'next-reset': 'next reset', now: 'now', at: 'at…' };

export function initFormState({ path = '', agents = ['claude'], hosts = [] } = {}) {
  return {
    step: 'path',
    path, pathError: null,
    forHost: null,                                   // set once a remote host is chosen
    agents, agentIndex: Math.max(0, agents.indexOf('claude')),
    whenIndex: 0,
    atText: '', atMs: null, atError: null,
    hosts, hostIndex: 0,                              // 0 = local
    prompt: '',
    submitError: null,
  };
}

function clampIndex(i, len) {
  if (len <= 0) return 0;
  return ((i % len) + len) % len;
}

// One screen back per step; `null` means "nothing behind this — close the
// form" (only true step 1, with no host re-entry in progress).
function back(state) {
  switch (state.step) {
    case 'path': return state.forHost ? { ...state, step: 'host', forHost: null } : null;
    case 'agent': return { ...state, step: 'path' };
    case 'when': return { ...state, step: 'agent' };
    case 'at': return { ...state, step: 'when' };
    case 'host': return { ...state, step: 'when' };
    case 'prompt':
      if (state.forHost) return { ...state, step: 'path' };
      if (state.hosts.length) return { ...state, step: 'host' };
      return WHEN_OPTIONS[state.whenIndex] === 'at' ? { ...state, step: 'at' } : { ...state, step: 'when' };
    default: return null;
  }
}

// state -> state | null. `null` is a legitimate result (form closed) —
// callers feed it straight into setForm.
export function formReduce(state, event) {
  switch (event.type) {
    case 'PATH_CHANGE':
      return { ...state, path: event.value, pathError: null };
    case 'PATH_SUBMIT':
      if (!event.ok) return { ...state, pathError: event.error };
      // Coming back from a host pick: the re-entered path goes straight to
      // the prompt step — agent/when/host were already chosen this round.
      return { ...state, path: event.value, pathError: null, step: state.forHost ? 'prompt' : 'agent' };
    case 'AGENT_SELECT':
      return { ...state, agentIndex: clampIndex(event.index, state.agents.length) };
    case 'AGENT_CONFIRM':
      return { ...state, step: 'when' };
    case 'WHEN_SELECT':
      return { ...state, whenIndex: clampIndex(event.index, WHEN_OPTIONS.length) };
    case 'WHEN_CONFIRM':
      return WHEN_OPTIONS[state.whenIndex] === 'at'
        ? { ...state, step: 'at' }
        : { ...state, step: state.hosts.length ? 'host' : 'prompt' };
    case 'AT_CHANGE':
      return { ...state, atText: event.value, atError: null };
    case 'AT_SUBMIT':
      if (!event.ok) return { ...state, atError: event.error };
      return {
        ...state, atText: event.value, atMs: event.atMs, atError: null,
        step: state.hosts.length ? 'host' : 'prompt',
      };
    case 'HOST_SELECT':
      return { ...state, hostIndex: clampIndex(event.index, state.hosts.length + 1) };
    case 'HOST_CONFIRM':
      if (state.hostIndex === 0) return { ...state, forHost: null, step: 'prompt' };
      // Remote path differs from local — clear the prefill and re-collect it.
      return { ...state, forHost: state.hosts[state.hostIndex - 1], path: '', pathError: null, step: 'path' };
    case 'PROMPT_CHANGE':
      return { ...state, prompt: event.value, submitError: null };
    case 'SUBMIT_ERROR':
      return { ...state, submitError: event.error };
    case 'BACK':
      return back(state);
    default:
      return state;
  }
}

// -- add-form rendering ------------------------------------------------------

function StepSelect({ title, options, index, onSelect, onConfirm, onBack, hint }) {
  useInput((input, key) => {
    if (key.escape) { onBack(); return; }
    if (key.return) { onConfirm(); return; }
    if (input === 'j' || key.downArrow) { onSelect((index + 1) % options.length); return; }
    if (input === 'k' || key.upArrow) { onSelect((index - 1 + options.length) % options.length); }
  });
  return h(Box, { flexDirection: 'column' },
    h(Text, { color: theme.accent, bold: true }, title),
    h(Box, { marginTop: 1, flexDirection: 'column' },
      ...options.map((label, i) =>
        h(Text, { key: label + i, color: i === index ? theme.bright : theme.muted, bold: i === index },
          `${i === index ? '❯ ' : '  '}${label}`)),
    ),
    h(Text, { color: theme.muted, dimColor: true }, hint || 'j/k select · enter confirm · esc back'),
  );
}

function PathStep({ state, dispatch }) {
  const label = state.forHost ? `path on ${state.forHost}` : 'project path';
  return h(Box, { flexDirection: 'column' },
    h(Text, { color: theme.accent, bold: true }, `add prompt — ${label}`),
    h(Box, { marginTop: 1 },
      h(Text, { color: theme.muted }, '> '),
      h(TextInput, {
        key: state.forHost || 'local',
        value: state.path,
        placeholder: '/absolute/path',
        onChange: (value) => dispatch({ type: 'PATH_CHANGE', value }),
        onSubmit: (value) => {
          const v = value.trim();
          if (!isAbsolute(v)) { dispatch({ type: 'PATH_SUBMIT', ok: false, error: 'path must be absolute' }); return; }
          if (state.forHost) {
            // Remote path — no local fs to check against.
            dispatch({ type: 'PATH_SUBMIT', ok: true, value: v });
            return;
          }
          if (!existsSync(v) || !statSync(v).isDirectory()) {
            dispatch({ type: 'PATH_SUBMIT', ok: false, error: 'no such directory' });
            return;
          }
          dispatch({ type: 'PATH_SUBMIT', ok: true, value: v });
        },
        onCancel: () => dispatch({ type: 'BACK' }),
      }),
    ),
    state.pathError ? h(Text, { color: theme.crit }, state.pathError) : null,
    h(Text, { color: theme.muted, dimColor: true }, 'enter to continue · esc to close'),
  );
}

function AgentStep({ state, dispatch }) {
  return h(StepSelect, {
    title: 'add prompt — agent',
    options: state.agents,
    index: state.agentIndex,
    onSelect: (i) => dispatch({ type: 'AGENT_SELECT', index: i }),
    onConfirm: () => dispatch({ type: 'AGENT_CONFIRM' }),
    onBack: () => dispatch({ type: 'BACK' }),
  });
}

function WhenStep({ state, dispatch }) {
  return h(StepSelect, {
    title: 'add prompt — when',
    options: WHEN_OPTIONS.map(o => WHEN_LABELS[o]),
    index: state.whenIndex,
    onSelect: (i) => dispatch({ type: 'WHEN_SELECT', index: i }),
    onConfirm: () => dispatch({ type: 'WHEN_CONFIRM' }),
    onBack: () => dispatch({ type: 'BACK' }),
  });
}

function AtStep({ state, dispatch }) {
  return h(Box, { flexDirection: 'column' },
    h(Text, { color: theme.accent, bold: true }, 'add prompt — at (e.g. "7pm", "+2h30m", "2026-07-20 09:00")'),
    h(Box, { marginTop: 1 },
      h(Text, { color: theme.muted }, '> '),
      h(TextInput, {
        value: state.atText,
        placeholder: '7pm',
        onChange: (value) => dispatch({ type: 'AT_CHANGE', value }),
        onSubmit: (value) => {
          const atMs = parseAtTime(value);
          if (atMs == null) { dispatch({ type: 'AT_SUBMIT', ok: false, error: `could not parse "${value}"` }); return; }
          dispatch({ type: 'AT_SUBMIT', ok: true, value, atMs });
        },
        onCancel: () => dispatch({ type: 'BACK' }),
      }),
    ),
    state.atError ? h(Text, { color: theme.crit }, state.atError) : null,
    h(Text, { color: theme.muted, dimColor: true }, 'enter to continue · esc back'),
  );
}

function HostStep({ state, dispatch }) {
  return h(StepSelect, {
    title: 'add prompt — host',
    options: ['local', ...state.hosts],
    index: state.hostIndex,
    onSelect: (i) => dispatch({ type: 'HOST_SELECT', index: i }),
    onConfirm: () => dispatch({ type: 'HOST_CONFIRM' }),
    onBack: () => dispatch({ type: 'BACK' }),
  });
}

function PromptStep({ state, dispatch, onSubmitFinal }) {
  const agent = state.agents[state.agentIndex];
  const when = WHEN_LABELS[WHEN_OPTIONS[state.whenIndex]];
  return h(Box, { flexDirection: 'column' },
    h(Text, { color: theme.accent, bold: true },
      `add prompt — text (${state.forHost ? `${state.forHost}: ` : ''}${agent}, ${when})`),
    h(Box, { marginTop: 1 },
      h(Text, { color: theme.muted }, '> '),
      h(TextInput, {
        value: state.prompt,
        placeholder: 'what should it do?',
        onChange: (value) => dispatch({ type: 'PROMPT_CHANGE', value }),
        onSubmit: onSubmitFinal,
        onCancel: () => dispatch({ type: 'BACK' }),
      }),
    ),
    state.submitError ? h(Text, { color: theme.crit }, state.submitError) : null,
    h(Text, { color: theme.muted, dimColor: true }, 'enter to queue · esc back'),
  );
}

const STEP_COMPONENTS = { agent: AgentStep, when: WhenStep, at: AtStep, host: HostStep };

// -- add-form: submit/remove handlers (unit-test surface) -------------------

// Core result-handling for the add-form's final "queue it" step, pulled out
// of the component so the local/remote branches, duplicate-error formatting,
// and success wiring (onRefresh/onStatus/setForm) can be unit-tested without
// mounting ink or hitting a real queue/ssh round trip. Deps are injected —
// the component calls this with the real queueAdd/remoteQueueAdd/readHosts;
// tests pass stubs.
export function submitFinal(state, value, {
  setForm, dispatch, onRefresh, onStatus,
  queueAddFn = queueAdd, remoteQueueAddFn = remoteQueueAdd, readHostsFn = readHosts,
} = {}) {
  const agent = state.agents[state.agentIndex];
  const mode = WHEN_OPTIONS[state.whenIndex];
  const atMs = mode === 'at' ? state.atMs : null;

  if (state.forHost) {
    const hostName = state.forHost;
    const cwd = state.path;
    const entry = readHostsFn()[hostName];
    setForm(null); // fire-and-forget — the ssh round trip reports back later
    remoteQueueAddFn(hostName, { cwd, agent, prompt: value, mode, atMs }, { entryOrDest: entry })
      .then((res) => {
        onStatus?.(res.ok
          ? `prompts: queued ${res.id || ''} for ${agent} on ${hostName}:${shortenCwd(cwd)}`
          : `prompts: queue add on ${hostName} failed — ${res.error || 'unknown error'}`);
      })
      .catch((e) => onStatus?.(`prompts: queue add on ${hostName} failed — ${e.message}`));
    return;
  }

  const result = queueAddFn({ cwd: state.path, agent, prompt: value, mode, atMs });
  if (!result.ok) {
    dispatch({
      type: 'SUBMIT_ERROR',
      error: result.error === 'duplicate'
        ? `duplicate — matches existing queued prompt ${result.existing?.id}`
        : result.error,
    });
    return;
  }
  setForm(null);
  onRefresh?.();
  onStatus?.(`prompts: queued ${result.entry.id} for ${agent} in ${shortenCwd(state.path)}`);
}

// Same idea for the list view's y/n remove confirmation — pulled out so the
// queueRemove call and its onRefresh wiring have a seam a test can drive
// with a stub, without going through useInput's raw keypress handling.
export function removeEntry(id, { setConfirmId, onRefresh, queueRemoveFn = queueRemove } = {}) {
  const removed = queueRemoveFn(id);
  setConfirmId(null);
  onRefresh?.();
  return removed;
}

// -- tab -------------------------------------------------------------------

export function PromptsTab({
  data, now = Date.now(), sessions = [], selected = 0, onSelect,
  onRefresh, onStatus, onFormOpenChange,
  initialForm = null, // test seam only — App.js never passes this; lets tests
                       // mount straight into a given wizard step without
                       // needing to simulate raw keypresses through useInput.
  initialConfirmId = null, // test seam only, same idea as initialForm — lets
                            // a test mount straight into the y/n remove
                            // confirmation without simulating raw keypresses.
} = {}) {
  const [form, setForm] = useState(initialForm);
  const [confirmId, setConfirmId] = useState(initialConfirmId);
  const entries = data || [];

  // Tell the parent whenever the form OR the remove y/n confirmation is
  // active, so it can suppress the global tab-switch/quit/refresh/selection
  // keys — otherwise 'q' during a confirm quits the whole dashboard instead
  // of being swallowed by the "everything but y/n/esc" guard below, and j/k
  // moves the list selection out from under the entry being confirmed. And
  // on unmount (e.g. a mouse click away to another tab mid-form/confirm) so
  // that flag can never get stuck true and lock out keyboard input.
  useEffect(() => { onFormOpenChange?.(form != null || confirmId != null); }, [form, confirmId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onFormOpenChange?.(false), []); // eslint-disable-line react-hooks/exhaustive-deps

  const dispatch = (event) => setForm(prev => (prev == null ? prev : formReduce(prev, event)));

  const onSubmitFinal = (value) => submitFinal(form, value, { setForm, dispatch, onRefresh, onStatus });

  useInput((input, key) => {
    if (confirmId) {
      if (input === 'y') { removeEntry(confirmId, { setConfirmId, onRefresh }); return; }
      if (input === 'n' || key.escape) { setConfirmId(null); }
      return; // swallow everything else while a remove is pending confirmation
    }
    if (input === 'a') {
      setForm(initFormState({
        path: sessions?.[0]?.cwd || process.cwd(),
        agents: enabledAgentIds(),
        hosts: Object.keys(readHosts()),
      }));
      return;
    }
    if ((input === 'd' || input === 'x') && entries.length) {
      const entry = entries[Math.min(selected, entries.length - 1)];
      if (entry) setConfirmId(entry.id);
    }
  }, { isActive: form == null });

  if (!data) return h(Text, { color: theme.muted }, 'Loading…');

  let formView = null;
  if (form) {
    if (form.step === 'path') formView = h(PathStep, { state: form, dispatch });
    else if (form.step === 'prompt') formView = h(PromptStep, { state: form, dispatch, onSubmitFinal });
    else {
      const StepComp = STEP_COMPONENTS[form.step];
      formView = StepComp ? h(StepComp, { state: form, dispatch }) : null;
    }
    return formView;
  }

  return h(Box, { flexDirection: 'column' },
    h(Text, { color: theme.muted }, `${entries.length} queued prompt(s)`),
    h(Text, null, ' '),
    entries.length === 0
      ? h(Text, { color: theme.muted, dimColor: true }, 'no queued prompts — press a to add')
      : entries.map((e, i) => {
        const sel = i === selected;
        return h(Text, { key: e.id },
          h(Text, { color: theme.accent, bold: true }, sel ? '❯ ' : '  '),
          h(Text, { color: theme.bright, bold: sel }, e.id),
          h(Text, { color: sel ? theme.bright : theme.muted },
            `  ${(e.agent || 'claude').padEnd(6)} ${shortenCwd(e.cwd || '').slice(0, 24).padEnd(24)} `
            + `${fmtDue(e, now).padEnd(10)} ${(e.status || '').padEnd(9)} "${truncate(e.prompt)}"`),
        );
      }),
    confirmId ? h(Text, { color: theme.warn }, `remove ${confirmId}? (y/n)`) : null,
    h(Text, { color: theme.muted, dimColor: true }, 'a add · d/x remove'),
  );
}
