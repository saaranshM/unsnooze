'use client';

import { useState } from 'react';
import Reveal from './Reveal.jsx';
import { TermWindow } from './Terminal.jsx';

const TABS = {
  status: (
    <pre className="term-body dash-body">
      <span className="d-amber">  ❯</span> <span className="d-ink">unsnooze</span> <span className="d-faint">z z z</span>{'                                          '}<span className="d-faint">daemon: running</span>{'\n\n'}
      <span className="d-ink">  claude</span>  <span className="d-faint">f3a1…</span>  ~/work/payments{'      '}<span className="d-amber">snoozed</span>{'   '}wakes 3:00 am <span className="d-faint">(in 2h 41m)</span>{'   '}<span className="d-faint">ctx ~152k tok</span>{'\n'}
      <span className="d-ink">  claude</span>  <span className="d-faint">9d07…</span>  ~/oss/unsnooze{'       '}<span className="d-green">resumed</span>{'   '}woke 8:01 pm · <span className="d-green">verified</span>{'\n'}
      <span className="d-ink">  codex</span>{'   '}<span className="d-faint">8c42…</span>  ~/work/ingest{'        '}<span className="d-amber">snoozed</span>{'   '}wakes 3:00 am <span className="d-faint">(in 2h 41m)</span>{'\n'}
      <span className="d-ink">  qwen</span>{'    '}<span className="d-faint">1be3…</span>  ~/exp/agents{'         '}<span className="d-rose">paused </span>{'   '}held by workspaceGuard · <span className="d-faint">resume-now to review</span>{'\n\n'}
      <span className="d-faint">  2 snoozed · 1 resumed · 1 paused — attach: tmux attach -t unsnooze-resumed</span>{'\n'}
    </pre>
  ),
  usage: (
    <pre className="term-body dash-body">
      <span className="d-faint">  account burn & time-to-limit · warnings at 80,95%</span>{'\n\n'}
      <span className="d-ink">  claude</span>  5h{'      '}<span className="d-amber">[█████████████░░░░░░░]</span>  ~64%  <span className="d-faint">(calibrated from 4 stops)</span>{'\n'}
      <span className="d-dim">          burn    ~31k weighted tok/min over last 42 active min</span>{'\n'}
      <span className="d-dim">          wall    ~1h 10m at this pace · window resets 8:00 pm</span>{'\n\n'}
      <span className="d-ink">  codex</span>   5h{'      '}<span className="d-green">[███░░░░░░░░░░░░░░░░░]</span>  5% used  <span className="d-faint">(exact)</span>{'\n'}
      <span className="d-dim">          monthly </span><span className="d-green">[██░░░░░░░░░░░░░░░░░░]</span><span className="d-dim">  5% used  (exact) · resets Aug 11</span>{'\n'}
      <span className="d-dim">          burn    idle — no active burn</span>{'\n\n'}
      <span className="d-faint">  estimates are a lower bound — exact claude % via: unsnooze usage --install-statusline</span>{'\n'}
    </pre>
  ),
  sessions: (
    <pre className="term-body dash-body">
      <span className="d-faint">  unsnooze-owned multiplexer sessions</span>{'\n\n'}
      <span className="d-ink">  unsnooze</span>{'          '}<span className="d-green">attached</span>{'   '}3 panes · claude ×2, codex ×1{'\n'}
      <span className="d-ink">  unsnooze-2</span>{'        '}detached{'   '}1 pane  · claude{'\n'}
      <span className="d-ink">  unsnooze-resumed</span>{'  '}detached{'   '}2 panes · revived overnight{'\n\n'}
      <span className="d-faint">  the daemon only ever creates `unsnooze-resumed` — a revived agent</span>{'\n'}
      <span className="d-faint">  never steals your interactive session name. clean up: unsnooze reap</span>{'\n'}
    </pre>
  ),
  doctor: (
    <pre className="term-body dash-body">
      <span className="d-green">  ✓</span> install is healthy.{'\n'}
      <span className="d-faint">  · resumer/daemon: running (pid 4821)</span>{'\n\n'}
      <span className="d-faint">  doctor reports problems, not a checklist — anything wrong shows as a ✗ finding</span>{'\n'}
      <span className="d-faint">  with a suggested fix, and `unsnooze doctor --fix` repairs what it safely can</span>{'\n'}
    </pre>
  ),
  logs: (
    <pre className="term-body dash-body">
      <span className="d-faint">  23:58:01</span> <span className="d-rose">limit</span>{'    '}claude f3a1 hit the 5h wall · resets 3:00 am{'\n'}
      <span className="d-faint">  23:58:01</span> <span className="d-dim">ledger</span>{'   '}recorded → ~/.unsnooze/state.json{'\n'}
      <span className="d-faint">  23:58:20</span> <span className="d-rose">limit</span>{'    '}codex 8c42 hit the 5h wall · resets 3:00 AM{'\n'}
      <span className="d-faint">  00:12:44</span> <span className="d-dim">notify</span>{'   '}osc → iTerm2 · “2 sessions snoozed until 3:00 am”{'\n'}
      <span className="d-faint">  03:00:02</span> <span className="d-amber">wake</span>{'     '}claude f3a1 · pane alive · foreground · typing resume{'\n'}
      <span className="d-faint">  03:00:09</span> <span className="d-amber">wake</span>{'     '}codex 8c42 · pane gone · reopening: codex resume 8c42{'\n'}
      <span className="d-faint">  03:00:12</span> <span className="d-green">verify</span>{'   '}both panes re-captured · no banner · <span className="d-green">done</span>{'\n'}
    </pre>
  ),
  fleet: (
    <pre className="term-body dash-body">
      <span className="d-faint">  3 hosts · R resume selected · C cancel · r refresh</span>{'\n\n'}
      <span className="d-green">  ●</span> <span className="d-ink">work</span>{'    '}<span className="d-green">online</span> <span className="d-faint">(42ms) · key</span>{'\n'}
      {'    '}<span className="d-amber">❯</span> <span className="d-rose">● STOPPED</span>{'  '}<span className="d-faint">f3a1c2d4</span>{'  '}claude{'  '}resets 3:00 am{'\n'}
      <span className="d-faint">        attach: ssh -t work 'tmux new -A -s unsnooze'</span>{'\n\n'}
      <span className="d-dim">  ◌</span> <span className="d-ink">mac</span>{'     '}<span className="d-amber">stale</span> <span className="d-faint">(2h old) · pw:keychain</span>{'\n'}
      <span className="d-faint">      (no stopped sessions)</span>{'\n\n'}
      <span className="d-amber">  ◐</span> <span className="d-ink">gpu</span>{'     '}<span className="d-amber">needs-auth</span> <span className="d-faint">(env var UNSNOOZE_PW_GPU is not set) · pw:env</span>{'\n'}
    </pre>
  ),
  prompts: (
    <pre className="term-body dash-body">
      <span className="d-faint">  queued prompts · a add · d remove · delivered in a NEW session at the reset</span>{'\n\n'}
      <span className="d-faint">  p-3f9a1c2e</span>  <span className="d-ink">claude</span>  ~/work/payments{'   '}next reset{'  '}<span className="d-amber">pending</span>{'    '}<span className="d-dim">"run the full test suite and fix…"</span>{'\n'}
      <span className="d-faint">  p-8b20d4aa</span>  <span className="d-ink">codex</span>{'   '}~/work/ingest{'     '}at 9:00 pm{'  '}<span className="d-amber">pending</span>{'    '}<span className="d-dim">"ship the release"</span>{'\n'}
      <span className="d-faint">  p-11c07e21</span>  <span className="d-ink">claude</span>  ~/oss/unsnooze{'    '}3:00 am{'     '}<span className="d-green">delivered</span>{'  '}<span className="d-dim">new session started ▶</span>{'\n\n'}
      <span className="d-faint">  one-shot: each prompt is consumed on delivery — pane-verified against the limit banner</span>{'\n'}
    </pre>
  ),
};

export default function Dashboard() {
  const [tab, setTab] = useState('status');
  return (
    <section id="dashboard">
      <Reveal>
        <p className="eyebrow">01:30 <span className="tick">·</span> if you're up anyway</p>
        <h2>A dashboard for <span className="hl">the small hours</span></h2>
        <p className="section-lede">
          <code className="chip">unsnooze dashboard</code> is a full-screen terminal UI —
          status, usage forecast, sessions, install doctor, live logs, queued prompts, and
          your whole ssh fleet, with mouse support: click tabs and rows, wheel-scroll the
          logs. Pipes,{' '}
          <code className="chip">CI</code>, and <code className="chip">--json</code> stay plain.
          Try the tabs.
        </p>
      </Reveal>
      <Reveal delay={0.1}>
        <TermWindow title="unsnooze dashboard">
          <div className="dash-tabs" role="tablist" aria-label="Dashboard tabs">
            {Object.keys(TABS).map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                className={`dash-tab${tab === t ? ' active' : ''}`}
                onClick={() => setTab(t)}
              >
                {t}
              </button>
            ))}
          </div>
          {TABS[tab]}
        </TermWindow>
        <p className="dash-hint">
          <b>m</b> toggles mouse mode · <b>?</b> help overlay · <b>q</b> quits — works down
          to an 80×24 terminal
        </p>
      </Reveal>
    </section>
  );
}