#!/usr/bin/env bash
# Full end-to-end scenario suite: every agent, every safety-relevant path,
# in REAL tmux with real monitor/hook/resumer processes — no mocked tmux.
# No real usage limits needed; agent CLIs are simulated by pane stubs.
#
#   S1  claude: banner scraped → stop recorded with parsed reset time
#   S2  claude: interactive limit menu driven — arrow keys to "Stop and wait",
#       never a blind Enter (raw-key menu stub verifies the actual selection)
#   S3  claude: menuAutoAnswer=off → menu NOT touched, stop still recorded
#   S4  claude: StopFailure hook JSON on stdin → ledger entry
#   S5  claude: dead pane → reopened via tmux window + resume message typed
#   S6  claude: live idle pane → resume message sent into the SAME pane
#   S7  codex: banner scraped → stop recorded, "try again at" parsed
#   S8  codex: dead pane → `_run codex resume --last "<msg>"` — prompt in
#       argv, NOTHING typed into the pane
#   S9  grok: generic banner scraped → stop recorded (fallback reset)
#   S10 grok: StopFailure hook (--agent grok) → ledger entry
#   S11 autoResume=off → due session NOT dispatched; still tracked
#   S12 overload (API Error 529) → seconds-scale retry message, ledger untouched
#   S13 claude GUI path: transcript rate_limit entry → daemon records via
#       watcher (no pane, no hook) and revives in a tmux window
#   S14 codex GUI path: rollout token_count with an exhausted window → daemon
#       records with the epoch reset and revives via `codex resume <id>`
#   S15 (macOS) claude desktop sandbox: stop in an isolated CLAUDE_CONFIG_DIR
#       → revived with that CLAUDE_CONFIG_DIR exported
#
# SAFETY: this suite must never reach a real agent binary or the user's
# sessions. Three layers guarantee it:
#   - a fake `unsnooze` shadows any globally-installed one on PATH throughout
#   - detection-scenario monitors run with UNSNOOZE_AUTO_RESUME=off, so the
#     resumers they auto-spawn can never dispatch anything
#   - every scenario ends by killing its monitor and any resumer
# Everything is namespaced (tmux sessions e2e-*, state under a tmpdir).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
BIN="$ROOT/bin/unsnooze.js"

export UNSNOOZE_TMUX_SESSION=unsnooze-e2e
export UNSNOOZE_SCRAPE_INTERVAL_MS=400
export UNSNOOZE_POLL_INTERVAL_MS=800
export UNSNOOZE_VERIFY_DELAY_MS=1500
export UNSNOOZE_STAGGER_MS=300
export UNSNOOZE_READY_TIMEOUT_MS=15000
export UNSNOOZE_NOTIFICATIONS=off
export UNSNOOZE_CLAUDE_DIR="$WORK/claude-home"    # no transcripts — no id backfill
export UNSNOOZE_CODEX_DIR="$WORK/codex-home"
export UNSNOOZE_GROK_DIR="$WORK/grok-home"
export UNSNOOZE_LAUNCH_AGENTS_DIR="$WORK/launch-agents"   # never touch the real
export UNSNOOZE_SYSTEMD_USER_DIR="$WORK/systemd-user"     # daemon autostart

SESSIONS=()
PIDS=()

cleanup() {
  # enumerate by name: SESSIONS+= inside $(new_pane ...) runs in a subshell
  # and never reaches this trap
  tmux list-sessions -F '#{session_name}' 2>/dev/null | grep -E '^e2e-' \
    | while read -r s; do tmux kill-session -t "$s" 2>/dev/null || true; done
  tmux kill-session -t unsnooze-e2e 2>/dev/null || true
  for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done
  pkill -f "unsnooze.js _monitor %" 2>/dev/null || true
  pkill -f "unsnooze.js _resumer" 2>/dev/null || true
  pkill -f "unsnooze.js daemon" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

CURRENT=""
fail() { echo "E2E FAIL [$CURRENT]: $1" >&2; exit 1; }
pass() { echo "PASS [$CURRENT]"; }

# End-of-scenario hygiene: no monitor or resumer may outlive its scenario
# (a leaked resumer once revived a fake record through the REAL claude).
scenario_end() {
  pkill -f "unsnooze.js _monitor %" 2>/dev/null || true
  pkill -f "unsnooze.js _resumer" 2>/dev/null || true
  pkill -f "unsnooze.js daemon" 2>/dev/null || true
  sleep 0.3
}

# ---------- stubs ----------

# Idle-agent stub: prints a prompt glyph, appends every stdin line to a file.
cat > "$WORK/echo-stub.js" <<'EOF'
const fs = require('fs');
const [,, glyph, out] = process.argv;
process.stdout.write((process.env.STUB_BANNER || '') + '\n' + glyph + ' \n');
let buf = '';
process.stdin.on('data', c => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\r')) !== -1 || (i = buf.indexOf('\n')) !== -1) {
    fs.appendFileSync(out, 'RECEIVED: ' + buf.slice(0, i) + '\n');
    buf = buf.slice(i + 1);
  }
});
EOF

# Raw-key menu stub: a REAL selectable menu. Renders Claude's limit menu,
# moves the cursor on arrow keys, and only on Enter reveals what was chosen —
# then prints the limit banner like the real TUI does after selection.
cat > "$WORK/menu-stub.js" <<'EOF'
const opts = ['1. Upgrade your plan', '2. Stop and wait for limit to reset'];
let cur = 0;
function render() {
  process.stdout.write('\x1b[2J\x1b[H');
  process.stdout.write('What do you want to do?\n');
  opts.forEach((o, i) => process.stdout.write((i === cur ? '❯ ' : '  ') + o + '\n'));
  process.stdout.write('(enter to confirm)\n');
}
if (process.stdin.isTTY) process.stdin.setRawMode(true);
render();
let chosen = false;
process.stdin.on('data', b => {
  const s = b.toString();
  if (chosen) return;
  if (s.includes('\x1b[B') || s.includes('\x1bOB')) { cur = Math.min(cur + 1, opts.length - 1); render(); }
  else if (s.includes('\x1b[A') || s.includes('\x1bOA')) { cur = Math.max(cur - 1, 0); render(); }
  else if (s.includes('\r') || s.includes('\n')) {
    chosen = true;
    process.stdout.write('\x1b[2J\x1b[H');
    process.stdout.write('CHOSE: ' + opts[cur] + '\n');
    if (cur === 1) process.stdout.write("You've hit your 5-hour limit\nresets 9pm\n");
  }
});
EOF

# Fake `unsnooze` for reopen paths: records argv, then becomes an idle stub.
# First on PATH for the WHOLE suite — shadows any real global install.
# Paths are BAKED IN per scenario (arm_fake): a process started by
# `tmux new-window` inherits the tmux server's environment, not the
# resumer's, so runtime env vars would never reach it.
FAKEBIN="$WORK/fakebin"; mkdir -p "$FAKEBIN"
arm_fake() {  # $1 args-file, $2 received-file, $3 prompt-glyph
  cat > "$FAKEBIN/unsnooze" <<EOF
#!/usr/bin/env bash
echo "\$@" > "$1"
exec node "$WORK/echo-stub.js" "$3" "$2"
EOF
  chmod +x "$FAKEBIN/unsnooze"
}
arm_fake "$WORK/unexpected-reopen.txt" "$WORK/unexpected-received.txt" "❯"
export PATH="$FAKEBIN:$PATH"

# ---------- helpers ----------

new_pane() {  # $1 session-name, rest: command
  local ses="$1"; shift
  tmux kill-session -t "$ses" 2>/dev/null || true
  tmux new-session -d -s "$ses" -x 100 -y 28 "$@"
  SESSIONS+=("$ses")
  tmux display-message -t "$ses" -p '#{pane_id}'
}

wait_pane() {  # $1 pane, $2 regex, $3 tries(0.4s each)
  local tries="${3:-25}"
  for _ in $(seq 1 "$tries"); do
    tmux capture-pane -t "$1" -p 2>/dev/null | grep -qE "$2" && return 0
    sleep 0.4
  done
  return 1
}

wait_state() {  # $1 state-file, $2 grep-regex, $3 tries(0.4s each)
  local tries="${3:-25}"
  for _ in $(seq 1 "$tries"); do
    [ -f "$1" ] && grep -qE "$2" "$1" && return 0
    sleep 0.4
  done
  return 1
}

# Detection-scenario monitor: output goes to a log file (NOT the command-
# substitution pipe — that deadlocks), autoResume forced off so the resumer
# it auto-spawns is inert. Extra env pairs may precede the state dir.
run_monitor() {  # [ENV=V ...] state-dir pane agent cwd
  local envs=()
  while [[ "$1" == *=* ]]; do envs+=("$1"); shift; done
  local sdir="$1" pane="$2" agent="$3" cwd="$4"
  env "${envs[@]:-UNSNOOZE_E2E=1}" UNSNOOZE_AUTO_RESUME=off \
    UNSNOOZE_STATE_DIR="$sdir" UNSNOOZE_CWD="$cwd" \
    node "$BIN" _monitor "$pane" "$agent" > "$sdir/monitor.log" 2>&1 &
  echo $!
}

seed_record() {  # $1 state-dir, $2 agent, $3 cwd, $4 pane, $5 sessionId('' = null)
  node --input-type=module -e "
    process.env.UNSNOOZE_STATE_DIR = '$1';
    const { upsertSession } = await import('$ROOT/src/state.js');
    upsertSession({
      sessionId: '$5' || null, cwd: '$3', pane: '$4', agent: '$2',
      tmuxSession: 'unsnooze-e2e', status: 'stopped', limitType: '5h',
      detectedVia: 'scrape', detectedAt: Date.now() - 60000,
      resetAt: Date.now() - 1000, resetSource: 'absolute',
      attempts: 0, lastAttemptAt: null, lastError: null,
    });
  "
}

run_resumer_until() {  # $1 state-dir, $2 regex to wait for in state, $3 tries
  UNSNOOZE_SELF="$FAKEBIN/unsnooze" UNSNOOZE_STATE_DIR="$1" node "$BIN" _resumer > "$1/resumer.log" 2>&1 &
  local pid=$!
  PIDS+=("$pid")
  local ok=1
  wait_state "$1/state.json" "$2" "${3:-40}" && ok=0
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  return $ok
}

# ============================================================
CURRENT="S1 claude scrape-detect"
S="$WORK/s1"; mkdir -p "$S/proj"
RESET_TIME=$(date -v+3M '+%-I:%M%p' 2>/dev/null | tr '[:upper:]' '[:lower:]' || date -d '+3 minutes' '+%-I:%M%p' | tr '[:upper:]' '[:lower:]')
PANE=$(new_pane e2e-s1 /bin/sh)
sleep 0.6
tmux send-keys -t "$PANE" "clear; echo; echo \"You've hit your 5-hour limit\"; echo \"resets $RESET_TIME\"" Enter
wait_pane "$PANE" "5-hour limit" || fail "banner never appeared"
MPID=$(run_monitor "$S" "$PANE" claude "$S/proj"); PIDS+=("$MPID")
wait_state "$S/state.json" '"status": "stopped"' || fail "no stopped record"
grep -q '"limitType": "5h"' "$S/state.json" || fail "limit type not classified"
grep -q '"resetSource": "absolute"' "$S/state.json" || fail "reset not parsed"
grep -q '"agent": "claude"' "$S/state.json" || fail "agent id missing"
scenario_end
pass

# ============================================================
CURRENT="S2 claude menu driven to 'Stop and wait'"
S="$WORK/s2"; mkdir -p "$S/proj"
PANE=$(new_pane e2e-s2 node "$WORK/menu-stub.js")
wait_pane "$PANE" "What do you want to do" || fail "menu never rendered"
MPID=$(run_monitor "$S" "$PANE" claude "$S/proj"); PIDS+=("$MPID")
wait_pane "$PANE" "CHOSE:" 30 || fail "monitor never confirmed a selection"
tmux capture-pane -t "$PANE" -p | grep -q "CHOSE: 2. Stop and wait for limit to reset" \
  || fail "WRONG option chosen: $(tmux capture-pane -t "$PANE" -p | grep CHOSE)"
# after selection the stub shows the banner — the monitor must record it
wait_state "$S/state.json" '"status": "stopped"' || fail "stop not recorded after menu"
scenario_end
pass

# ============================================================
CURRENT="S3 menuAutoAnswer=off → watch-only"
S="$WORK/s3"; mkdir -p "$S/proj"
PANE=$(new_pane e2e-s3 node "$WORK/menu-stub.js")
wait_pane "$PANE" "What do you want to do" || fail "menu never rendered"
MPID=$(run_monitor UNSNOOZE_MENU_AUTO_ANSWER=off "$S" "$PANE" claude "$S/proj"); PIDS+=("$MPID")
wait_state "$S/state.json" '"status": "stopped"' || fail "stop not recorded in watch-only mode"
tmux capture-pane -t "$PANE" -p | grep -q "CHOSE:" && fail "keys were sent despite menuAutoAnswer=off"
scenario_end
pass

# ============================================================
CURRENT="S4 claude StopFailure hook ingest"
S="$WORK/s4"; mkdir -p "$S/proj"
echo '{"session_id":"44444444-5555-4666-8777-888888888888","cwd":"'"$S/proj"'","error":{"type":"rate_limit_error"}}' \
  | UNSNOOZE_AUTO_RESUME=off UNSNOOZE_STATE_DIR="$S" node "$BIN" _hook-stopfailure
grep -q '"sessionId": "44444444-5555-4666-8777-888888888888"' "$S/state.json" || fail "hook did not record the session id"
grep -q '"detectedVia": "hook"' "$S/state.json" || fail "detection channel wrong"
grep -q '"resetSource": "fallback"' "$S/state.json" || fail "expected fallback reset (no pane to scrape)"
scenario_end
pass

# ============================================================
CURRENT="S5 claude dead pane → reopen + typed resume message"
S="$WORK/s5"; mkdir -p "$S/proj"
arm_fake "$S/reopen-args.txt" "$S/received.txt" "❯"
seed_record "$S" claude "$S/proj" "%999" "11111111-2222-4333-8444-555555555555"
run_resumer_until "$S" '"status": "resumed"' || fail "record never reached resumed: $(cat "$S/state.json")"
grep -q -- "_run claude --resume 11111111-2222-4333-8444-555555555555" "$S/reopen-args.txt" || fail "wrong reopen args: $(cat "$S/reopen-args.txt")"
grep -q "RECEIVED: Continue where you left off" "$S/received.txt" || fail "resume message never typed: $(cat "$S/received.txt" 2>/dev/null)"
scenario_end
pass

# ============================================================
CURRENT="S6 claude live idle pane → message into SAME pane"
S="$WORK/s6"; mkdir -p "$S/proj"
arm_fake "$S/reopen-args.txt" "$S/received.txt" "❯"
PANE=$(new_pane e2e-s6 node "$WORK/echo-stub.js" "❯" "$S/live-received.txt")
wait_pane "$PANE" "❯" || fail "stub never ready"
seed_record "$S" claude "$S/proj" "$PANE" ""
run_resumer_until "$S" '"status": "resumed"' || fail "record never resumed: $(cat "$S/state.json")"
grep -q "RECEIVED: Continue where you left off" "$S/live-received.txt" || fail "message not delivered to live pane"
[ -f "$S/reopen-args.txt" ] && fail "reopened a window despite live pane"
scenario_end
pass

# ============================================================
CURRENT="S7 codex scrape-detect + reset parse"
S="$WORK/s7"; mkdir -p "$S/proj"
CODEX_RESET=$(date -v+3M '+%-I:%M %p' 2>/dev/null || date -d '+3 minutes' '+%-I:%M %p')
PANE=$(new_pane e2e-s7 /bin/sh)
sleep 0.6
tmux send-keys -t "$PANE" "clear; echo; echo \"■ You've hit your usage limit. Upgrade to Pro or try again at $CODEX_RESET.\"" Enter
wait_pane "$PANE" "usage limit" || fail "codex banner never appeared"
MPID=$(run_monitor "$S" "$PANE" codex "$S/proj"); PIDS+=("$MPID")
wait_state "$S/state.json" '"agent": "codex"' || fail "codex stop not recorded"
grep -q '"resetSource": "absolute"' "$S/state.json" || fail "'try again at' not parsed"
scenario_end
pass

# ============================================================
CURRENT="S8 codex dead pane → resume via argv, nothing typed"
S="$WORK/s8"; mkdir -p "$S/proj"
arm_fake "$S/reopen-args.txt" "$S/received.txt" "›"
seed_record "$S" codex "$S/proj" "%998" ""
run_resumer_until "$S" '"status": "resumed"' || fail "codex record never resumed: $(cat "$S/state.json")"
grep -q -- "_run codex resume --last" "$S/reopen-args.txt" || fail "wrong codex reopen args: $(cat "$S/reopen-args.txt")"
grep -q "Continue where you left off" "$S/reopen-args.txt" || fail "resume prompt missing from argv"
[ -s "$S/received.txt" ] && fail "text was typed into codex pane (argv resume must not type): $(cat "$S/received.txt")"
scenario_end
pass

# ============================================================
CURRENT="S9 grok generic banner scrape-detect"
S="$WORK/s9"; mkdir -p "$S/proj"
PANE=$(new_pane e2e-s9 /bin/sh)
sleep 0.6
tmux send-keys -t "$PANE" "clear; echo; echo 'Rate limit exceeded. Please wait a moment and try again.'" Enter
wait_pane "$PANE" "Rate limit exceeded" || fail "grok banner never appeared"
MPID=$(run_monitor UNSNOOZE_AGENT_GROK=on "$S" "$PANE" grok "$S/proj"); PIDS+=("$MPID")
wait_state "$S/state.json" '"agent": "grok"' || fail "grok stop not recorded"
grep -q '"resetSource": "fallback"' "$S/state.json" || fail "grok should use fallback reset"
scenario_end
pass

# ============================================================
CURRENT="S10 grok StopFailure hook (--agent grok)"
S="$WORK/s10"; mkdir -p "$S/proj"
echo '{"sessionId":"grok-e2e","cwd":"'"$S/proj"'","error":"rate_limit"}' \
  | UNSNOOZE_AUTO_RESUME=off UNSNOOZE_AGENT_GROK=on UNSNOOZE_STATE_DIR="$S" node "$BIN" _hook-stopfailure --agent grok
grep -q '"agent": "grok"' "$S/state.json" || fail "grok hook did not record"
scenario_end
pass

# ============================================================
CURRENT="S11 autoResume=off → tracked but never dispatched"
S="$WORK/s11"; mkdir -p "$S/proj"
arm_fake "$S/reopen-args.txt" "$S/received.txt" "❯"
seed_record "$S" claude "$S/proj" "%997" ""
UNSNOOZE_SELF="$FAKEBIN/unsnooze" UNSNOOZE_AUTO_RESUME=off UNSNOOZE_STATE_DIR="$S" node "$BIN" _resumer > "$S/resumer.log" 2>&1 &
RPID=$!; PIDS+=("$RPID")
sleep 4
kill "$RPID" 2>/dev/null || true; wait "$RPID" 2>/dev/null || true
[ -f "$S/reopen-args.txt" ] && fail "dispatched despite autoResume=off"
grep -q '"status": "stopped"' "$S/state.json" || fail "record lost while paused"
scenario_end
pass

# ============================================================
CURRENT="S12 overload 529 → seconds-scale retry, ledger untouched"
S="$WORK/s12"; mkdir -p "$S/proj"
PANE=$(new_pane e2e-s12 env STUB_BANNER="API Error: 529 overloaded" node "$WORK/echo-stub.js" "❯" "$S/overload-received.txt")
wait_pane "$PANE" "API Error: 529" || fail "overload text never appeared"
MPID=$(run_monitor UNSNOOZE_OVERLOAD_BACKOFF_S=1,2 "$S" "$PANE" claude "$S/proj"); PIDS+=("$MPID")
for _ in $(seq 1 25); do
  grep -q "transient API error" "$S/overload-received.txt" 2>/dev/null && break
  sleep 0.4
done
grep -q "transient API error" "$S/overload-received.txt" || fail "overload retry message never sent"
[ -f "$S/state.json" ] && grep -q '"status": "stopped"' "$S/state.json" && fail "overload wrongly entered the limit ledger"
scenario_end
pass

# Daemon helper for the GUI scenarios: watcher enabled, per-scenario homes.
# SAFETY: every watch root defaults to a scratch dir so the daemon can never
# see (or revive) the user's real sessions; scenarios override as needed.
run_daemon() {  # [ENV=V ...] state-dir
  local envs=()
  while [[ "$1" == *=* ]]; do envs+=("$1"); shift; done
  local sdir="$1"
  env UNSNOOZE_CLAUDE_DESKTOP_DIR="$sdir/desktop-unused" "${envs[@]:-UNSNOOZE_E2E=1}" \
    UNSNOOZE_SELF="$FAKEBIN/unsnooze" UNSNOOZE_STATE_DIR="$sdir" \
    UNSNOOZE_RESET_MARGIN_MS=0 \
    node "$BIN" daemon > "$sdir/daemon.log" 2>&1 &
  echo $!
}

# ============================================================
CURRENT="S13 claude GUI: transcript entry → watcher detect + revive"
S="$WORK/s13"; mkdir -p "$S/claude-home/projects/-s13-proj"
arm_fake "$S/reopen-args.txt" "$S/received.txt" "❯"
TRANSCRIPT="$S/claude-home/projects/-s13-proj/13131313-1414-4151-8161-171717171717.jsonl"
: > "$TRANSCRIPT"
DPID=$(run_daemon UNSNOOZE_CLAUDE_DIR="$S/claude-home" UNSNOOZE_CODEX_DIR="$S/codex-home" "$S"); PIDS+=("$DPID")
sleep 2   # let the daemon take its first tick (offsets at EOF)
node -e "
  const line = JSON.stringify({
    isSidechain: false, type: 'assistant', timestamp: new Date().toISOString(),
    message: { role: 'assistant', content: [{ type: 'text', text: \"You've hit your session limit · try again in 0 minutes\" }] },
    error: 'rate_limit', isApiErrorMessage: true, apiErrorStatus: 429,
    entrypoint: 'vscode', cwd: '$S/proj',
    sessionId: '13131313-1414-4151-8161-171717171717',
  });
  require('fs').appendFileSync('$TRANSCRIPT', line + '\n');
"
wait_state "$S/state.json" '"detectedVia": "transcript"' 40 || fail "watcher never recorded the transcript stop: $(cat "$S/state.json" 2>/dev/null)"
grep -q '"origin": "vscode"' "$S/state.json" || fail "origin not taken from the transcript entrypoint"
wait_state "$S/state.json" '"status": "resumed"' 40 || fail "GUI stop never revived: $(cat "$S/state.json")"
grep -q -- "_run claude --resume 13131313-1414-4151-8161-171717171717" "$S/reopen-args.txt" || fail "wrong reopen args: $(cat "$S/reopen-args.txt")"
kill "$DPID" 2>/dev/null || true; wait "$DPID" 2>/dev/null || true
scenario_end
pass

# ============================================================
CURRENT="S14 codex GUI: exhausted rollout window → epoch reset + revive"
S="$WORK/s14"; mkdir -p "$S/codex-home/sessions/2026/07/10"
arm_fake "$S/reopen-args.txt" "$S/received.txt" "›"
ROLLOUT="$S/codex-home/sessions/2026/07/10/rollout-2026-07-10T10-00-00-14141414-1515-4161-8171-181818181818.jsonl"
node -e "
  const meta = JSON.stringify({
    timestamp: new Date().toISOString(), type: 'session_meta',
    payload: { id: '14141414-1515-4161-8171-181818181818', cwd: '$S/proj', originator: 'codex-ide', source: 'ide' },
  });
  require('fs').writeFileSync('$ROLLOUT', meta + '\n');
"
DPID=$(run_daemon UNSNOOZE_CLAUDE_DIR="$S/claude-home" UNSNOOZE_CODEX_DIR="$S/codex-home" "$S"); PIDS+=("$DPID")
sleep 2
node -e "
  const line = JSON.stringify({
    timestamp: new Date().toISOString(), type: 'event_msg',
    payload: { type: 'token_count', info: null, rate_limits: {
      primary: { used_percent: 100, window_minutes: 300, resets_at: Math.floor(Date.now() / 1000) - 1 },
      secondary: { used_percent: 9, window_minutes: 10080, resets_at: Math.floor(Date.now() / 1000) + 99999 },
      rate_limit_reached_type: null,
    } },
  });
  require('fs').appendFileSync('$ROLLOUT', line + '\n');
"
wait_state "$S/state.json" '"detectedVia": "transcript"' 40 || fail "codex rollout stop never recorded: $(cat "$S/state.json" 2>/dev/null)"
grep -q '"origin": "codex-ide"' "$S/state.json" || fail "originator not captured"
grep -q '"resetSource": "absolute"' "$S/state.json" || fail "epoch reset not used"
wait_state "$S/state.json" '"status": "resumed"' 40 || fail "codex GUI stop never revived: $(cat "$S/state.json")"
grep -q -- "_run codex resume 14141414-1515-4161-8171-181818181818" "$S/reopen-args.txt" || fail "wrong codex reopen args: $(cat "$S/reopen-args.txt")"
kill "$DPID" 2>/dev/null || true; wait "$DPID" 2>/dev/null || true
scenario_end
pass

# ============================================================
CURRENT="S15 claude desktop sandbox → CLAUDE_CONFIG_DIR on revival"
if [ "$(uname)" = "Darwin" ]; then
  S="$WORK/s15"
  SANDBOX="$S/desktop/org-e2e/sess-e2e/local_e2e"
  mkdir -p "$SANDBOX/.claude/projects/-sandbox-outputs" "$SANDBOX/outputs"
  # Custom fake: also record the CLAUDE_CONFIG_DIR the revived CLI sees.
  cat > "$FAKEBIN/unsnooze" <<EOF
#!/usr/bin/env bash
echo "\$@" > "$S/reopen-args.txt"
echo "\$CLAUDE_CONFIG_DIR" > "$S/reopen-configdir.txt"
echo "securestore=[\${CLAUDE_SECURESTORAGE_CONFIG_DIR-unset}]" > "$S/reopen-securestore.txt"
exec node "$WORK/echo-stub.js" "❯" "$S/received.txt"
EOF
  chmod +x "$FAKEBIN/unsnooze"
  TRANSCRIPT="$SANDBOX/.claude/projects/-sandbox-outputs/15151515-1616-4171-8181-191919191919.jsonl"
  : > "$TRANSCRIPT"
  DPID=$(run_daemon UNSNOOZE_CLAUDE_DIR="$S/claude-home" UNSNOOZE_CODEX_DIR="$S/codex-home" UNSNOOZE_CLAUDE_DESKTOP_DIR="$S/desktop" "$S"); PIDS+=("$DPID")
  sleep 2
  node -e "
    const line = JSON.stringify({
      isSidechain: false, type: 'assistant', timestamp: new Date().toISOString(),
      message: { role: 'assistant', content: [{ type: 'text', text: \"You've hit your session limit · try again in 0 minutes\" }] },
      error: 'rate_limit', isApiErrorMessage: true, apiErrorStatus: 429,
      entrypoint: 'cli', cwd: '$SANDBOX/outputs',
      sessionId: '15151515-1616-4171-8181-191919191919',
    });
    require('fs').appendFileSync('$TRANSCRIPT', line + '\n');
  "
  wait_state "$S/state.json" '"origin": "desktop"' 40 || fail "desktop stop not recorded with origin: $(cat "$S/state.json" 2>/dev/null)"
  wait_state "$S/state.json" '"status": "resumed"' 40 || fail "desktop stop never revived: $(cat "$S/state.json")"
  grep -q -- "_run claude --resume 15151515-1616-4171-8181-191919191919" "$S/reopen-args.txt" || fail "wrong desktop reopen args: $(cat "$S/reopen-args.txt")"
  grep -q "$SANDBOX/.claude" "$S/reopen-configdir.txt" || fail "CLAUDE_CONFIG_DIR not exported to the revived CLI: $(cat "$S/reopen-configdir.txt" 2>/dev/null)"
  grep -q 'securestore=\[\]' "$S/reopen-securestore.txt" || fail "CLAUDE_SECURESTORAGE_CONFIG_DIR must be set-but-empty (default keychain auth): $(cat "$S/reopen-securestore.txt" 2>/dev/null)"
  # restore the generic fake for the trailing leak check
  arm_fake "$WORK/unexpected-reopen.txt" "$WORK/unexpected-received.txt" "❯"
  kill "$DPID" 2>/dev/null || true; wait "$DPID" 2>/dev/null || true
  scenario_end
  pass
else
  echo "SKIP [S15 claude desktop sandbox] — macOS only"
fi

# no leaked dispatch may have reached the fake unsnooze outside its scenario
[ -f "$WORK/unexpected-reopen.txt" ] && fail "a stray resumer dispatched outside its scenario: $(cat "$WORK/unexpected-reopen.txt")"

echo
echo "E2E OK — all scenarios green"
