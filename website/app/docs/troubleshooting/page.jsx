import Stars from '../../../components/Stars.jsx';
import SiteNav from '../../../components/SiteNav.jsx';
import SubFooter from '../../../components/SubFooter.jsx';
import DocsNav, { DocsPager } from '../../../components/DocsNav.jsx';
import { Shell, C } from '../../../components/DocsKit.jsx';
import { JsonLd, breadcrumbs } from '../../../lib/jsonld.js';

export const metadata = {
  title: "Troubleshooting — when a session did not resume",
  description:
    "Fix an unsnooze session that did not wake: what unsnooze doctor reports, why a limit banner may be missed, the security model and threat boundaries, and how to run the test suite and end-to-end simulation locally.",
  alternates: { canonical: '/docs/troubleshooting/' },
  openGraph: {
    title: "unsnooze troubleshooting and security",
    description: "When a wake did not happen, what doctor tells you, and the threat model.",
    url: '/docs/troubleshooting/',
  },
};

export default function TroubleshootingDocsPage() {
  return (
    <div className="subpage">
      <div className="stars-layer stars-dim" aria-hidden="true"><Stars /></div>
      <JsonLd data={breadcrumbs([['unsnooze', '/'], ['Docs', '/docs/'], ['Troubleshooting', '/docs/troubleshooting/']])} />
      <SiteNav page="docs" />
      <main className="wrap subpage-main">
        <header className="sub-hero">
          <p className="eyebrow">documentation</p>
          <h1 className="sub-title">Troubleshooting and security</h1>
          <p className="section-lede">
            When a wake did not happen, start with <code className="chip">unsnooze doctor</code>.
            The security model and the local dev loop follow.
          </p>
        </header>

        <div className="docs-layout">
          <DocsNav current="/docs/troubleshooting/" />

          <div className="docs-content">

            <section className="doc-sec" id="troubleshooting">
              <h2>Troubleshooting</h2>
              <ul>
                <li><strong>Something looks off?</strong> <C>unsnooze doctor</C> checks the whole
                  install; <C>--fix</C> repairs what it can (including retiring leftovers of the
                  old claude-session-guard install).</li>
                <li><strong>What has it been doing?</strong> <C>unsnooze logs -f</C> follows the
                  log live; the dashboard's logs tab scrolls back with the mouse wheel.</li>
                <li><strong>A wake didn't happen?</strong> <C>unsnooze preview &lt;id&gt;</C> tells
                  you exactly what's holding it back. After every real wake the pane is
                  re-captured; if the limit banner reappears, unsnooze reschedules from the fresh
                  banner, capped at five attempts.</li>
                <li><strong>A banner wasn't detected?</strong> <C>unsnooze report [agent]</C>{' '}
                  captures the pane so you can paste it into an issue — that's how the experimental
                  adapters get good.</li>
                <li><strong>Panes piling up?</strong> <C>unsnooze reap</C> lists finished panes and
                  empty sessions (dry-run); <C>--yes</C> closes them.</li>
                <li><strong>Leaving?</strong> <C>unsnooze uninstall</C> removes wrappers and hooks;{' '}
                  <C>--purge</C> removes state too.</li>
              </ul>

              <h3>Start with the symptom</h3>
              <p>Almost every report falls into one of these. The distinction that matters most
                is whether the session was <em>recorded</em> at all — that separates a detection
                problem from a wake problem, and they have different fixes.</p>
              <ul>
                <li><strong>Typing <C>claude</C> starts nothing watched.</strong> The shell
                  wrapper lives in <C>~/.zshrc</C> or <C>~/.bashrc</C>, so it only applies to
                  shells started after <C>unsnooze setup</C> ran. Open a new terminal, then
                  confirm with <C>unsnooze doctor</C>. Nothing is protected until the wrapper is
                  loaded, because the wrapper is the entry point — you never invoke unsnooze
                  directly.</li>
                <li><strong>The limit hit but nothing was recorded.</strong> A detection
                  problem. Either the <C>StopFailure</C> hook is not installed (<C>doctor</C>{' '}
                  reports it) or the banner wording was not recognised. Capture it with{' '}
                  <C>unsnooze report</C> — an unmatched banner is a one-release fix, but only if
                  someone sends the text.</li>
                <li><strong>It was recorded but never woke.</strong> A wake problem, and{' '}
                  <C>unsnooze preview &lt;id&gt;</C> names the reason rather than guessing. The
                  usual answers are a guard deliberately holding it — see{' '}
                  <a href="/docs/settings/#guards">guards</a> — or the five-attempt cap having
                  been reached.</li>
                <li><strong>It woke, but at the wrong time.</strong> Read the provenance in{' '}
                  <C>unsnooze status</C>: a reset shown as <C>(absolute, from hook)</C> came from
                  the agent itself, while <C>(absolute, from scrape)</C> was read off the pane.
                  A reset that looks hours out is a parsing bug worth reporting with the banner
                  text attached — reset times are always absolute, never a relative countdown.</li>
                <li><strong>It resumed while still rate-limited.</strong> Expected and handled:
                  the pane is re-captured after every wake, and if the banner is still there
                  unsnooze reschedules from the fresh one. Overload is not a limit, so a
                  transient overload message is not treated as one.</li>
                <li><strong>The machine was asleep at reset time.</strong> Wakes are dispatched
                  by the daemon — a launchd agent on macOS, a systemd user unit on Linux. If you
                  declined it during setup, nothing runs while the terminal is closed;{' '}
                  <C>doctor</C> reports whether it is running and under which pid.</li>
              </ul>
            </section>

            <section className="doc-sec" id="security">
              <h2>Security model</h2>
              <p>unsnooze is a <strong>scheduler that presses your keys — not an
                auto-approver</strong>. The short version of the contract:</p>
              <ul>
                <li>Keys are typed only after proving the pane is yours — identity (ownership stamp
                  or process-id + birth-time lease; pane ids get recycled, so a mismatch vetoes)
                  and liveness (your agent foreground, not mid-stream). Unprovable → a fresh
                  session is opened instead of typing.</li>
                <li>Claude's limit menu is read before any key is sent; unreadable → nothing is
                  pressed. It will never select "Upgrade your plan."</li>
                <li>No <C>--dangerously-skip-permissions</C>, no auto-trust, no auto-approve, no
                  touching MCP config — your agent's own permission model governs everything after
                  the wake.</li>
                <li>Nearly zero network: one daily version check, plus ntfy only if you configure
                  it. Zero telemetry; state stays in <C>~/.unsnooze</C>.</li>
                <li>Releases are published to npm by CI with provenance.</li>
              </ul>
              <p><strong>Honest limits:</strong> unsnooze does inject keystrokes into your live
                terminal, and it does not sandbox your agent or defend against prompt injection —
                that's your agent's job. Full threat model and vulnerability reporting:{' '}
                <a href="https://github.com/saaranshM/unsnooze/blob/main/SECURITY.md">SECURITY.md</a>.</p>
            </section>

            <section className="doc-sec" id="development">
              <h2>Development</h2>
              <Shell title="dev loop">{`$ npm test                      # unit tests (node:test)
$ ./scripts/e2e-simulate.sh     # full detect → wait → re-open cycle in a
                                # scratch tmux session (no real limits needed)
$ bash -n scripts/e2e-zellij.sh # syntax-check the Zellij smoke test
$ vhs demo/demo.tape            # regenerate the demo gif (brew install vhs)`}</Shell>
              <p>Releases are tagged (<C>git tag v&lt;version&gt;</C>, then{' '}
                <C>git push origin v&lt;version&gt;</C>) and published to npm by CI with provenance
                via trusted publishing — see <C>.github/workflows/release.yml</C>. Contributions:
                open an <a href="https://github.com/saaranshM/unsnooze/issues">issue</a> first for
                anything behavioral; adapter banner captures (<C>unsnooze report</C>) are always
                welcome.</p>
            </section>

          </div>
        </div>

        <DocsPager current="/docs/troubleshooting/" />
      </main>
      <SubFooter />
    </div>
  );
}
