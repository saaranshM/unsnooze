# demo/demo.tape — unsnooze README demo. Render: `vhs demo/demo.tape`
# Deps: vhs + ttyd + ffmpeg (brew install vhs). CI option: charmbracelet/vhs-action.
# Story: an AI CLI hits its limit -> unsnooze has already tracked it ->
#        `unsnooze status` shows the live countdown -> the limit resets ->
#        unsnooze auto-resumes. "good morning, the work is done."
#
# Staged honestly: the `claude` on PATH is a stub printing a real banner (the
# real one cannot hit a limit on camera), the ledger is a seeded fixture, and
# `unsnooze status` output is REAL. The final wake beat is canned narration —
# resume-now needs live panes.

Require unsnooze
Output assets/demo.gif

# ---- settings (must all precede the first action) ----
Set Shell bash
Set FontSize 22
Set Width 1200
Set Height 640
Set Padding 24
Set Framerate 24
Set TypingSpeed 55ms
Set PlaybackSpeed 0.9
Set CursorBlink true
Set WindowBar Colorful
Set BorderRadius 10
Set Theme { "name":"unsnooze-dark","background":"#0d1117","foreground":"#e6edf3","black":"#161b22","red":"#f87171","green":"#4ade80","yellow":"#e3b341","blue":"#58a6ff","magenta":"#bc8cff","cyan":"#39c5cf","white":"#8b949e","brightBlack":"#6e7681","brightRed":"#f87171","brightGreen":"#4ade80","brightYellow":"#e3b341","brightBlue":"#58a6ff","brightMagenta":"#bc8cff","brightCyan":"#39c5cf","brightWhite":"#e6edf3","cursor":"#e6edf3","selection":"#264f78" }

# ---- setup (executed but NOT recorded) ----
Hide
Type `export UNSNOOZE_STATE_DIR="$(mktemp -d)"`
Enter
Type `mkdir -p "$UNSNOOZE_STATE_DIR/bin"`
Enter
Type `printf '#!/bin/sh\necho "\033[31m⚠ You'"'"'ve hit your 5-hour limit - resets 3am\033[0m"\n' > "$UNSNOOZE_STATE_DIR/bin/claude"`
Enter
Type `chmod +x "$UNSNOOZE_STATE_DIR/bin/claude"; export PATH="$UNSNOOZE_STATE_DIR/bin:$PATH"`
Enter
# Seed the ledger so the REAL `unsnooze status` renders genuine output.
# resetSource must be a real enum value (absolute|relative|fallback) —
# 'fallback' gets rewritten to a probe window on load, so use 'absolute'.
Type `node -e 'const fs=require("fs"),p=process.env.UNSNOOZE_STATE_DIR+"/state.json";const at=Date.now()+(3*60+41)*60000;const mk=(k,id,agent,lt,cwd,ses,pane,via)=>[k,{key:k,sessionId:id,agent,limitType:lt,cwd,mux:"tmux",paneOwner:null,pane,muxSession:ses,origin:"cli",status:"stopped",detectedVia:via,detectedAt:Date.now()-1200000,resetAt:at,resetSource:"absolute",attempts:0}];const s=Object.fromEntries([mk("k1","a1b2c3d4-e5f6-4a01-8000-000000000001","claude","5h","~/work/api","api","%1","hook"),mk("k2","f6a7b8c9-d0e1-4b02-8000-000000000002","codex","weekly","~/work/webapp","web","%3","scrape")]);fs.writeFileSync(p,JSON.stringify({version:1,resumerPid:48213,sessions:s}))'`
Enter
Type "clear"
Enter
Show

# ---- BEAT 1: an agent hits the limit ----
Type "claude"
Enter
Sleep 1200ms

# ---- BEAT 2: unsnooze already tracked it — the real ledger + countdown ----
Type "unsnooze status"
Enter
Sleep 2800ms

# ---- BEAT 3: time passes ----
Type "# …you go to sleep. unsnooze doesn't. ⏰ 3:00 AM —"
Enter
Sleep 900ms

# ---- BEAT 4: the limit resets, unsnooze wakes everything (canned narration) ----
Type `printf '\033[33m→ limit reset · waking claude in api:%%1 · codex resume --last\033[0m\n'`
Enter
Sleep 900ms
Type `printf '\033[32m✔ all sessions verified running — good morning, the work is done\033[0m\n'`
Enter
Sleep 2500ms
