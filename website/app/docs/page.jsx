import Stars from '../../components/Stars.jsx';
import SiteNav from '../../components/SiteNav.jsx';
import SubFooter from '../../components/SubFooter.jsx';
import DocsNav, { DocsPager } from '../../components/DocsNav.jsx';
import { Shell, C } from '../../components/DocsKit.jsx';
import { JsonLd, breadcrumbs } from '../../lib/jsonld.js';
import DocsHashRedirect from './DocsHashRedirect.jsx';

export const metadata = {
  title: "Install unsnooze — setup, shell wrapper, and daily use",
  description:
    "Install unsnooze with npm and run the setup wizard: shell wrappers for claude and codex, the Claude StopFailure hook, the optional daemon, and what day-to-day use looks like once a session hits its usage limit.",
  alternates: { canonical: '/docs/' },
  openGraph: {
    title: "unsnooze docs — install and setup",
    description: "npm install, the setup wizard, and what changes day to day.",
    url: '/docs/',
  },
};

export default function DocsPage() {
  return (
    <div className="subpage">
      <div className="stars-layer stars-dim" aria-hidden="true"><Stars /></div>
      <JsonLd data={breadcrumbs([['unsnooze', '/'], ['Docs', '/docs/']])} />
      <DocsHashRedirect />
      <SiteNav page="docs" />
      <main className="wrap subpage-main">
        <header className="sub-hero">
          <p className="eyebrow">documentation</p>
          <h1 className="sub-title">Install and setup</h1>
          <p className="section-lede">
            Everything below is drawn from the shipped CLI — command output, defaults, and
            behavior as implemented. For the threat model, read{' '}
            <a href="https://github.com/saaranshM/unsnooze/blob/main/SECURITY.md">SECURITY.md</a>.
          </p>
        </header>

        <div className="docs-layout">
          <DocsNav current="/docs/" />

          <div className="docs-content">

            <section className="doc-sec" id="install">
              <h2>Getting started</h2>
              <p>You need <strong>Node ≥ 20</strong> and <strong>tmux ≥ 3.2</strong> or{' '}
                <strong>Zellij</strong>, on macOS, Linux, or Windows via WSL.</p>
              <Shell title="install">{`$ npm install -g unsnooze
$ unsnooze setup`}</Shell>
              <p>The setup wizard asks which agents to guard and which toggles you want, then wires
                everything up:</p>
              <ul>
                <li><strong>Shell wrappers</strong> into <C>~/.zshrc</C> / <C>~/.bashrc</C> — after
                  this, typing <C>claude</C> or <C>codex</C> runs the CLI inside a watched
                  multiplexer pane. You never call unsnooze directly to be protected.</li>
                <li><strong>The Claude <C>StopFailure</C> hook</strong> — the authoritative
                  limit-stop signal, carrying the session id.</li>
                <li><strong>Optionally the daemon</strong> (a launchd agent on macOS, a systemd user
                  unit on Linux) for GUI-surface watching and pre-wall usage warnings.</li>
                <li><strong><C>~/.unsnooze/config.json</C></strong> with your choices —
                  see <a href="/docs/settings/#settings">Settings</a>.</li>
              </ul>
              <p>Every file it touches is backed up first (<C>*.unsnooze-orig</C> pristine,{' '}
                <C>*.unsnooze-bak</C> rolling), and <C>unsnooze uninstall</C> removes every change.
                Verify the install any time with <C>unsnooze doctor</C> — it reports{' '}
                <em>problems</em>, not a checklist, so a healthy install is a one-liner:</p>
              <Shell title="unsnooze doctor">{`$ unsnooze doctor
unsnooze doctor: all clear — install is healthy.
  · resumer/daemon: running (pid 4821)`}</Shell>
              <p>Anything wrong comes back as a <C>✗</C> finding with a suggested fix, and{' '}
                <C>doctor --fix</C> repairs what it safely can. One nuance on requirements: tmux
                version isn't checked — any tmux runs, but reviving dead sessions uses env flags
                that need tmux ≥ 3.2.</p>
            </section>

            <section className="doc-sec" id="everyday">
              <h2>Day to day</h2>
              <p>Run your agents like always. When one hits its limit, unsnooze records the stop in{' '}
                <C>~/.unsnooze/state.json</C> — agent, session id, working directory, pane, and the
                reset time parsed from the banner — and wakes it when the limit lifts.</p>
              <Shell title="unsnooze status (plain / piped)">{`$ unsnooze status
  [STOPPED  ] f3a1c2d4  claude 5h      /Users/you/work/payments
              mux tmux · pane %12 · session unsnooze · via hook · resets 19/7/2026, 3:00:00 am (2h 41m) (absolute, from hook) · attempts 0/5 · ctx ~152k tok
  [RESUMED  ] 92d6f63d  claude 5h      /Users/you/oss/unsnooze
              mux tmux · pane %7 · session unsnooze · via cli · resets 18/7/2026, 4:11:00 pm (due now) (absolute, from scrape) · attempts 1/5 · attach: tmux attach -t unsnooze`}</Shell>
              <p>Each session is two lines: a header (status, 8-char id, agent, limit window,
                working directory) and a detail line (pane, how the stop was detected, the reset
                time with countdown and its provenance, attempts out of 5, plus{' '}
                <C>ctx ~152k tok</C> on stopped sessions and an attach hint on live ones).
                Statuses are <C>stopped</C>, <C>resuming</C>, <C>resumed</C>, <C>cancelled</C>,
                and <C>failed</C>.</p>
              <p>On an interactive terminal, <C>status</C>, <C>usage</C>, and <C>sessions</C> open
                the live dashboard instead; pipes, <C>CI</C>, <C>NO_COLOR</C>, and <C>--json</C>{' '}
                stay plain. The common interventions:</p>
              <Shell title="interventions">{`$ unsnooze message f3a1 "Run the tests first, then continue."
$ unsnooze resume-now f3a1     # don't wait for the reset time
$ unsnooze cancel --all        # stop tracking everything`}</Shell>
              <p>Not sure what it's about to do? <C>unsnooze preview</C> is a true dry-run: it
                prints exactly what would be typed, where, and why — or what's holding it back —
                and sends nothing. It shares its decision code with the real dispatcher, so it
                cannot drift from what dispatch actually does. It exits <strong>2</strong> when a
                wake is actionable right now, <strong>0</strong> otherwise — scriptable.</p>
            </section>

            <section className="doc-sec" id="rest">
              <h2>The rest of the docs</h2>
              <p>Setup is the whole of the required reading. Everything else is here when
                you need it:</p>
              <ul>
                <li><a href="/docs/commands/"><strong>Command reference</strong></a> — every
                  command with real output, the <C>unsnooze usage</C> forecast that tells you
                  when the wall arrives, and the prompt queue that starts the next piece of
                  work as a fresh session.</li>
                <li><a href="/docs/settings/"><strong>Settings and guards</strong></a> — every
                  key in <C>~/.unsnooze/config.json</C>, the guards that decide when
                  <em> not</em> to wake a session, and how notifications reach you.</li>
                <li><a href="/docs/fleet/"><strong>SSH multi-host fleet</strong></a> — watch
                  limit-stopped sessions on every machine you code on, plus GUI surfaces and
                  platform support.</li>
                <li><a href="/docs/troubleshooting/"><strong>Troubleshooting and
                  security</strong></a> — when a wake did not happen, what{' '}
                  <C>unsnooze doctor</C> reports, and the threat model.</li>
              </ul>
              <p>Shipped releases and the reasoning behind each change live in the{' '}
                <a href="/changelog/">changelog</a>; anything missing or wrong is worth{' '}
                <a href="/feedback/">reporting</a>.</p>
            </section>

          </div>
        </div>

        <DocsPager current="/docs/" />
      </main>
      <SubFooter />
    </div>
  );
}
