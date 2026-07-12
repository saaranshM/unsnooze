import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nodeFs from 'node:fs';

import {
  sanitizeOscText,
  buildOsc9,
  buildOsc777,
  classifyTerminal,
  dialectFor,
  writeToTty,
  sendOsc,
  sendBell,
} from '../src/notify-tty.js';

// ── builders (byte-exact) ──────────────────────────────────────────────────

describe('buildOsc9 / buildOsc777', () => {
  test('OSC 9 is byte-exact', () => {
    const seq = buildOsc9('Limit hit', 'session stopped');
    assert.equal(seq, '\x1b]9;Limit hit: session stopped\x07');
    assert.equal(seq.charCodeAt(0), 0x1b);
    assert.equal(seq.charCodeAt(seq.length - 1), 0x07);
  });

  test('OSC 777 is byte-exact', () => {
    const seq = buildOsc777('Limit hit', 'session stopped');
    assert.equal(seq, '\x1b]777;notify;Limit hit;session stopped\x07');
  });

  test('builders sanitize title and body', () => {
    const seq = buildOsc9('hi\x1b[31m', 'body\x07there');
    assert.ok(!seq.slice(2, -1).includes('\x1b'));
    assert.ok(!seq.slice(4, -1).includes('\x07') || seq.endsWith('\x07'));
    // payload between ESC]9; and BEL has no raw ESC/BEL injection
    const payload = seq.slice('\x1b]9;'.length, -1);
    assert.ok(!payload.includes('\x1b'));
    assert.ok(!payload.includes('\x07'));
  });
});

// ── sanitizer ──────────────────────────────────────────────────────────────

describe('sanitizeOscText', () => {
  test('strips ESC, BEL, C0, and DEL', () => {
    assert.equal(sanitizeOscText('a\x1bb\x07c\x00d\x7fe'), 'abcde');
  });

  test('collapses newlines to spaces', () => {
    assert.equal(sanitizeOscText('line1\nline2\r\nline3'), 'line1 line2 line3');
  });

  test('truncates to max', () => {
    assert.equal(sanitizeOscText('abcdefghij', 5), 'abcde');
  });

  test('stripSemicolons for OSC 777 titles', () => {
    assert.equal(
      sanitizeOscText('a;b;c', 100, { stripSemicolons: true }),
      'abc',
    );
  });

  test('OSC 777 title cannot carry field-separator semicolons', () => {
    const seq = buildOsc777('ti;tle', 'bo;dy');
    // Exactly four semicolons in the structural positions: ]777;notify;title;body
    // title and body must not introduce extra ones.
    assert.equal(seq, '\x1b]777;notify;title;body\x07');
  });

  test('nullish input becomes empty string', () => {
    assert.equal(sanitizeOscText(null, 10), '');
    assert.equal(sanitizeOscText(undefined, 10), '');
  });
});

// ── classifyTerminal ───────────────────────────────────────────────────────

describe('classifyTerminal', () => {
  test('termname table', () => {
    assert.equal(classifyTerminal({ termname: 'xterm-kitty' }), 'kitty');
    assert.equal(classifyTerminal({ termname: 'xterm-ghostty' }), 'ghostty');
    assert.equal(classifyTerminal({ termname: 'wezterm' }), 'wezterm');
    assert.equal(classifyTerminal({ termname: 'rxvt-unicode-256color' }), 'rxvt');
    assert.equal(classifyTerminal({ termname: 'rxvt' }), 'rxvt');
  });

  test('env table', () => {
    assert.equal(classifyTerminal({ env: { TERM_PROGRAM: 'iTerm.app' } }), 'iterm2');
    assert.equal(classifyTerminal({ env: { LC_TERMINAL: 'iTerm2' } }), 'iterm2');
    assert.equal(classifyTerminal({ env: { TERM_PROGRAM: 'WarpTerminal' } }), 'warp');
    assert.equal(classifyTerminal({ env: { LC_TERMINAL: 'WarpTerminal' } }), 'warp');
    assert.equal(classifyTerminal({ env: { KITTY_WINDOW_ID: '1' } }), 'kitty');
    assert.equal(classifyTerminal({ env: { WEZTERM_EXECUTABLE: '/usr/bin/wezterm' } }), 'wezterm');
    assert.equal(classifyTerminal({ env: { GHOSTTY_RESOURCES_DIR: '/opt/ghostty' } }), 'ghostty');
    assert.equal(classifyTerminal({ env: { TERM: 'rxvt-unicode' } }), 'rxvt');
  });

  test('denylist → unsupported', () => {
    assert.equal(classifyTerminal({ env: { TERM_PROGRAM: 'Apple_Terminal' } }), 'unsupported');
    assert.equal(classifyTerminal({ env: { TERM_PROGRAM: 'vscode' } }), 'unsupported');
    assert.equal(classifyTerminal({ env: { TERM_PROGRAM: 'alacritty' } }), 'unsupported');
    assert.equal(classifyTerminal({ env: { TERM: 'alacritty' } }), 'unsupported');
    assert.equal(classifyTerminal({ env: { TERM_PROGRAM: 'zed' } }), 'unsupported');
    assert.equal(classifyTerminal({ termname: 'alacritty' }), 'unsupported');
    assert.equal(classifyTerminal({ termname: 'Apple_Terminal' }), 'unsupported');
  });

  test('unknown → null', () => {
    assert.equal(classifyTerminal({ termname: 'xterm-256color', env: {} }), null);
    assert.equal(classifyTerminal({}), null);
  });

  test('termname wins over env', () => {
    assert.equal(
      classifyTerminal({ termname: 'xterm-kitty', env: { TERM_PROGRAM: 'iTerm.app' } }),
      'kitty',
    );
  });
});

// ── dialectFor ─────────────────────────────────────────────────────────────

describe('dialectFor', () => {
  test('maps brands to dialects', () => {
    for (const t of ['iterm2', 'kitty', 'wezterm', 'ghostty', 'warp']) {
      assert.equal(dialectFor(t), 'osc9');
    }
    assert.equal(dialectFor('rxvt'), 'osc777');
    assert.equal(dialectFor('unsupported'), null);
    assert.equal(dialectFor(null), null);
  });
});

// ── writeToTty ─────────────────────────────────────────────────────────────

describe('writeToTty', () => {
  test('writes whole sequence in one go to a regular file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'unsnooze-tty-'));
    const path = join(dir, 'fake-tty');
    try {
      // Create empty file first so open(O_WRONLY) succeeds.
      await fsp.writeFile(path, '');
      const payload = '\x1b]9;hi: there\x07';
      const ok = await writeToTty(path, payload);
      assert.equal(ok, true);
      assert.equal(readFileSync(path, 'utf8'), payload);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('missing path is silent and returns false', async () => {
    const ok = await writeToTty('/no/such/path/ever/tty-missing-xyz', 'x');
    assert.equal(ok, false);
  });

  test('uses injectable fs and O_WRONLY|O_NOCTTY|O_NONBLOCK', async () => {
    const opens = [];
    const writes = [];
    let closed = false;
    const fakeFh = {
      write: async (buf) => {
        writes.push(Buffer.from(buf));
        return { bytesWritten: buf.length, buffer: buf };
      },
      close: async () => { closed = true; },
    };
    const fakeFs = {
      constants: nodeFs.constants,
      promises: {
        open: async (path, flags) => {
          opens.push({ path, flags });
          return fakeFh;
        },
      },
    };
    const ok = await writeToTty('/dev/ttys001', 'abc', { fs: fakeFs });
    assert.equal(ok, true);
    assert.equal(opens.length, 1);
    const expected = nodeFs.constants.O_WRONLY | nodeFs.constants.O_NOCTTY | nodeFs.constants.O_NONBLOCK;
    assert.equal(opens[0].flags, expected);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].toString(), 'abc');
    assert.equal(closed, true);
  });

  test('short write returns false (no retry)', async () => {
    let closed = false;
    const fakeFs = {
      constants: nodeFs.constants,
      promises: {
        open: async () => ({
          write: async (buf) => ({ bytesWritten: Math.max(0, buf.length - 1), buffer: buf }),
          close: async () => { closed = true; },
        }),
      },
    };
    const ok = await writeToTty('/dev/ttys001', 'abcdef', { fs: fakeFs });
    assert.equal(ok, false);
    assert.equal(closed, true);
  });
});

// ── sendOsc ────────────────────────────────────────────────────────────────

function recorderWriteTty() {
  const calls = [];
  const writeTty = async (path, data) => {
    calls.push({ path, data });
    return true;
  };
  return { calls, writeTty };
}

describe('sendOsc', () => {
  test('per-client dialect: kitty→osc9, rxvt→osc777', async () => {
    const { calls, writeTty } = recorderWriteTty();
    const mux = {
      clientTtys: async () => [
        { tty: '/dev/ttys001', termname: 'xterm-kitty' },
        { tty: '/dev/ttys002', termname: 'rxvt-unicode' },
      ],
      globalEnv: async () => ({}),
    };
    const n = await sendOsc('T', 'B', { mux, pane: '%1', writeTty, env: {} });
    assert.equal(n, 2);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].data, buildOsc9('T', 'B'));
    assert.equal(calls[1].data, buildOsc777('T', 'B'));
  });

  test('dedupes identical tty paths', async () => {
    const { calls, writeTty } = recorderWriteTty();
    const mux = {
      clientTtys: async () => [
        { tty: '/dev/ttys001', termname: 'xterm-kitty' },
        { tty: '/dev/ttys001', termname: 'xterm-kitty' },
      ],
      globalEnv: async () => ({}),
    };
    const n = await sendOsc('T', 'B', { mux, pane: '%1', writeTty, env: {} });
    assert.equal(n, 1);
    assert.equal(calls.length, 1);
  });

  test('unknown terminal skipped unless force', async () => {
    const { calls, writeTty } = recorderWriteTty();
    const mux = {
      clientTtys: async () => [
        { tty: '/dev/ttys001', termname: 'xterm-256color' },
      ],
      globalEnv: async () => ({}),
    };
    const n0 = await sendOsc('T', 'B', { mux, pane: '%1', writeTty, env: {}, force: false });
    assert.equal(n0, 0);
    assert.equal(calls.length, 0);

    const n1 = await sendOsc('T', 'B', { mux, pane: '%1', writeTty, env: {}, force: true });
    assert.equal(n1, 1);
    assert.equal(calls[0].data, buildOsc9('T', 'B'));
  });

  test('force: stale globalEnv denylist alone still sends OSC 9', async () => {
    // notifyChannel=osc escape hatch — server env may be stale after reattach.
    const { calls, writeTty } = recorderWriteTty();
    const mux = {
      clientTtys: async () => [
        { tty: '/dev/ttys001', termname: 'xterm-256color' },
      ],
      globalEnv: async () => ({ TERM_PROGRAM: 'Apple_Terminal' }),
    };
    const n = await sendOsc('T', 'B', { mux, pane: '%1', writeTty, env: {}, force: true });
    assert.equal(n, 1);
    assert.equal(calls[0].data, buildOsc9('T', 'B'));
  });

  test('force: server+caller both denylisted still blocks', async () => {
    // classifyClient stops at server layer; force must still honor caller denylist.
    const { calls, writeTty } = recorderWriteTty();
    const mux = {
      clientTtys: async () => [
        { tty: '/dev/ttys001', termname: 'xterm-256color' },
      ],
      globalEnv: async () => ({ TERM_PROGRAM: 'Apple_Terminal' }),
    };
    const n = await sendOsc('T', 'B', {
      mux, pane: '%1', writeTty,
      env: { TERM_PROGRAM: 'Apple_Terminal' },
      force: true,
    });
    assert.equal(n, 0);
    assert.equal(calls.length, 0);
  });

  test('auto: globalEnv denylist still skips (force-only escape)', async () => {
    const { calls, writeTty } = recorderWriteTty();
    const mux = {
      clientTtys: async () => [
        { tty: '/dev/ttys001', termname: 'xterm-256color' },
      ],
      globalEnv: async () => ({ TERM_PROGRAM: 'Apple_Terminal' }),
    };
    const n = await sendOsc('T', 'B', { mux, pane: '%1', writeTty, env: {}, force: false });
    assert.equal(n, 0);
    assert.equal(calls.length, 0);
  });

  test('force: per-client denylist (caller env) still blocks', async () => {
    const { calls, writeTty } = recorderWriteTty();
    const mux = {
      clientTtys: async () => [
        { tty: '/dev/ttys001', termname: 'xterm-256color' },
      ],
      globalEnv: async () => ({}),
    };
    const n = await sendOsc('T', 'B', {
      mux, pane: '%1', writeTty,
      env: { TERM_PROGRAM: 'Apple_Terminal' },
      force: true,
    });
    assert.equal(n, 0);
    assert.equal(calls.length, 0);
  });

  test('force: per-client denylist (termname) still blocks', async () => {
    const { calls, writeTty } = recorderWriteTty();
    const mux = {
      clientTtys: async () => [
        { tty: '/dev/ttys001', termname: 'alacritty' },
      ],
      globalEnv: async () => ({}),
    };
    const n = await sendOsc('T', 'B', { mux, pane: '%1', writeTty, env: {}, force: true });
    assert.equal(n, 0);
    assert.equal(calls.length, 0);
  });

  test('uses server env then caller env for detection', async () => {
    const { calls, writeTty } = recorderWriteTty();
    const mux = {
      clientTtys: async () => [
        { tty: '/dev/ttys001', termname: 'xterm-256color' },
      ],
      globalEnv: async () => ({ TERM_PROGRAM: 'iTerm.app' }),
    };
    const n = await sendOsc('T', 'B', { mux, pane: '%1', writeTty, env: {} });
    assert.equal(n, 1);
    assert.equal(calls[0].data, buildOsc9('T', 'B'));
  });

  test('caller env used when server env empty', async () => {
    const { calls, writeTty } = recorderWriteTty();
    const mux = {
      clientTtys: async () => [
        { tty: '/dev/ttys001', termname: 'xterm-256color' },
      ],
      globalEnv: async () => ({}),
    };
    const n = await sendOsc('T', 'B', {
      mux, pane: '%1', writeTty,
      env: { KITTY_WINDOW_ID: '42' },
    });
    assert.equal(n, 1);
    assert.equal(calls[0].data, buildOsc9('T', 'B'));
  });

  test('empty clients → 0', async () => {
    const { writeTty } = recorderWriteTty();
    const mux = { clientTtys: async () => [], globalEnv: async () => ({}) };
    assert.equal(await sendOsc('T', 'B', { mux, pane: '%1', writeTty }), 0);
  });

  test('throwing mux.clientTtys → 0', async () => {
    const { writeTty } = recorderWriteTty();
    const mux = {
      clientTtys: async () => { throw new Error('tmux down'); },
    };
    assert.equal(await sendOsc('T', 'B', { mux, pane: '%1', writeTty }), 0);
  });

  test('missing clientTtys → 0', async () => {
    assert.equal(await sendOsc('T', 'B', { mux: {}, pane: '%1' }), 0);
    assert.equal(await sendOsc('T', 'B', { mux: null, pane: '%1' }), 0);
  });

  test('writeTty failures do not reject; only successes counted', async () => {
    let i = 0;
    const writeTty = async () => {
      i += 1;
      if (i === 1) return false;
      if (i === 2) throw new Error('boom');
      return true;
    };
    const mux = {
      clientTtys: async () => [
        { tty: '/dev/a', termname: 'xterm-kitty' },
        { tty: '/dev/b', termname: 'xterm-kitty' },
        { tty: '/dev/c', termname: 'xterm-kitty' },
      ],
      globalEnv: async () => ({}),
    };
    const n = await sendOsc('T', 'B', { mux, pane: '%1', writeTty, env: {} });
    assert.equal(n, 1);
  });

  test('never rejects', async () => {
    await assert.doesNotReject(() => sendOsc('T', 'B', {
      mux: { clientTtys: async () => { throw new Error('x'); } },
      pane: '%1',
    }));
  });
});

// ── sendBell ───────────────────────────────────────────────────────────────

describe('sendBell', () => {
  test('writes BEL to pane tty', async () => {
    const { calls, writeTty } = recorderWriteTty();
    const mux = { paneTty: async (pane) => {
      assert.equal(pane, '%3');
      return '/dev/ttys009';
    } };
    const ok = await sendBell({ mux, pane: '%3', writeTty });
    assert.equal(ok, true);
    assert.deepEqual(calls, [{ path: '/dev/ttys009', data: '\x07' }]);
  });

  test('null paneTty → false', async () => {
    const { calls, writeTty } = recorderWriteTty();
    const mux = { paneTty: async () => null };
    assert.equal(await sendBell({ mux, pane: '%1', writeTty }), false);
    assert.equal(calls.length, 0);
  });

  test('throwing paneTty → false', async () => {
    const { writeTty } = recorderWriteTty();
    const mux = { paneTty: async () => { throw new Error('gone'); } };
    assert.equal(await sendBell({ mux, pane: '%1', writeTty }), false);
  });

  test('missing paneTty → false', async () => {
    assert.equal(await sendBell({ mux: {}, pane: '%1' }), false);
  });
});
