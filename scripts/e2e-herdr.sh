#!/usr/bin/env bash
# Live Herdr primitive smoke test. This never launches a real agent and owns
# only the unique throwaway session below.
set -uo pipefail

SESSION="unsnooze-e2e-$$"
CONFIG_ROOT="${TMPDIR:-/tmp}/unsnooze-herdr-e2e-$$"
CREATED=0
FAILURES=0
mkdir -p "$CONFIG_ROOT"
export XDG_CONFIG_HOME="$CONFIG_ROOT"

# Deliberately poison inherited pane context. Every Herdr invocation below
# removes these variables and supplies the scratch session explicitly.
export HERDR_ENV='conflicting-herdr-context'
export HERDR_PANE_ID='w999:p999'
export HERDR_SOCKET_PATH='/tmp/conflicting-herdr.sock'
export HERDR_TAB_ID='w999:t999'
export HERDR_WORKSPACE_ID='w999'

pass() { printf 'PASS: %s\n' "$1"; }
fail() { printf 'FAIL: %s\n' "$1" >&2; FAILURES=$((FAILURES + 1)); }

herdr_session() (
  env -u HERDR_ENV -u HERDR_PANE_ID -u HERDR_SOCKET_PATH \
    -u HERDR_TAB_ID -u HERDR_WORKSPACE_ID \
    herdr --session "$SESSION" "$@"
)

json_has_session() {
  local expected=$1
  node -e '
    let s = "";
    process.stdin.on("data", c => s += c).on("end", () => {
      try {
        const expected = process.argv[1];
        const rows = JSON.parse(s)?.sessions || [];
        process.exit(rows.some(row => row.name === expected) ? 0 : 1);
      } catch { process.exit(1); }
    });
  ' "$expected"
}

json_session_running() {
  local expected=$1
  node -e '
    let s = "";
    process.stdin.on("data", c => s += c).on("end", () => {
      try {
        const expected = process.argv[1];
        const rows = JSON.parse(s)?.sessions || [];
        process.exit(rows.some(row => row.name === expected && row.running === true) ? 0 : 1);
      } catch { process.exit(1); }
    });
  ' "$expected"
}

json_root_pane() {
  node -e '
    let s = "";
    process.stdin.on("data", c => s += c).on("end", () => {
      try {
        const pane = JSON.parse(s)?.result?.root_pane?.pane_id;
        if (pane) process.stdout.write(String(pane));
      } catch {}
    });
  '
}

json_has_pane() {
  local expected=$1
  node -e '
    let s = "";
    process.stdin.on("data", c => s += c).on("end", () => {
      try {
        const expected = process.argv[1];
        const parsed = JSON.parse(s);
        const rows = parsed?.result?.panes || parsed?.panes || [];
        process.exit(rows.some(row => String(row?.pane_id ?? row?.id ?? row) === expected) ? 0 : 1);
      } catch { process.exit(1); }
    });
  ' "$expected"
}

json_pane_id() {
  local expected=$1
  node -e '
    let s = "";
    process.stdin.on("data", c => s += c).on("end", () => {
      try {
        const expected = process.argv[1];
        const pane = JSON.parse(s)?.result?.pane?.pane_id;
        process.exit(String(pane) === expected ? 0 : 1);
      } catch { process.exit(1); }
    });
  ' "$expected"
}

json_pane_not_found() {
  node -e '
    let s = "";
    process.stdin.on("data", c => s += c).on("end", () => {
      try { process.exit(JSON.parse(s)?.error?.code === "pane_not_found" ? 0 : 1); }
      catch { process.exit(1); }
    });
  '
}

cleanup() {
  if (( CREATED )); then
    herdr_session session stop "$SESSION" >/dev/null 2>&1 || true
    herdr_session session delete "$SESSION" >/dev/null 2>&1 || true
  fi
  rm -rf -- "$CONFIG_ROOT"
}
trap cleanup EXIT

if ! command -v herdr >/dev/null 2>&1; then
  fail 'herdr is installed'
  exit 1
fi
pass 'herdr is installed'

version=$(herdr_session --version 2>/dev/null || true)
if [[ $version =~ herdr[[:space:]]([0-9]+)\.([0-9]+)\.([0-9]+) ]]; then
  major=${BASH_REMATCH[1]}
  minor=${BASH_REMATCH[2]}
  patch=${BASH_REMATCH[3]}
  if (( major > 0 || (major == 0 && (minor > 7 || (minor == 7 && patch >= 5))) )); then
    pass "version gate accepts $version"
  else
    fail "version gate accepts herdr >= 0.7.5 (got '${version:-empty}')"
    exit 1
  fi
else
  fail "version gate returned herdr >= 0.7.5 (got '${version:-empty}')"
  exit 1
fi

# Refuse to touch a pre-existing session, even though the name includes $$.
existing=$(herdr_session session list --json 2>/dev/null || true)
if printf '%s' "$existing" | json_has_session "$SESSION"; then
  fail "throwaway session '$SESSION' already exists; refusing to touch it"
  exit 1
fi
pass "throwaway session '$SESSION' is unused"

if ! command -v setsid >/dev/null 2>&1; then
  fail 'setsid is installed for detached headless start'
  exit 1
fi

CREATED=1
if setsid env -u HERDR_ENV -u HERDR_PANE_ID -u HERDR_SOCKET_PATH \
    -u HERDR_TAB_ID -u HERDR_WORKSPACE_ID \
    herdr --session "$SESSION" server >/dev/null 2>&1 &
then
  server_started=1
else
  server_started=0
fi

sessions_json=''
running=0
if (( server_started )); then
  for _ in {1..40}; do
    sessions_json=$(herdr_session session list --json 2>/dev/null || true)
    if printf '%s' "$sessions_json" | json_session_running "$SESSION"; then
      running=1
      break
    fi
    sleep 0.1
  done
fi
if (( running )); then
  pass "headless session '$SESSION' is running"
else
  fail "headless session '$SESSION' is running"
  exit 1
fi

workspace_json=$(herdr_session workspace create --cwd /tmp --label unsnooze-e2e 2>/dev/null || true)
root_pane=$(printf '%s' "$workspace_json" | json_root_pane)
if [[ -n $root_pane ]]; then
  pass "workspace create returned root pane '$root_pane'"
else
  fail 'workspace create returned result.root_pane.pane_id'
  exit 1
fi

run_rc=0
herdr_session pane run "$root_pane" /usr/bin/printf '__UNSNOOZE_HERDR_RUN__\\n' >/dev/null 2>&1 || run_rc=$?
if (( run_rc == 0 )); then
  run_seen=0
  for _ in {1..20}; do
    screen=$(herdr_session pane read "$root_pane" --source recent --lines 20 --format text 2>/dev/null || true)
    if [[ $screen == *'__UNSNOOZE_HERDR_RUN__'* ]]; then run_seen=1; break; fi
    sleep 0.1
  done
  if (( run_seen )); then
    pass 'pane run command output was visible in pane read'
  else
    fail 'pane run command output was visible in pane read'
  fi
else
  fail 'pane run command succeeded'
fi

if panes_json=$(herdr_session pane list 2>/dev/null) \
    && printf '%s' "$panes_json" | json_has_pane "$root_pane"; then
  pass "listSessionPanes found '$root_pane'"
else
  fail "listSessionPanes found '$root_pane'"
fi

if herdr_session pane send-text "$root_pane" 'echo __UNSNOOZE_HERDR_SEND__' >/dev/null 2>&1 \
    && herdr_session pane send-keys "$root_pane" enter >/dev/null 2>&1; then
  send_seen=0
  for _ in {1..20}; do
    screen=$(herdr_session pane read "$root_pane" --source recent --lines 30 --format text 2>/dev/null || true)
    if [[ $screen == *'__UNSNOOZE_HERDR_SEND__'* ]]; then send_seen=1; break; fi
    sleep 0.1
  done
  if (( send_seen )); then
    pass 'send-text + send-keys enter round-trip appeared in pane read'
  else
    fail 'send-text + send-keys enter round-trip appeared in pane read'
  fi
else
  fail 'send-text + send-keys enter round-trip was accepted'
fi

pane_json=$(herdr_session pane get "$root_pane" 2>/dev/null || true)
if printf '%s' "$pane_json" | json_pane_id "$root_pane"; then
  pass "paneAlive true for '$root_pane'"
else
  fail "paneAlive true for '$root_pane'"
fi

close_rc=0
herdr_session pane close "$root_pane" >/dev/null 2>&1 || close_rc=$?
if (( close_rc == 0 )); then
  pass "closed pane '$root_pane'"
else
  fail "closed pane '$root_pane'"
fi

not_found_rc=0
not_found=$(herdr_session pane get "$root_pane" 2>&1) || not_found_rc=$?
if (( not_found_rc != 0 )) && printf '%s' "$not_found" | json_pane_not_found; then
  pass "paneAlive false after close ('$root_pane' is pane_not_found)"
else
  fail "paneAlive false after close ('$root_pane' is pane_not_found)"
fi

sessions_json=$(herdr_session session list --json 2>/dev/null || true)
if printf '%s' "$sessions_json" | json_session_running "$SESSION"; then
  pass "session list reports '$SESSION' before stop"
else
  fail "session list reports '$SESSION' before stop"
fi

stop_rc=0
herdr_session session stop "$SESSION" >/dev/null 2>&1 || stop_rc=$?
if (( stop_rc == 0 )); then
  pass "stopped session '$SESSION'"
else
  fail "stopped session '$SESSION'"
fi

delete_rc=0
herdr_session session delete "$SESSION" >/dev/null 2>&1 || delete_rc=$?
if (( delete_rc == 0 )); then
  pass "deleted session '$SESSION'"
else
  fail "deleted session '$SESSION'"
fi
if (( stop_rc == 0 && delete_rc == 0 )); then CREATED=0; fi

if (( FAILURES > 0 )); then
  printf 'FAIL: %d check(s) failed\n' "$FAILURES" >&2
  exit 1
fi

printf 'PASS: all Herdr smoke checks passed\n'
