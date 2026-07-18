import SiteNav from '../components/SiteNav.jsx';
import SubFooter from '../components/SubFooter.jsx';

const SECTIONS = [
  ['install', 'Getting started'],
  ['everyday', 'Day to day'],
  ['commands', 'Command reference'],
  ['settings', 'Settings'],
  ['usage', 'Usage forecast'],
  ['fleet', 'Multi-host fleet'],
  ['notifications', 'Notifications'],
  ['gui', 'GUI surfaces'],
  ['guards', 'Guards'],
  ['platforms', 'Platforms'],
  ['security', 'Security model'],
  ['troubleshooting', 'Troubleshooting'],
  ['development', 'Development'],
];

function Shell({ title = 'terminal', children }) {
  return (
    <div className="term docs-term">
      <div className="term-bar"><i /><i /><i /><span className="title">{title}</span></div>
      <pre className="term-body docs-term-body">{children}</pre>
    </div>
  );
}

const C = ({ children }) => <code className="chip">{children}</code>;

export default function DocsPage() {
  return (
    <div className="subpage">
      <SiteNav root="../" page="docs" />
      <main className="wrap subpage-main">
        <header className="sub-hero">
          <p className="eyebrow">documentation</p>
          <h1 className="sub-title">unsnooze docs</h1>
          <p className="section-lede">
            Everything below is drawn from the shipped CLI — command output, defaults, and
            behavior as implemented. For the threat model, read{' '}
            <a href="https://github.com/saaranshM/unsnooze/blob/main/SECURITY.md">SECURITY.md</a>.
          </p>
        </header>

        <div className="docs-layout">
          <aside className="docs-side">
            <nav aria-label="Docs sections">
              {SECTIONS.map(([id, title]) => (
                <a key={id} href={`#${id}`}>{title}</a>
              ))}
            </nav>
          </aside>

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
                  see <a href="#settings">Settings</a>.</li>
              </ul>
              <p>Every file it touches is backed up first (<C>*.unsnooze-orig</C> pristine,{' '}
                <C>*.unsnooze-bak</C> rolling), and <C>unsnooze uninstall</C> removes every change.
                Verify the install any time:</p>
              <Shell title="unsnooze doctor">{`$ unsnooze doctor
  ✓ shell wrappers installed (~/.zshrc)
  ✓ claude StopFailure hook installed
  ✓ tmux 3.5a found · Zellij not installed (ok)
  ✓ daemon unit loaded (launchd) · PATH ok
  ✓ state.json healthy`}</Shell>
            </section>

            <section className="doc-sec" id="everyday">
              <h2>Day to day</h2>
              <p>Run your agents like always. When one hits its limit, unsnooze records the stop in{' '}
                <C>~/.unsnooze/state.json</C> — agent, session id, working directory, pane, and the
                reset time parsed from the banner — and wakes it when the limit lifts.</p>
              <Shell title="unsnooze status">{`$ unsnooze status
  claude  f3a1…  ~/work/payments   snoozed   wakes 3:00 am (in 2h 41m)   ctx ~152k tok
  codex   8c42…  ~/work/ingest     snoozed   wakes 3:00 am (in 2h 41m)
  claude  9d07…  ~/oss/unsnooze    resumed   woke 8:01 pm · verified`}</Shell>
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

            <section className="doc-sec" id="commands">
              <h2>Command reference</h2>
              <p>Verbatim from <C>unsnooze help</C> (v1.13):</p>
              <Shell title="unsnooze help">{`unsnooze — wakes every limit-stopped AI coding session when the limit resets

Usage:
  unsnooze [claude args...]        run claude under limit-watch (default)
  unsnooze _run <agent> [args...]  run a specific agent CLI under limit-watch
  unsnooze status                  list tracked sessions + reset countdowns
  unsnooze resume-now [id|--all]   resume stopped session(s) immediately
  unsnooze cancel [id|--all]       stop tracking session(s)
  unsnooze message <id|--all> <t>  set a per-session wake message (--clear to reset)
  unsnooze sessions                list unsnooze-owned mux sessions + panes
  unsnooze reap [--dry-run|--yes]  close terminal-record panes / empty sessions
                                   (default: dry-run; pass --yes to apply)
  unsnooze doctor [--fix]          check install health; find (and with --fix
                                   retire) leftovers of the old
                                   claude-session-guard install
  unsnooze preview [id]            dry-run: what WOULD happen right now, and
                                   why — nothing is typed or opened (exit 2
                                   when a wake is actionable, else 0)
  unsnooze dashboard [tab]         live TUI (status|usage|sessions|doctor|logs|fleet)
                                   — q to quit, mouse: click/wheel (m toggles)
  unsnooze hosts [add|rm|list]     register ssh hosts for the fleet view
  unsnooze fleet [--json]          all hosts' sessions (hosts add <name> first)
  unsnooze usage [--json]          account burn rate & time-to-limit forecast
                                   (--install-statusline for exact Claude %,
                                    --uninstall-statusline to remove it)
  unsnooze logs [-f]               show (or follow) the unsnooze log
  unsnooze update                  update unsnooze itself to the latest version
  unsnooze daemon                  persistent watcher for GUI sessions (VS Code
                                   extension, desktop apps) — no live pane needed
                                   to detect; revival opens in tmux or Zellij
  unsnooze config [list|get|set]   view or change settings (toggles, global +
                                   per-agent resume messages, notifyChannel
                                   auto|native|osc|bell, updateCheck)
  unsnooze setup                   interactive setup wizard (agents + toggles)
  unsnooze install [--yes]         wire up shell wrappers + hooks (non-interactive)
  unsnooze uninstall [--purge]     remove wrappers + hooks (and state with --purge)
  unsnooze report [agent] [pane]   capture a pane to report an undetected banner
  unsnooze help                    show this help (also -h / --help)`}</Shell>
            </section>

            <section className="doc-sec" id="settings">
              <h2>Settings</h2>
              <p><C>unsnooze setup</C> writes <C>~/.unsnooze/config.json</C>; change anything later
                with <C>unsnooze config set &lt;key&gt; &lt;value&gt;</C>. The full surface, with
                defaults:</p>
              <div className="doc-table-scroll">
                <table className="doc-table">
                  <thead><tr><th>key</th><th>default</th><th>meaning</th></tr></thead>
                  <tbody>
                    <tr><td><C>multiplexer</C></td><td><C>auto</C></td><td><C>auto</C>, <C>tmux</C>, or <C>zellij</C>. Auto prefers the multiplexer you're inside, then the only installed backend, tmux as tie-breaker.</td></tr>
                    <tr><td><C>autoResume</C></td><td><C>true</C></td><td>Master switch. Off = stops are still tracked, but nothing resumes until <C>resume-now</C> or turning it back on.</td></tr>
                    <tr><td><C>menuAutoAnswer</C></td><td><C>true</C></td><td>May unsnooze answer Claude's limit menu (send keys in your pane)? Off = watch-only.</td></tr>
                    <tr><td><C>notifications</C></td><td><C>true</C></td><td>Master switch for all notifications. Off silences every channel.</td></tr>
                    <tr><td><C>notifyChannel</C></td><td><C>auto</C></td><td><C>auto</C>, <C>native</C>, <C>osc</C>, or <C>bell</C> — see <a href="#notifications">Notifications</a>.</td></tr>
                    <tr><td><C>guiWatch</C></td><td><C>true</C></td><td>May the daemon watch session files for GUI-surface stops? Needs the daemon running.</td></tr>
                    <tr><td><C>resumeMessage</C></td><td><em>"Continue where you left off…"</em></td><td>The message typed to wake a session. Override per session with <C>unsnooze message &lt;id&gt;</C>.</td></tr>
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

            <section className="doc-sec" id="usage">
              <h2>Usage forecast</h2>
              <p>Recovery is half the job; <C>unsnooze usage</C> is the other half — knowing when
                the wall is coming so you can <C>/compact</C>, pause, or switch models first.</p>
              <Shell title="unsnooze usage">{`$ unsnooze usage
unsnooze usage — account burn & time-to-limit  (daemon: running · warnings at 80,95%)

  claude  5h      [█████████████░░░░░░░]  ~64%  (calibrated from 4 stops)
          burn    ~31k weighted tok/min over last 42 active min
          wall    ~1h 10m at this pace · window resets 8:00 pm (absolute)

  codex   5h      [███░░░░░░░░░░░░░░░░░]  5% used  (exact)
          monthly [██░░░░░░░░░░░░░░░░░░]  5% used  (exact) · resets Aug 11
          burn    idle — no active burn`}</Shell>
              <p>Every figure carries its provenance — never a bare percentage:</p>
              <ul>
                <li><strong><C>(exact)</C></strong> — Codex always (local <C>used_percent</C> +
                  epoch reset). Claude only with the opt-in statusline shim, which persists Claude
                  Code's server-authoritative rate limits.</li>
                <li><strong><C>(calibrated from N stops)</C></strong> — Claude token burn against a
                  ceiling learned from <em>your</em> recorded limit stops. Not plan presets.</li>
                <li><strong><C>(estimated)</C></strong> — used tokens + burn shown; ceiling unknown
                  until the first observed stop.</li>
              </ul>
              <Shell title="statusline shim (opt-in)">{`$ unsnooze usage --install-statusline    # exact Claude % (chains your statusLine)
$ unsnooze usage --uninstall-statusline  # restore your original statusLine`}</Shell>
              <p>With the daemon running, warnings fire at the <C>usageWarnAt</C> percent bands and
                at 30 / 10 minutes to the wall at your current pace, deduped once per window.
                Warnings may <em>suggest</em> <C>/compact</C>; unsnooze never auto-types it.{' '}
                <C>usage --json</C> emits a stable machine shape and exits 2 past the warn
                threshold — useful in scripts and statuslines.</p>
              <p><strong>Honest limits:</strong> Claude transcript sums are a lower bound —
                subscription quotas are account-pooled with claude.ai and the desktop app. Without
                the shim, Claude tops out at calibrated/estimated.</p>
            </section>

            <section className="doc-sec" id="fleet">
              <h2>Multi-host fleet</h2>
              <p>Sessions don't all live on one machine. Register any host reachable by{' '}
                <C>ssh</C> alias and unsnooze pulls its tracked sessions over ssh — visible in{' '}
                <C>unsnooze fleet</C> and the dashboard's <strong>fleet</strong> tab.</p>
              <Shell title="fleet">{`$ unsnooze hosts add devbox      # any name that works as \`ssh devbox\`
$ unsnooze hosts list
$ unsnooze fleet                 # every host's sessions in one view
$ unsnooze fleet --json          # machine-readable
$ unsnooze dashboard fleet       # live view`}</Shell>
              <p>Remove a host with <C>unsnooze hosts rm &lt;name&gt;</C>. unsnooze must be
                installed on the remote host too. Hosts are polled in parallel with a bounded ssh
                pool, per-host timeouts, and a 24h stale cache — one dead box never blocks the
                rest.</p>
              <p><strong>Security posture:</strong> no listening ports, no custom auth, no tokens —
                transport is plain OpenSSH with host-key checking never weakened. The remote is
                always the one that types, under its own gates; <C>unsnooze _remote</C> is the
                single remote entrypoint, safe to lock to an <C>authorized_keys</C> forced
                command.</p>
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

            <section className="doc-sec" id="gui">
              <h2>GUI surfaces</h2>
              <p>Sessions in Claude Code's VS Code extension, the ChatGPT desktop app, and Claude
                desktop have no pane to scrape. <C>unsnooze daemon</C> tails the session files
                those surfaces already write:</p>
              <ul>
                <li><strong>Claude Code</strong> records every rate-limit stop as a structured entry
                  in its <C>~/.claude/projects/**.jsonl</C> transcripts (session id, cwd, reset
                  time) — shared by the CLI and the VS Code extension.</li>
                <li><strong>Codex</strong> writes a <C>rate_limits</C> snapshot (usage %, exact
                  epoch reset time) into every rollout under <C>~/.codex/sessions/</C> — shared by
                  the CLI, IDE extension, and the ChatGPT desktop app. Where Codex lives only
                  inside ChatGPT.app, unsnooze resumes through the app-bundled binary.</li>
                <li><strong>Claude desktop (cowork) sessions</strong> <em>(experimental,
                  macOS)</em> run in sandboxes under <C>~/Library/Application Support/Claude</C>;
                  revival uses the session's isolated <C>CLAUDE_CONFIG_DIR</C>.</li>
              </ul>
              <p>At reset the session revives in a multiplexer pane with{' '}
                <C>claude --resume &lt;id&gt;</C> / <C>codex resume &lt;id&gt;</C> — same session
                file, so the conversation stays visible in the GUI's own history. Enable in{' '}
                <C>unsnooze setup</C> or with <C>unsnooze install --daemon</C>; disable with{' '}
                <C>unsnooze config set guiWatch off</C>.</p>
            </section>

            <section className="doc-sec" id="guards">
              <h2>Guards</h2>
              <h3>workspaceGuard — the repo changed while it slept</h3>
              <p>The repo's HEAD and dirty state are fingerprinted at stop time and re-checked at
                wake. <C>inform</C> (default) resumes with a heads-up in the wake message ("HEAD
                abc1234 → def5678 — re-read before continuing"); <C>pause</C> holds the session and{' '}
                <C>resume-now</C> shows the diff stat first; <C>off</C> disables.</p>
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

            <section className="doc-sec" id="platforms">
              <h2>Platforms</h2>
              <p><strong>macOS / Linux:</strong> install tmux or Zellij (<C>brew install tmux</C>,{' '}
                <C>brew install zellij</C>). In <C>auto</C> mode unsnooze uses the multiplexer
                you're inside; pin one with <C>unsnooze config set multiplexer tmux</C>.</p>
              <p><strong>Windows:</strong> unsnooze runs inside WSL — where the agent CLIs live on
                Windows anyway:</p>
              <Shell title="WSL (Ubuntu etc.)">{`$ sudo apt install tmux        # or install Zellij
$ npm install -g unsnooze && unsnooze setup`}</Shell>
              <p>Desktop notifications inside WSL arrive as native Windows toasts through{' '}
                <C>powershell.exe</C> — no X server needed. Native Windows without WSL is not
                supported: with no tmux or Zellij there is no pane to watch, and unsnooze says so
                and runs your CLI unwatched instead of breaking it.</p>
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
      </main>
      <SubFooter />
    </div>
  );
}
