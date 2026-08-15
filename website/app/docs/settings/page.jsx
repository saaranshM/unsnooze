import Stars from '../../../components/Stars.jsx';
import SiteNav from '../../../components/SiteNav.jsx';
import SubFooter from '../../../components/SubFooter.jsx';
import DocsNav, { DocsPager } from '../../../components/DocsNav.jsx';
import { Shell, C } from '../../../components/DocsKit.jsx';
import { JsonLd, breadcrumbs } from '../../../lib/jsonld.js';

export const metadata = {
  title: "Settings and guards — every config key",
  description:
    "Every unsnooze config key and env override, the guards that catch a bad wake (workspaceGuard, contextGuard, usageWarn, menuAutoAnswer), and notification channels including native, OSC, bell, and phone push via ntfy.",
  alternates: { canonical: '/docs/settings/' },
  openGraph: {
    title: "unsnooze settings and guards",
    description: "Every config key, every guard, and how notifications are delivered.",
    url: '/docs/settings/',
  },
};

export default function SettingsDocsPage() {
  return (
    <div className="subpage">
      <div className="stars-layer stars-dim" aria-hidden="true"><Stars /></div>
      <JsonLd data={breadcrumbs([['unsnooze', '/'], ['Docs', '/docs/'], ['Settings', '/docs/settings/']])} />
      <SiteNav page="docs" />
      <main className="wrap subpage-main">
        <header className="sub-hero">
          <p className="eyebrow">documentation</p>
          <h1 className="sub-title">Settings and guards</h1>
          <p className="section-lede">
            Every key in <code className="chip">~/.unsnooze/config.json</code>, the guards that
            decide when <em>not</em> to wake a session, and how you get told about it.
          </p>
        </header>

        <div className="docs-layout">
          <DocsNav current="/docs/settings/" />

          <div className="docs-content">

            <section className="doc-sec" id="settings">
              <h2>Settings</h2>
              <p><C>unsnooze setup</C> writes <C>~/.unsnooze/config.json</C>; change anything later
                with <C>unsnooze config set &lt;key&gt; &lt;value&gt;</C>. The full surface, with
                defaults:</p>
              <div className="doc-table-scroll">
                <table className="doc-table">
                  <thead><tr><th>key</th><th>default</th><th>meaning</th></tr></thead>
                  <tbody>
                    <tr><td><C>multiplexer</C></td><td><C>auto</C></td><td><C>auto</C>, <C>tmux</C>, <C>zellij</C>, <C>herdr</C>, <C>cmux</C>, or <C>headless</C>. Auto prefers the multiplexer you're inside, then the only installed backend, tmux as tie-breaker — and <C>headless</C> only when none is installed, never ahead of a real pane.</td></tr>
                    <tr><td><C>autoResume</C></td><td><C>true</C></td><td>Master switch. Off = stops are still tracked, but nothing resumes until <C>resume-now</C> or turning it back on.</td></tr>
                    <tr><td><C>menuAutoAnswer</C></td><td><C>true</C></td><td>May unsnooze answer Claude's limit menu (send keys in your pane)? Off = watch-only.</td></tr>
                    <tr><td><C>notifications</C></td><td><C>true</C></td><td>Master switch for all notifications. Off silences every channel.</td></tr>
                    <tr><td><C>notifyChannel</C></td><td><C>auto</C></td><td><C>auto</C>, <C>native</C>, <C>osc</C>, or <C>bell</C> — see <a href="#notifications">Notifications</a>.</td></tr>
                    <tr><td><C>guiWatch</C></td><td><C>true</C></td><td>May the daemon watch session files for GUI-surface stops? Needs the daemon running.</td></tr>
                    <tr><td><C>resumeMessage</C></td><td><em>"Continue where you left off…"</em></td><td>The message typed to wake a session. Override per session with <C>unsnooze message &lt;id&gt;</C>.</td></tr>
                    <tr><td><C>launchExtraArgs.&lt;agent&gt;</C></td><td><C>""</C></td><td>Extra flags for the sessions <em>you</em> start through the wrapper. For long, context-heavy runs: <C>unsnooze config set launchExtraArgs.claude "--autocompact 400000"</C> so a session compacts instead of stalling. Revivals inherit them.</td></tr>
                    <tr><td><C>resumeMessages.&lt;agent&gt;</C></td><td><C>""</C></td><td>Per-agent override of <C>resumeMessage</C> (<C>.claude</C>, <C>.codex</C>, <C>.grok</C>, <C>.qwen</C>, <C>.kimi</C>, <C>.opencode</C>, <C>.agy</C>). Empty = global message.</td></tr>
                    <tr><td><C>agents.claude</C> / <C>agents.codex</C></td><td><C>true</C></td><td>Which CLIs are guarded.</td></tr>
                    <tr><td><C>agents.grok</C> … <C>agents.agy</C></td><td><C>false</C></td><td>Experimental adapters — off by default; enable in setup or e.g. <C>config set agents.qwen on</C>.</td></tr>
                    <tr><td><C>workspaceGuard</C></td><td><C>inform</C></td><td>Repo changed while a session slept? <C>inform</C> wakes it with a heads-up; <C>pause</C> holds it; <C>off</C> disables. See <a href="#guards">Guards</a>.</td></tr>
                    <tr><td><C>contextGuard</C></td><td><C>inform</C></td><td>Big cold context at wake? <C>inform</C> resumes and notifies; <C>pause</C> holds sessions above the threshold; <C>off</C> disables. Claude Code only for now.</td></tr>
                    <tr><td><C>contextGuardTokens</C></td><td><C>100000</C></td><td>Context-size threshold (tokens) for <C>contextGuard</C>.</td></tr>
                    <tr><td><C>usageWarn</C></td><td><C>notify</C></td><td>Pre-wall usage warnings from the daemon: <C>notify</C> or <C>off</C>.</td></tr>
                    <tr><td><C>usageWarnAt</C></td><td><C>80,95</C></td><td>Percent thresholds for usage warnings. Non-numeric values fall back to the default — never silently disable.</td></tr>
                    <tr><td><C>mouse</C></td><td><C>true</C></td><td>Mouse support in the dashboard; toggle live with <C>m</C>. Hold Shift (Option in iTerm2) to select text.</td></tr>
                    <tr><td><C>reapResumed</C></td><td><C>false</C></td><td>Opt-in: auto-close <C>resumed</C> panes idle longer than <C>reapIdleAfter</C>.</td></tr>
                    <tr><td><C>reapIdleAfter</C></td><td><C>604800000</C> (7d)</td><td>Idle age (ms) before an opt-in auto-reap closes a resumed pane.</td></tr>
                    <tr><td><C>updateCheck</C></td><td><C>true</C></td><td>Daily new-version check — a plain GET to the npm registry, nothing identifying.</td></tr>
                    <tr><td><C>ntfyTopic</C> / <C>ntfyServer</C> / <C>ntfyToken</C> / <C>ntfyPrivacy</C></td><td><C>""</C> / ntfy.sh / <C>""</C> / <C>full</C></td><td>Phone push via <a href="https://ntfy.sh">ntfy</a> — off until a topic is set. See <a href="#notifications">Notifications</a>.</td></tr>
                    <tr><td><C>remoteQueue</C></td><td><C>true</C></td><td>Set <strong>on the host being controlled</strong>: may other hosts queue prompts on this one (<C>prompt add --host &lt;this&gt;</C>)? Off = the queue verbs answer a typed <C>disabled</C> instead of silently dropping. See <a href="/docs/commands/#prompts">Queued prompts</a>.</td></tr>
                  </tbody>
                </table>
              </div>
              <p>Every setting also has an <C>UNSNOOZE_*</C> environment override
                (<C>src/settings.js</C>), and timings/paths are tunable via <C>UNSNOOZE_*</C> vars
                (<C>src/config.js</C>).</p>
              <h3>Multiplexer session names</h3>
              <p>Interactive launches own the base session name (default <C>unsnooze</C>); a second
                concurrent terminal takes <C>unsnooze-2</C>, and so on. The resumer daemon may{' '}
                <em>join</em> a live session but only ever <em>creates</em>{' '}
                <C>unsnooze-resumed</C> — a revived agent never steals the interactive name.
                Override with <C>UNSNOOZE_SESSION_NAME</C> and <C>UNSNOOZE_RESUME_SESSION</C>;
                attach with e.g. <C>tmux attach -t unsnooze-resumed</C>.</p>
            </section>

            <section className="doc-sec" id="guards">
              <h2>Guards</h2>
              <h3>workspaceGuard — the repo changed while it slept</h3>
              <p>The repo's HEAD and dirty state are fingerprinted at stop time and re-checked at
                wake. <C>inform</C> (default) resumes with a heads-up appended to the wake message
                — <em>"Heads up: this workspace changed while the session was stopped (HEAD
                abc1234 → def5678). Re-read the current state of the repo before continuing."</em>{' '}
                — while <C>pause</C> holds the session and <C>resume-now</C> shows the diff stat
                first; <C>off</C> disables.</p>
              <h3>contextGuard — the cold-cache wake tax</h3>
              <p>Providers cache your session's context, but that cache lives minutes, not hours.
                After a long limit stop, the <em>first</em> wake message — unsnooze's or a
                hand-typed "continue", identical cost — re-reads the entire conversation at full
                uncached price. A ~150k-token session can eat a real slice of the fresh window the
                moment it wakes.</p>
              <p>unsnooze estimates the size from the session transcript (shown as{' '}
                <C>ctx ~152k tok</C> in status). <C>inform</C> resumes and notifies you of the
                price; <C>pause</C> holds sessions above <C>contextGuardTokens</C> (default 100k)
                for a manual <C>resume-now</C>. What actually helps: <C>/compact</C> before the
                wall, and lean overnight sessions.</p>
              <h3>Overload is not a limit</h3>
              <p>Transient 5xx/529/429 errors take a seconds-scale backoff path
                ([30, 60, 120, 240, 300]s ± jitter) and never enter the ledger.</p>
            </section>

            <section className="doc-sec" id="notifications">
              <h2>Notifications</h2>
              <p>On limit-hit, resumed, and gave-up, unsnooze alerts you via the channel set in{' '}
                <C>notifyChannel</C>:</p>
              <div className="doc-table-scroll">
                <table className="doc-table">
                  <thead><tr><th>channel</th><th>behavior</th></tr></thead>
                  <tbody>
                    <tr><td><C>auto</C></td><td>OSC (when the terminal supports it) plus BEL on the pane tty; falls back to native only if OSC delivered nothing. No pane / non-tmux mux → native.</td></tr>
                    <tr><td><C>native</C></td><td>OS toast — macOS <C>osascript</C>, Linux <C>notify-send</C>, WSL/Windows PowerShell toast.</td></tr>
                    <tr><td><C>osc</C></td><td>Force OSC to attached client ttys; native if zero deliveries.</td></tr>
                    <tr><td><C>bell</C></td><td>BEL to the pane tty; native if undeliverable.</td></tr>
                  </tbody>
                </table>
              </div>
              <p>OSC support: iTerm2, kitty, WezTerm, Ghostty, and Warp get OSC 9; rxvt gets
                OSC 777; Apple Terminal, VS Code, Alacritty, and Zed are denylisted (native is used
                instead). OSC/BEL need tmux's client/pane tty APIs — under Zellij, notifications
                fall back to native.</p>
              <h3>Phone push via ntfy</h3>
              <Shell title="ntfy">{`$ unsnooze config set ntfyTopic "unsnooze-$(openssl rand -hex 8)"
$ unsnooze config set ntfyPrivacy terse   # keep paths out of push bodies`}</Shell>
              <p><strong>⚠ ntfy.sh topics are public — the name is the password.</strong> Use an
                unguessable topic like the generated one above, a <C>tk_…</C> access token
                (<C>ntfyToken</C>), or a self-hosted server (<C>ntfyServer</C>). Pushes fire{' '}
                <em>alongside</em> the local channel.</p>
            </section>

          </div>
        </div>

        <DocsPager current="/docs/settings/" />
      </main>
      <SubFooter />
    </div>
  );
}
