<div align="center">

<img src="assets/banner.svg" alt="unsnooze — wakes every limit-stopped AI session the moment the limit resets" width="880"/>

<br/>

[![CI](https://github.com/saaranshM/unsnooze/actions/workflows/ci.yml/badge.svg)](https://github.com/saaranshM/unsnooze/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/unsnooze?color=f59e0b)](https://www.npmjs.com/package/unsnooze)
[![node](https://img.shields.io/badge/node-%E2%89%A5%2020-3fb950)](package.json)
[![license](https://img.shields.io/badge/license-MIT-8b949e)](LICENSE)

**Claude Code · Codex CLI · Grok** — when they hit a usage limit, your session just… stops.<br/>
unsnooze tracks **every** limit-stopped session across all your projects and
**wakes each one up in tmux the moment the limit resets.**

```sh
npm install -g unsnooze && unsnooze setup
```

<img src="assets/demo.svg" alt="terminal demo: limit banners detected in two sessions, unsnooze waits for the reset, then wakes both — good morning, the work is done" width="880"/>

</div>

## Why unsnooze

Overnight and long-running agent work dies at the 5-hour / weekly limit, and every
existing tool solves only a slice of it:

| | **unsnooze** | claude-auto-retry | autoclaude | hydra |
|---|:---:|:---:|:---:|:---:|
| Multi-CLI (Claude Code + Codex + Grok) | ✅ | ❌ Claude only | ❌ Claude only | ✅ |
| Waits for reset & resumes the **same** session | ✅ | ✅ | ✅ | ❌ switches provider |
| All sessions at once (shared ledger + one daemon) | ✅ | ❌ one pane | ✅ | ✅ |
| Revives sessions whose pane/process is **gone** | ✅ `--resume <id>` | ❌ | ❌ | ❌ |
| Survives laptop sleep & weekly-scale waits | ✅ epoch polling | partial | partial | n/a |
| Settings + first-run wizard | ✅ | ❌ | ❌ | ❌ |

## Supported CLIs

- **Claude Code** — dual-channel detection: the `StopFailure` hook (authoritative,
  carries `session_id`) plus tmux pane scraping for banners and the interactive
  limit menu (always answered with *"Stop and wait for limit to reset"*, never a
  blind Enter). Dead sessions revive via `claude --resume <id>`.
- **OpenAI Codex CLI** — scrape-based (Codex fires no event on limits). Detects
  the exact `■ You've hit your usage limit …` banner strings from the Codex
  source, parses `try again at 3:51 PM` / `Feb 23rd, 2026 9:01 PM` /
  `in 4 days 20 hours 9 minutes`. Dead sessions revive via
  `codex resume <id> "<message>"` — the prompt travels in argv.
- **Grok Build (xAI)** — ⚠️ *experimental*. Hook channel works (Grok reads
  Claude-compatible hooks, including `StopFailure`); the limit banner text is
  not publicly documented, so detection uses generic patterns with a safe
  fallback. Hit a banner unsnooze missed? Run `unsnooze report` and paste the
  capture into an issue — that's how this adapter gets good.

## How it works

<div align="center">
<img src="assets/how-it-works.png" alt="architecture: claude/codex/grok panes are watched by unsnooze via hooks and banner scraping; stops land in state.json; the resumer daemon sleeps until the limit resets, then types into live panes or reopens dead ones until every session is running again" width="880"/>
</div>

<details>
<summary>text version</summary>

```
claude / codex / grok (shell wrapper) ──► unsnooze _run <agent> ──► CLI in tmux pane
                                              │
                                              ├─ per-pane monitor (scrapes for limit
                                              │  banners, drives Claude's limit menu,
                                              │  seconds-scale retry on 5xx/overload)
                                              │
StopFailure hook (claude, grok) ──────────────┤
                                              ▼
                                ~/.unsnooze/state.json
                                { agent, sessionId, cwd, pane, resetAt, status }
                                              │
                                              ▼
                                resumer daemon (singleton, epoch-polling —
                                survives laptop sleep and weekly-scale waits)
                                              │
                          ┌───────────────────┴────────────────────┐
                 pane still alive?                          pane gone?
                 send resume message into it                tmux new-window,
                 (only if the CLI is foreground             `unsnooze _run <agent>
                 and not mid-stream)                        --resume <id>`, verify
```

</details>

Limit events are never persisted by the CLIs themselves; the reset time is
parsed from the banner text, DST-safe, with a 5-hour fallback when unparseable
— and every resume is verified afterwards (banner came back → reschedule from
the fresh banner, capped at 5 attempts).

## Usage

```sh
claude / codex / grok           # normal usage — wrapped automatically
unsnooze status                 # tracked sessions + reset countdowns
unsnooze resume-now [id|--all]  # don't wait for the reset time
unsnooze cancel [id|--all]      # stop tracking a session
unsnooze config list            # settings (see below)
unsnooze config set <k> <v>     # e.g. autoResume off
unsnooze logs [-f]              # what unsnooze has been doing
unsnooze report [agent]         # capture a pane to report an undetected banner
unsnooze uninstall [--purge]    # remove wrappers + hooks (+ state with --purge)
```

## Settings

`unsnooze setup` writes `~/.unsnooze/config.json`; change anything later with
`unsnooze config set`:

| key | default | meaning |
|---|---|---|
| `autoResume` | `true` | Master switch. Off = stops are still tracked, but nothing is resumed until you run `unsnooze resume-now` or turn it back on. |
| `menuAutoAnswer` | `true` | May unsnooze answer Claude's limit menu (send keys in your pane)? Off = watch-only. |
| `notifications` | `true` | Desktop notification on limit detected / session resumed / gave up. |
| `resumeMessage` | *"Continue where you left off…"* | The message sent to wake a session. |
| `resumeMessages.claude` / `.codex` / `.grok` | `""` | Per-agent override of `resumeMessage`. Empty = use the global message; clear one with `unsnooze config set resumeMessages.claude ""`. |
| `agents.claude` / `agents.codex` / `agents.grok` | `true` / `true` / `false` | Which CLIs are guarded. |

Every setting also has a `UNSNOOZE_*` env override (see `src/settings.js`), and
all timings/paths are tunable via `UNSNOOZE_*` env vars (see `src/config.js`).

## Safety properties

- **Never injects blind**: keys are only sent when the pane's foreground
  process is the agent CLI and no "esc to interrupt"-style busy footer is
  visible. Recycled pane ids can't receive stray messages.
- **Never picks a menu option blind**: if Claude's limit menu layout can't be
  read, unsnooze does not press Enter (that could confirm "Upgrade your plan").
- **Sleep-safe waits**: the resumer polls wall-clock against the target epoch
  every 30s instead of one long timer — a laptop asleep past the reset fires
  on the next tick. Weekly limits are just a bigger epoch.
- **Verified resumes**: after dispatch it re-captures the pane; if the limit
  banner reappears (reset time misparsed / not actually reset), it reschedules
  from the fresh banner, capped at 5 attempts.
- **Concurrent-writer safe**: state updates go through a mkdir lock + atomic
  rename; corrupt state is quarantined, never fatal (the hook path must never
  block the CLI).
- **Overload ≠ limit**: 5xx/529/429 transient errors take a seconds-scale
  backoff path ([30,60,120,240,300]s ± jitter) and never enter the ledger.

## Requirements

- Node ≥ 20 and tmux
- macOS, Linux, or **Windows via WSL** (see below)
- zsh or bash (the wrappers are installed into `~/.zshrc` / `~/.bashrc`)

### Windows / WSL

unsnooze is built on tmux, so on Windows it runs inside
[WSL](https://learn.microsoft.com/windows/wsl/install) — which is where the
agent CLIs live on Windows anyway:

```sh
# inside your WSL distro (Ubuntu etc.)
sudo apt install tmux
npm install -g unsnooze && unsnooze setup
```

Everything works as on Linux, including desktop notifications: inside WSL,
unsnooze raises **native Windows toasts** through `powershell.exe` (no
`notify-send` or X server needed). Native Windows (PowerShell/cmd, no WSL) is
not supported — without tmux there is nothing to watch; unsnooze will tell you
so and run your CLI unwatched instead of breaking it.

## Development

```sh
npm test                     # unit tests (node:test)
./scripts/e2e-simulate.sh    # full detect → wait → re-open cycle in a
                             # scratch tmux session (no real limits needed)
```

## License

[MIT](LICENSE)
