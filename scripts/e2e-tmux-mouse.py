#!/usr/bin/env python3
"""Exercise real wheel input through an attached PTY on a private tmux server.

Run: python3 scripts/e2e-tmux-mouse.py
Requires tmux, Node and Python 3 on a POSIX host. No real agents are launched.
"""
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import shutil
import struct
import subprocess
import tempfile
import termios
import time

ROOT = Path(__file__).resolve().parents[1]
NODE = shutil.which('node')
assert NODE and shutil.which('tmux'), 'node and tmux are required'


def scenario(app_mouse):
    with tempfile.TemporaryDirectory(prefix='unsnooze-mouse-e2e-') as tmp:
        base = Path(tmp)
        socket = base / f'tmux-{os.getuid()}' / 'default'
        socket.parent.mkdir(mode=0o700)
        received = base / 'received.bin'
        fixture = base / 'fixture.mjs'
        fixture.write_text(f'''#!{NODE}
import {{ appendFileSync }} from 'node:fs';
process.stdin.setRawMode(true);
process.stdin.on('data', b => appendFileSync({json.dumps(str(received))}, b));
for (let i=0;i<250;i++) console.log('Earlier chat turn ' + i);
if ({json.dumps(app_mouse)}) process.stdout.write('\\x1b[?1000h\\x1b[?1006h');
console.log('Ready at the prompt');
''')
        fixture.chmod(0o700)
        env = {k: v for k, v in os.environ.items() if not k.startswith('UNSNOOZE_')
               and k not in ('TMUX', 'TMUX_PANE', 'ZELLIJ', 'ZELLIJ_SESSION_NAME', 'PSMUX_SESSION')}
        env.update(TERM='xterm-256color', TMUX_TMPDIR=tmp,
                   UNSNOOZE_STATE_DIR=str(base / 'state'),
                   UNSNOOZE_KIMI_CODE_DIR=str(base / 'code'),
                   UNSNOOZE_KIMI_DIR=str(base / 'legacy'),
                   UNSNOOZE_KIMI_BIN=str(fixture), UNSNOOZE_AGENT_KIMI='on',
                   UNSNOOZE_SESSION_NAME='scroll-test', UNSNOOZE_SCRAPE_INTERVAL_MS='100',
                   UNSNOOZE_AUTO_RESUME='off', UNSNOOZE_GUI_WATCH='off',
                   UNSNOOZE_UPDATE_CHECK='off', UNSNOOZE_NOTIFICATIONS='off')

        def tmux(*args):
            return subprocess.check_output(['tmux', '-S', str(socket), *args], env=env,
                                           stderr=subprocess.DEVNULL, text=True).strip()

        tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'keepalive', '/bin/sleep', '60')
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 100, 0, 0))

        def controlling_tty():
            os.setsid()
            fcntl.ioctl(0, termios.TIOCSCTTY, 0)

        child = subprocess.Popen([NODE, str(ROOT / 'bin/unsnooze.js'), '_run', 'kimi'],
                                 stdin=slave, stdout=slave, stderr=slave, env=env,
                                 cwd=tmp, preexec_fn=controlling_tty)
        os.close(slave)

        def drain():
            while select.select([master], [], [], 0)[0]:
                try:
                    os.read(master, 65536)
                except OSError:
                    return

        def wait(predicate):
            until = time.monotonic() + 8
            while time.monotonic() < until:
                drain()
                try:
                    if predicate():
                        return
                except subprocess.CalledProcessError:
                    pass
                time.sleep(.05)
            raise AssertionError('timed out waiting for fixture/session/mouse event')

        try:
            wait(lambda: 'Ready at the prompt' in tmux('capture-pane', '-p', '-t', 'scroll-test'))
            assert tmux('show-options', '-gv', 'mouse') == 'off', 'global user defaults changed'
            assert tmux('show-options', '-v', '-t', 'scroll-test', 'mouse') == 'on'
            assert int(tmux('display-message', '-p', '-t', 'scroll-test', '#{history_size}')) > 100
            for _ in range(3):
                os.write(master, b'\x1b[<64;5;5M')  # real SGR wheel-up at row/column 5
                time.sleep(.05)
            if app_mouse:
                wait(lambda: received.exists() and b'64;' in received.read_bytes())
                assert tmux('display-message', '-p', '-t', 'scroll-test', '#{pane_in_mode}') == '0'
                assert b'\x1b[A' not in received.read_bytes()
                print('PASS mouse-aware app receives wheel events, not arrow keys')
            else:
                wait(lambda: tmux('display-message', '-p', '-t', 'scroll-test', '#{pane_in_mode}') == '1')
                assert int(tmux('display-message', '-p', '-t', 'scroll-test', '#{scroll_position}')) > 0
                assert not received.exists(), 'wheel input reached prompt history'
                os.write(master, b'q')
                wait(lambda: tmux('display-message', '-p', '-t', 'scroll-test', '#{pane_in_mode}') == '0')
                print('PASS regular-screen wheel enters scrollback; q returns to prompt; no app input')
        finally:
            try:
                tmux('kill-server')
            except subprocess.CalledProcessError:
                pass
            child.wait(timeout=5)
            os.close(master)
            time.sleep(.2)  # allow the fixture monitor to observe pane closure


if __name__ == '__main__':
    scenario(False)
    scenario(True)
