#!/usr/bin/env bash
# End-to-end simulation of the full detect → wait → re-open cycle without
# hitting a real usage limit. Uses a scratch tmux session + isolated state dir.
#
#   Phase 1: a scratch pane displays a fake limit banner; a monitor scrapes it
#            and records the stop.
#   Phase 2: the record's resetAt is rewritten to "now"; the resumer runs,
#            re-opens the (killed) session as a new window running a stub
#            "claude" that prints what it receives, and sends the resume
#            message.
#
# Everything is namespaced (session csg-e2e, state dir in a tmpdir) — safe to
# run alongside real work.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
export CSG_STATE_DIR="$WORK/state"
export CSG_TMUX_SESSION=csg-e2e
export CSG_SCRAPE_INTERVAL_MS=500
export CSG_POLL_INTERVAL_MS=1000
export CSG_VERIFY_DELAY_MS=2000
export CSG_STAGGER_MS=500
export CSG_CLAUDE_DIR="$WORK/claude"   # no transcripts — sessionId stays null
SES=csg-e2e-src

cleanup() {
  tmux kill-session -t "$SES" 2>/dev/null || true
  tmux kill-session -t "csg-e2e" 2>/dev/null || true
  pkill -f "csg.js _monitor %" 2>/dev/null || true
  pkill -f "csg.js _resumer" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

fail() { echo "E2E FAIL: $1" >&2; exit 1; }

echo "== Phase 1: detection =="
# Plain /bin/sh — the user's zsh can take seconds to start, and the banner
# must be on screen before the monitor's first scrape.
tmux kill-session -t "$SES" 2>/dev/null || true
tmux new-session -d -s "$SES" -x 80 -y 24 /bin/sh
PANE=$(tmux display-message -t "$SES" -p '#{pane_id}')
sleep 1

# Paint a fake limit banner (reset 1 minute from now so phase 2 is quick).
RESET_TIME=$(date -v+1M '+%-I:%M%p' | tr '[:upper:]' '[:lower:]')
tmux send-keys -t "$PANE" "clear; echo; echo \"You've hit your 5-hour limit\"; echo \"resets $RESET_TIME\"" Enter
for i in $(seq 1 20); do
  tmux capture-pane -t "$PANE" -p | grep -q '5-hour limit' && break
  sleep 0.5
done
tmux capture-pane -t "$PANE" -p | grep -q '5-hour limit' || fail "banner never appeared in scratch pane"

CSG_CWD="$WORK/fakeproj" node "$ROOT/bin/csg.js" _monitor "$PANE" &
MONITOR_PID=$!
sleep 3
kill "$MONITOR_PID" 2>/dev/null || true

STATE="$CSG_STATE_DIR/state.json"
[ -f "$STATE" ] || fail "no state file written"
grep -q '"status": "stopped"' "$STATE" || fail "no stopped record"
grep -q '"limitType": "5h"' "$STATE" || fail "limit type not classified"
grep -q '"resetSource": "absolute"' "$STATE" || fail "reset time not parsed from banner"
echo "PASS: banner detected, stop recorded with parsed reset time"

echo "== Phase 2: resume after refresh =="
# Kill the original pane (simulates the session being gone at reset time) and
# point the record at a stub claude so we can observe the resume message.
tmux kill-session -t "$SES"

# The monitor auto-spawned a resumer; kill it so OUR resumer (with the fake
# csg on PATH) takes the singleton lock instead.
pkill -f "csg.js _resumer" 2>/dev/null || true
sleep 1
rm -f "$CSG_STATE_DIR/resumer.lock"

STUB="$WORK/claude-stub.sh"
cat > "$STUB" <<'EOF'
#!/usr/bin/env bash
echo "STUB CLAUDE READY"
echo "❯ "
while IFS= read -r line; do echo "RECEIVED: $line" >> "$WORK_OUT"; done
EOF
chmod +x "$STUB"
export WORK_OUT="$WORK/received.txt"

# Make the record due now, and swap the resume command for the stub via
# CSG launcher indirection: easiest is editing the record's cwd + using a
# custom csg bin name. dispatchOne runs `csg --resume <id>` / `csg -c`; here we
# override by rewriting state so pane is dead and letting newWindow run the
# stub through an env-provided fake csg.
node - "$STATE" <<'EOF'
const fs = require('fs');
const [,, stateFile] = process.argv;
const s = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
for (const rec of Object.values(s.sessions)) rec.resetAt = Date.now() - 1000;
fs.writeFileSync(stateFile, JSON.stringify(s, null, 2));
EOF

# Fake csg on PATH that ignores args and execs the stub (records what a real
# re-open would have run).
FAKEBIN="$WORK/bin"; mkdir -p "$FAKEBIN"
cat > "$FAKEBIN/csg" <<EOF
#!/usr/bin/env bash
echo "\$@" > "$WORK/resume-args.txt"
WORK_OUT="$WORK_OUT" exec "$STUB"
EOF
chmod +x "$FAKEBIN/csg"
export PATH="$FAKEBIN:$PATH"

# (no `timeout` on stock macOS — background + kill)
node "$ROOT/bin/csg.js" _resumer &
RESUMER_PID=$!
for i in $(seq 1 30); do
  kill -0 "$RESUMER_PID" 2>/dev/null || break   # resumer exited on its own
  grep -q '"status": "resumed"' "$STATE" 2>/dev/null && break
  sleep 1
done
kill "$RESUMER_PID" 2>/dev/null || true
wait "$RESUMER_PID" 2>/dev/null || true

[ -f "$WORK/resume-args.txt" ] || fail "resumer never re-opened a window"
grep -q '\-c' "$WORK/resume-args.txt" || fail "expected -c resume args (no sessionId), got: $(cat "$WORK/resume-args.txt")"
[ -f "$WORK_OUT" ] || fail "stub never received the resume message"
grep -q "Continue where you left off" "$WORK_OUT" || fail "resume message wrong: $(cat "$WORK_OUT")"
grep -q '"status": "resumed"' "$STATE" || fail "record not marked resumed"
echo "PASS: dead session re-opened in tmux window and resume message delivered"

echo
echo "E2E OK"
