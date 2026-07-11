#!/usr/bin/env bash
# Live Zellij primitive smoke test. This never launches a real agent and only
# owns the reserved throwaway session below.
set -uo pipefail

SESSION='unsnooze-e2e'
CREATED=0
FAILURES=0

# Deliberately poison the inherited pane context. Every Zellij invocation must
# work like the headless daemon, with these variables absent.
export ZELLIJ='conflicting-zellij-context'
export ZELLIJ_SESSION_NAME='conflicting-session'
export ZELLIJ_PANE_ID='999999'

pass() { printf 'PASS: %s\n' "$1"; }
fail() { printf 'FAIL: %s\n' "$1" >&2; FAILURES=$((FAILURES + 1)); }

zellij_clean() (
  unset ZELLIJ ZELLIJ_SESSION_NAME ZELLIJ_PANE_ID
  command zellij "$@"
)

# Owner-bound actions are allowed to address only the session this script owns.
zellij_session() {
  local owner=$1
  shift
  if [[ $owner != "$SESSION" ]]; then
    fail "refused Zellij owner '$owner' (expected '$SESSION')"
    return 64
  fi
  zellij_clean -s "$owner" "$@"
}

cleanup() {
  if (( CREATED )); then
    ( unset ZELLIJ ZELLIJ_SESSION_NAME ZELLIJ_PANE_ID
      command zellij kill-session "$SESSION" >/dev/null 2>&1 || true
      command zellij delete-session "$SESSION" >/dev/null 2>&1 || true
    )
  fi
}
trap cleanup EXIT

if ! command -v zellij >/dev/null 2>&1; then
  fail 'zellij is installed'
  exit 1
fi
pass 'zellij is installed'

# Never attach to or destroy a session that pre-dates this run.
if zellij_clean list-sessions --short --no-formatting 2>/dev/null | grep -Fxq "$SESSION"; then
  fail "throwaway session '$SESSION' already exists; refusing to touch it"
  exit 1
fi
pass "throwaway session '$SESSION' is unused"

CREATED=1
if zellij_clean attach -b -c "$SESSION"; then
  pass "created background session '$SESSION'"
else
  fail "created background session '$SESSION'"
  exit 1
fi

extract_base_pane() {
  printf '%s' "$1" | node -e '
    let s = "";
    process.stdin.on("data", c => s += c).on("end", () => {
      try {
        const pane = JSON.parse(s).find(p => p.is_plugin === false && p.exited === false);
        if (pane) process.stdout.write(String(pane.id));
      } catch {}
    });
  '
}

# A freshly created background session registers its default pane a beat after
# `attach -b -c` returns, so poll rather than read once.
panes_json=''
base_pane=''
for _ in {1..30}; do
  panes_json=$(zellij_session "$SESSION" action list-panes -a -j 2>/dev/null)
  base_pane=$(extract_base_pane "$panes_json")
  [[ $base_pane =~ ^[0-9]+$ ]] && break
  sleep 0.2
done
if [[ $panes_json == \[* ]]; then
  pass 'list-panes -a -j returned JSON'
else
  fail 'list-panes -a -j returned JSON'
fi
if [[ $base_pane =~ ^[0-9]+$ ]]; then
  pass "found live terminal pane $base_pane"
else
  fail 'found a live terminal pane'
  exit 1
fi

if zellij_session "$SESSION" action write-chars --pane-id "$base_pane" \
    'printf "__UNSNOOZE_WRITE_OK__\n"' \
    && zellij_session "$SESSION" action write --pane-id "$base_pane" 13; then
  pass 'write-chars + write 13 accepted pane-targeted input'
else
  fail 'write-chars + write 13 accepted pane-targeted input'
fi

sleep 0.5
screen=$(zellij_session "$SESSION" action dump-screen --pane-id "$base_pane" 2>/dev/null)
if [[ $? -eq 0 && $screen == *'__UNSNOOZE_WRITE_OK__'* ]]; then
  pass 'dump-screen --pane-id captured written output'
else
  fail 'dump-screen --pane-id captured written output'
fi

if zellij_session "$SESSION" action send-keys --pane-id "$base_pane" Down \
    && zellij_session "$SESSION" action send-keys --pane-id "$base_pane" Enter; then
  pass 'send-keys Down/Enter accepted pane-targeted keys'
else
  fail 'send-keys Down/Enter accepted pane-targeted keys'
fi

run_output=$(zellij_session "$SESSION" run --cwd /tmp -- \
  /usr/bin/env K=V bash -lc 'printf "__UNSNOOZE_ENV_K__=%s\n" "$K"; sleep 30' 2>/dev/null)
if [[ $run_output =~ ^terminal_([0-9]+)$ ]]; then
  agent_pane=${BASH_REMATCH[1]}
  pass "run returned $run_output"
else
  fail "run returned a terminal_<id> (got '${run_output:-empty}')"
  agent_pane=''
fi

if [[ -n $agent_pane ]]; then
  env_seen=0
  for _ in {1..20}; do
    agent_screen=$(zellij_session "$SESSION" action dump-screen --pane-id "$agent_pane" 2>/dev/null)
    if [[ $agent_screen == *'__UNSNOOZE_ENV_K__=V'* ]]; then
      env_seen=1
      break
    fi
    sleep 0.1
  done
  if (( env_seen )); then
    pass '/usr/bin/env propagated K=V into the fake agent pane'
  else
    fail '/usr/bin/env propagated K=V into the fake agent pane'
  fi

  panes_json=$(zellij_session "$SESSION" action list-panes -a -j 2>/dev/null)
  if printf '%s' "$panes_json" | node -e '
    let s = "";
    const id = Number(process.argv[1]);
    process.stdin.on("data", c => s += c).on("end", () => {
      try { process.exit(JSON.parse(s).some(p => p.id === id && p.is_plugin === false && p.exited === false) ? 0 : 1); }
      catch { process.exit(1); }
    });
  ' "$agent_pane"; then
    pass "owner transition kept terminal_$agent_pane in '$SESSION'"
  else
    fail "owner transition kept terminal_$agent_pane in '$SESSION'"
  fi
fi

if (( FAILURES > 0 )); then
  printf 'FAIL: %d check(s) failed\n' "$FAILURES" >&2
  exit 1
fi

printf 'PASS: all Zellij smoke checks passed\n'
