# Security Policy

unsnooze is a small, dependency-light (only `@clack/prompts`), local-only Node CLI
that auto-resumes limit-stopped AI coding sessions. It runs on your machine, sends
your keystrokes into your own terminal, and keeps its state on your disk. This
document explains exactly what it does, what it deliberately does not do, the
residual risks, and how to report a vulnerability.

## Reporting a vulnerability

**Please report privately — do not open a public issue for security bugs.**

- Preferred: GitHub **Private Vulnerability Reporting** — the **"Report a
  vulnerability"** button on the repository's **Security** tab
  (<https://github.com/saaranshM/unsnooze/security/advisories/new>).
- Fallback: email **saaransh.dev2811@gmail.com** with subject `unsnooze security`.

Please include the version, OS, multiplexer (tmux/zellij), and reproduction steps.
This is a solo-maintained project; expect an initial acknowledgement within
**7 days** and, for confirmed issues, a fix or mitigation plan within **30 days**.
Coordinated disclosure is appreciated — we'll agree a disclosure date and credit
you (opt-out available) in the release notes.

## Supported versions

Only the latest published minor receives security fixes. Fixes ship as a new
patch/minor to npm; there are no long-term backport branches.

| Version        | Supported |
|----------------|-----------|
| latest `1.x`   | ✅        |
| older releases | ❌ (upgrade: `npm install -g unsnooze@latest`) |

## What unsnooze does — and does not — do

unsnooze's job is narrow: detect a usage-limit stop, wait for the reset, and resume
the *same* session by typing a message (or reopening it via the agent's own
`--resume`). Everything below is enforced in code.

**It does:**

- **Send keystrokes into your terminal panes** — the resume message via `sendText`,
  and `Down`/`Up`/`Enter` to answer Claude Code's limit menu.
- **Prove ownership before every keystroke.** Typing requires two independent
  checks: *identity* — a tmux `@unsnooze_owner` pane stamp (a mismatch vetoes,
  because pane ids are recycled), else a lease (process id + start time); and
  *liveness* — the leased agent process is alive, or the agent is the pane's
  foreground command. A stamp alone never authorizes typing. Pane *closes*
  (`unsnooze reap`, opt-in auto-reap) require proven identity — `resumed` panes
  additionally require an idle threshold — and never touch a pane whose
  ownership can't be proven.
  *(src/lease.js `paneOwnedByRecord`, src/resumer.js `assessPane`)*
- **Answer Claude's limit menu without ever blind-Entering.** It reads the menu,
  targets **"Stop and wait for limit to reset,"** and computes the exact moves; if
  the layout is unreadable it presses **nothing**. It never selects "Upgrade your
  plan." Governed by the `menuAutoAnswer` setting. *(src/agents/claude.js,
  src/monitor.js `driveMenu`)*
- **Type only your configured message** (`resumeMessage`, with per-agent and
  per-session overrides). Preview exactly what would be typed, without sending
  anything: `unsnooze preview`. *(src/settings.js, src/resumer.js `planFor`)*
- **Make at most two kinds of network request, both opt-controlled:** a version
  check `GET https://registry.npmjs.org/unsnooze/latest` (no identifying data, 3s
  timeout, fails closed; disable with `updateCheck=false` /
  `UNSNOOZE_UPDATE_CHECK=0`), and — **only if you configure a topic** — ntfy push
  notifications to the server you choose (`ntfyServer`/`ntfyTopic`; off by
  default; `ntfyPrivacy=terse` keeps directory paths out of the payload).
  *(src/update-check.js, src/notify-ntfy.js)*
- **Keep all state local** under `~/.unsnooze` (`UNSNOOZE_STATE_DIR` to relocate),
  writing state atomically (temp file + rename) and quarantining corrupt state
  rather than crashing. *(src/state.js)*
- **Back up and cleanly reverse what it edits.** `~/.claude/settings.json` and your
  `~/.zshrc`/`~/.bashrc` get two backup tiers — `*.unsnooze-orig` (pristine, written
  once) and `*.unsnooze-bak` (rolls per run); `~/.qwen/settings.json` gets
  `*.unsnooze-bak`; the Grok hook file is unsnooze's own file. `unsnooze uninstall`
  removes every change and stops the daemon. *(src/install.js)*

**It does not:**

- **Never** pass `--dangerously-skip-permissions`, `--yes`/auto-approve, or any
  permission-bypass flag to any agent. (The only `--yes` in unsnooze is its *own*
  non-interactive install confirmation — never forwarded to an agent.)
- **Never** press "Yes, I trust this folder," and **never** write MCP/trust keys
  into any agent config.
- **Never** sandbox, restrict, or expand your agent's permissions. After resume,
  the agent behaves exactly as if you had typed the message yourself.
- **Never** send telemetry, analytics, crash reports, or your prompts/transcripts
  anywhere.
- **Never** blind-Enter a menu, and never inject into a pane it cannot prove is
  yours (it reopens a fresh session instead).

## Threat model & residual risks

unsnooze is an **automation convenience**, not a security boundary. Honest
residual risks:

1. **It types into your live terminal on your behalf.** Simulated keystrokes are
   indistinguishable from real ones. Ownership checks are strong for sessions
   unsnooze launched (stamp + lease), but for **legacy or GUI-originated records
   that have neither a lease nor a pane stamp**, identity falls back to a heuristic
   (the pane's foreground command name). In that narrow case there is a residual
   chance of typing the resume message into the wrong pane. Mitigation: run agents
   through the shell wrappers (which stamp + lease every launch), and check
   `unsnooze preview` to see exactly what would be sent where.
2. **unsnooze does not protect you from malicious repositories or prompt
   injection.** Risks like TrustFall (a folder-trust prompt auto-executing project
   MCP servers → RCE) live entirely in your agent and its config, not in unsnooze.
   Resuming a session is equivalent to you pressing Enter yourself. Keep untrusted
   repos out of trusted/auto-run agent sessions.
3. **The `StopFailure` hook runs on every matching failed turn.** It executes
   `node <unsnooze> _hook-stopfailure` inside your agent's turn (guarded to exit 0
   if the binary is missing; it only records to local state). Installing unsnooze
   adds it to the trust surface of every session it wraps.
4. **Self-update trusts the npm supply chain.** `unsnooze update` runs
   `npm install -g unsnooze@latest`. Releases are published with npm provenance
   (Sigstore-attested back to this repository's CI), which you can verify on the
   npm package page. Pin a version if that matters to you.
5. **ntfy topics on ntfy.sh are a public namespace.** If you enable push, the topic
   name is effectively the password — use the generated random topic, an access
   token, or a self-hosted server, and consider `ntfyPrivacy=terse` (never sends
   directory paths).
6. **Config and state are plaintext under `~/.unsnooze`.** They contain session
   metadata and your resume message(s), not credentials — but they are readable by
   anything running as your user.

## Scope

In scope: keystroke-authorization bypass (typing into a pane unsnooze shouldn't
own), the version-check or ntfy requests leaking unexpected data,
install/uninstall corrupting or failing to back up user files, the hook/daemon
crashing or blocking the host CLI, privilege escalation via the launchd/systemd
units.

Out of scope: vulnerabilities in the agent CLIs themselves (Claude Code, Codex,
etc.), prompt injection / malicious-repo RCE against those agents, and issues
requiring an already-compromised local user account.
