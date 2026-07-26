import Stars from '../../../components/Stars.jsx';
import SiteNav from '../../../components/SiteNav.jsx';
import SubFooter from '../../../components/SubFooter.jsx';
import DocsNav, { DocsPager } from '../../../components/DocsNav.jsx';
import { Shell, C } from '../../../components/DocsKit.jsx';
import { JsonLd, breadcrumbs } from '../../../lib/jsonld.js';

export const metadata = {
  title: "SSH multi-host fleet — watch sessions on every machine",
  description:
    "Run unsnooze across several machines over ssh: host setup with key or password auth, host states, the fleet security posture, watching GUI surfaces like the VS Code extension and desktop apps, and platform support for macOS, Linux and WSL.",
  alternates: { canonical: '/docs/fleet/' },
  openGraph: {
    title: "unsnooze ssh multi-host fleet",
    description: "See every machine’s limit-stopped sessions in one place, over ssh.",
    url: '/docs/fleet/',
  },
};

export default function FleetDocsPage() {
  return (
    <div className="subpage">
      <div className="stars-layer stars-dim" aria-hidden="true"><Stars /></div>
      <JsonLd data={breadcrumbs([['unsnooze', '/'], ['Docs', '/docs/'], ['Fleet', '/docs/fleet/']])} />
      <SiteNav page="docs" />
      <main className="wrap subpage-main">
        <header className="sub-hero">
          <p className="eyebrow">documentation</p>
          <h1 className="sub-title">SSH multi-host fleet</h1>
          <p className="section-lede">
            One dashboard for every machine you code on — pulled over ssh, read-only by
            default — plus the GUI surfaces and platforms unsnooze can watch.
          </p>
        </header>

        <div className="docs-layout">
          <DocsNav current="/docs/fleet/" />

          <div className="docs-content">

            <section className="doc-sec" id="fleet">
              <h2>Multi-host fleet</h2>
              <p>See and act on unsnooze sessions on <strong>other machines</strong> from one
                terminal — over your own SSH, no new service to run. The remote host needs
                unsnooze installed; transport is your existing <C>~/.ssh/config</C>, keys, and
                agent.</p>
              <Shell title="fleet">{`$ unsnooze hosts add work you@work-box.local   # register an ssh destination
$ unsnooze hosts list                          # registered hosts
$ unsnooze hosts test work                     # pre-flight: credential + reachability
$ unsnooze hosts rm work                       # forget a host
$ unsnooze fleet [--json]                      # every host's sessions, fanned out over ssh
$ unsnooze dashboard fleet                     # live Fleet tab`}</Shell>
              <p><strong>Before adding a host, connect to it the normal way once</strong>{' '}
                (<C>ssh &lt;host&gt;</C>) so OpenSSH pins the host key itself. unsnooze never
                weakens host-key checking to skip that step — an unknown or changed host fails
                fast instead of being silently trusted. If <C>dest</C> is omitted, the name
                doubles as the destination (so any <C>~/.ssh/config</C> alias works as-is).
                Hosts live in <C>~/.unsnooze/hosts.json</C>.</p>

              <h3>See and mark — not type remotely</h3>
              <p>The fleet view lists every reachable host's tracked sessions (state, reset
                countdown, attach hint). In the dashboard's Fleet tab, selecting a stopped remote
                session and pressing <strong>R</strong> (uppercase — lowercase <C>r</C> refreshes)
                only <em>marks it due</em>; <strong>C</strong> cancels it. The remote's own daemon
                does the actual keystrokes, under the same ownership/liveness/menu gates as a
                local session — a compromised viewer cannot make a remote type anything else.
                Stopped and resumed sessions print an attach hint
                (<C>ssh -t &lt;host&gt; 'tmux new -A -s &lt;session&gt;'</C> or{' '}
                <C>zellij attach &lt;session&gt;</C>) so you can hop over and watch.
                Note: remote resume/cancel always targets one session — <C>--all</C> is
                local-only.</p>

              <h3>Host states</h3>
              <div className="doc-table-scroll">
                <table className="doc-table">
                  <thead><tr><th>state</th><th>meaning</th></tr></thead>
                  <tbody>
                    <tr><td><C>online</C></td><td>Fresh answer, latency shown in ms.</td></tr>
                    <tr><td><C>stale</C></td><td>Host currently unreachable, showing its last-known sessions from cache (up to 24h, age shown).</td></tr>
                    <tr><td><C>needs-auth</C></td><td>The credential is the problem, not the network — a password source didn't resolve, ssh rejected the password, or a <C>prompt</C> host was tried without a terminal. Distinct from unreachable; fix the source and verify with <C>hosts test</C>.</td></tr>
                    <tr><td><C>unreachable</C></td><td>ssh couldn't connect (timeout or connection failure).</td></tr>
                    <tr><td><C>skew</C></td><td>Remote unsnooze too old to speak the protocol — update it.</td></tr>
                  </tbody>
                </table>
              </div>
              <p>Hosts are polled in parallel (bounded pool, hard per-host timeouts around
                8&nbsp;s) so one dead box never blocks the rest; interactive password prompts run
                one at a time afterwards, with a generous timeout so you're never cut off
                mid-password. Like <C>preview</C>, <C>unsnooze fleet</C> exits <strong>2</strong>{' '}
                when some host has a stopped session — scriptable.</p>

              <h3>Auth: keys (default) or password</h3>
              <p>Every host picks its own auth. <C>key</C> is the default and stays the hardened
                path (ssh <C>BatchMode</C>, agent/keys, nothing new). <C>--auth password</C> adds
                four credential sources:</p>
              <Shell title="unsnooze hosts add — full syntax">{`$ unsnooze hosts add <name> <dest>
      [--auth key|password]                  # default: key
      [--source prompt|env|keychain|command] # default: prompt, once --auth password is set
      [--env <VARNAME>]                      # env source: var to read (default UNSNOOZE_PW_<NAME>)
      [--service <s> --account <a>]          # keychain source (macOS only)
      [--cmd '<command>']                    # command source: program whose stdout is the password`}</Shell>
              <ul>
                <li><strong><C>prompt</C></strong> (default) — typed at run time, no-echo, on
                  whichever terminal runs <C>fleet</C> / <C>hosts test</C>. Nothing is ever
                  stored. Interactive-only by nature: under the daemon, in pipes, and in the
                  dashboard's Fleet tab it shows <C>needs-auth</C> instead of prompting.</li>
                <li><strong><C>env</C></strong> — reads a variable you export
                  (default <C>UNSNOOZE_PW_&lt;NAME&gt;</C>). Daemon-capable. Positioned as a
                  low-friction/CI convenience, not secret-manager-grade — your shell can already
                  read it.</li>
                <li><strong><C>keychain</C></strong> — macOS-only built-in via{' '}
                  <C>security find-generic-password</C> (defaults: service{' '}
                  <C>unsnooze-&lt;name&gt;</C>, account = the user part of <C>dest</C>).
                  Daemon-capable.</li>
                <li><strong><C>command</C></strong> — the portable, first-class source: any
                  program whose stdout is the password. Daemon-capable, works on every OS. Its
                  stderr is deliberately discarded so a chatty secret tool can never leak into
                  logs.</li>
              </ul>
              <Shell title="examples">{`$ unsnooze hosts add laptop me@laptop.local --auth password
# → prompts (no-echo) every time it's used from a real terminal

$ unsnooze hosts add gpu ubuntu@gpu.example.com --auth password --source env --env UNSNOOZE_PW_GPU
# → export UNSNOOZE_PW_GPU=... first

$ unsnooze hosts add mac me@mac-mini.local --auth password --source keychain --service unsnooze-mac --account me
# → macOS only; reads via \`security find-generic-password\`

$ unsnooze hosts add ci ci@build.example.com --auth password --source command --cmd 'op read op://vault/ci/password'
# → any OS; runs your secret manager, reads its stdout

$ unsnooze hosts test gpu
# → resolves the credential + probes reachability; prints "auth ok" or a
#   hint ("needs-setup: ..."), never the secret`}</Shell>
              <p>Per-OS <C>--cmd</C> recipes for the command source:</p>
              <div className="doc-table-scroll">
                <table className="doc-table">
                  <thead><tr><th>OS</th><th>example <C>--cmd</C></th></tr></thead>
                  <tbody>
                    <tr><td>macOS</td><td><C>security find-generic-password -s &lt;service&gt; -a &lt;account&gt; -w</C></td></tr>
                    <tr><td>Linux</td><td><C>pass show &lt;path&gt;</C> or <C>secret-tool lookup &lt;attr&gt; &lt;value&gt;</C></td></tr>
                    <tr><td>Windows</td><td><C>powershell -Command "..."</C> (e.g. wrapping <C>Get-StoredCredential</C>) or <C>op read …</C></td></tr>
                    <tr><td>any OS</td><td><C>op read op://vault/item/password</C> (1Password CLI) — or any manager's read command</td></tr>
                  </tbody>
                </table>
              </div>
              <p><strong>Requirements &amp; limits:</strong> stored sources
                (<C>env</C>/<C>keychain</C>/<C>command</C>) need OpenSSH ≥ 8.4
                (<C>SSH_ASKPASS_REQUIRE</C>) — older ssh shows <C>needs-auth</C>. On native
                Windows, <C>ssh.exe</C> prompts fine for an interactive <C>prompt</C> host, but
                stored sources need Git-for-Windows or WSL ssh for now. <C>keychain</C> exists
                only on macOS — Linux and Windows use <C>--source command</C> with the recipes
                above.</p>

              <h3>Fleet security posture</h3>
              <ul>
                <li><strong>No new network surface.</strong> No listening ports, no custom auth,
                  no tokens — only outbound OpenSSH child processes, and{' '}
                  <C>StrictHostKeyChecking</C> is never touched.</li>
                <li><strong>The remote is the authority.</strong>{' '}
                  <C>unsnooze _remote</C> is the single remote entrypoint
                  (<C>status</C>/<C>resume</C>/<C>cancel</C>); resume only marks a session due —
                  the remote daemon types under its own gates. Lock a key to it with{' '}
                  <C>command="unsnooze _remote",restrict</C> in the remote{' '}
                  <C>authorized_keys</C> — that key can never open a shell.</li>
                <li><strong>Remote output is untrusted.</strong> Every field a host returns is
                  control-character-stripped, length-capped, and copied into fresh objects before
                  it touches your terminal or state; session names are re-validated before being
                  shown in a copy-pasteable attach hint.</li>
                <li><strong>Passwords never touch argv, <C>ps</C>, or unsnooze's environment.</strong>{' '}
                  They flow through OpenSSH's own <C>SSH_ASKPASS</C> hook — helper stdout to ssh,
                  in-process, for that one ssh child. unsnooze stores no plaintext:
                  keychain/command delegate to the OS store or your manager.</li>
              </ul>
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

          </div>
        </div>

        <DocsPager current="/docs/fleet/" />
      </main>
      <SubFooter />
    </div>
  );
}
