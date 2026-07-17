// SGR-1006 mouse protocol: parsing, chunk reassembly, hit-testing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import {
  MOUSE_ENABLE,
  MOUSE_DISABLE_ALL,
  parseSgrEvents,
  isMouseNoise,
  hitTest,
} from '../src/dashboard/mouse-protocol.js';

// SIGTERM/SIGTSTP semantics below are unix process-signal behavior; native
// Windows has no SIGSTOP/SIGTSTP and ps -o stat= doesn't exist there.
const SKIP_WIN32 = process.platform === 'win32' ? 'unix signal semantics (SIGTSTP/SIGSTOP, ps -o stat=)' : false;

// Child prints 'ready' once the cleanup handlers are installed, then idles
// via setInterval so the process stays alive to receive a signal.
const CLEANUP_CHILD_SCRIPT = `
  const { installMouseCleanup } = await import(process.cwd() + '/src/dashboard/run.js');
  installMouseCleanup(process.stdout);
  process.stdout.write('ready\\n');
  setInterval(() => {}, 1000);
`;

// Returns { child, output, ready } — `output` accumulates for the child's
// whole life (so post-signal writes like the mouse-disable sequence are
// captured too); `ready` resolves once the child has installed its handlers.
function spawnCleanupChild() {
  const child = spawn(process.execPath, ['--input-type=module', '-e', CLEANUP_CHILD_SCRIPT], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const output = { text: '' };
  let resolveReady;
  const ready = new Promise((resolve) => { resolveReady = resolve; });
  child.stdout.on('data', (chunk) => {
    output.text += chunk.toString();
    if (output.text.includes('ready')) resolveReady();
  });
  return { child, output, ready };
}

test('mode strings: enable 1002+1006, disable everything defensively', () => {
  assert.equal(MOUSE_ENABLE, '\x1b[?1002h\x1b[?1006h');
  for (const mode of ['1003', '1002', '1000', '1006', '1015']) {
    assert.ok(MOUSE_DISABLE_ALL.includes(`[?${mode}l`), `disables ${mode}`);
  }
});

test('parseSgrEvents: press / release / wheel / drag / move, 1-based → 0-based', () => {
  const { events, rest } = parseSgrEvents(
    '\x1b[<0;12;5M\x1b[<0;12;5m\x1b[<64;3;4M\x1b[<65;3;4M\x1b[<32;10;5M\x1b[<35;10;5M',
  );
  assert.equal(rest, '');
  assert.deepEqual(events.map(e => e.type), ['press', 'release', 'wheel', 'wheel', 'drag', 'move']);
  assert.deepEqual(events[0], {
    type: 'press', button: 'left', wheel: null,
    x: 11, y: 4, shift: false, meta: false, ctrl: false,
  });
  assert.equal(events[1].type, 'release');
  assert.equal(events[2].wheel, 'up');
  assert.equal(events[3].wheel, 'down');
  assert.equal(events[4].button, 'left');   // drag carries the held button
  assert.equal(events[5].button, null);     // bare motion has no button
});

test('parseSgrEvents: modifier bits and other buttons', () => {
  const { events } = parseSgrEvents('\x1b[<16;2;2M\x1b[<2;7;7M\x1b[<1;7;7M\x1b[<4;9;9M');
  assert.equal(events[0].ctrl, true);
  assert.equal(events[0].button, 'left');
  assert.equal(events[1].button, 'right');
  assert.equal(events[2].button, 'middle');
  assert.equal(events[3].shift, true);
});

test('parseSgrEvents: partial sequence carried in rest, completed by next chunk', () => {
  const first = parseSgrEvents('\x1b[<0;1');
  assert.equal(first.events.length, 0);
  assert.equal(first.rest, '\x1b[<0;1');
  const second = parseSgrEvents(first.rest + '2;5M');
  assert.equal(second.events.length, 1);
  assert.equal(second.rest, '');
  assert.equal(second.events[0].x, 11);
});

test('parseSgrEvents: keyboard bytes and legacy CSI M are ignored, not events', () => {
  const { events, rest } = parseSgrEvents('qjk\x1b[A\x1b[M abc');
  assert.equal(events.length, 0);
  assert.equal(rest, '');
});

test('isMouseNoise flags leaked report fragments for the useInput guard', () => {
  assert.equal(isMouseNoise('[<35;10;5M'), true);
  assert.equal(isMouseNoise('\x1b[<0;1;1m'), true);
  assert.equal(isMouseNoise('q'), false);
  assert.equal(isMouseNoise('1'), false);
});

test('parseSgrEvents: extra mouse buttons (>= 128) have null button', () => {
  const { events } = parseSgrEvents('\x1b[<128;5;5M');
  assert.equal(events[0].type, 'press');
  assert.equal(events[0].button, null);
});

test('parseSgrEvents: horizontal wheel (base 2/3) has null wheel', () => {
  const { events: ev67 } = parseSgrEvents('\x1b[<67;5;5M'); // 67 = 64 + 3
  assert.equal(ev67[0].type, 'wheel');
  assert.equal(ev67[0].wheel, null);

  const { events: ev66 } = parseSgrEvents('\x1b[<66;5;5M'); // 66 = 64 + 2
  assert.equal(ev66[0].type, 'wheel');
  assert.equal(ev66[0].wheel, null);
});

test('parseSgrEvents: rest carry capped at 32 chars, longer candidates dropped', () => {
  // Create a partial that exceeds 32 chars
  const longPartial = '\x1b[<' + '1;'.repeat(40);
  const { rest: restLong } = parseSgrEvents(longPartial);
  assert.equal(restLong, '');

  // Short partial under 32 chars is still carried
  const shortPartial = '\x1b[<0;1';
  const { rest: restShort } = parseSgrEvents(shortPartial);
  assert.equal(restShort, '\x1b[<0;1');
});

test('hitTest: rectangle containment, last (topmost) match wins', () => {
  const a = { x: 0, y: 7, width: 10, height: 1, id: 'a' };
  const b = { x: 5, y: 7, width: 10, height: 1, id: 'b' };
  assert.equal(hitTest([a, b], 6, 7).id, 'b');
  assert.equal(hitTest([a, b], 2, 7).id, 'a');
  assert.equal(hitTest([a, b], 6, 8), null);
  assert.equal(hitTest([a, b], 10, 7).id, 'b'); // x+width exclusive: 0..9 for a
  assert.equal(hitTest([], 0, 0), null);
});

test('zonesToRects drops unmeasured zones and preserves registration order', async () => {
  const { zonesToRects } = await import('../src/dashboard/mouse.js');
  const zone = (x, y, width, height, id) => ({
    id,
    ref: { current: { __rect: { x, y, width, height } } },
    onClick: () => {},
  });
  // measure is injectable so tests don't need a live Ink layout tree
  const rects = zonesToRects(
    [zone(0, 7, 10, 1, 'a'), zone(0, 0, 0, 0, 'empty'), zone(5, 7, 10, 1, 'b')],
    node => node.__rect,
  );
  assert.deepEqual(rects.map(r => r.id), ['a', 'b']);
  assert.equal(hitTest(rects, 6, 7).id, 'b');
});

test('press dispatch filters to onClick zones so wheel-only containers do not swallow clicks', async () => {
  const { zonesToRects } = await import('../src/dashboard/mouse.js');
  const zone = (x, y, w, hgt, id, handlers) => ({
    id,
    ref: { current: { __rect: { x, y, width: w, height: hgt } } },
    ...handlers,
  });
  const row = zone(2, 5, 20, 1, 'row', { onClick: () => {} });
  const container = zone(0, 0, 40, 20, 'container', { onWheel: () => {} });
  // Simulate what press dispatch should do: filter to onClick zones before hitTest
  const clickable = [row, container].filter(z => z.onClick);
  const rects = zonesToRects(clickable, node => node.__rect);
  assert.equal(hitTest(rects, 10, 5).id, 'row');
});

test('installMouseCleanup writes disable-all on process exit exactly once', async () => {
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', `
    const { installMouseCleanup } = await import(process.cwd() + '/src/dashboard/run.js');
    installMouseCleanup(process.stdout);
    installMouseCleanup(process.stdout); // second install must not double-write
    process.exit(0);
  `], { encoding: 'utf-8' });
  assert.equal((out.match(/\x1b\[\?1003l/g) || []).length, 1);
  assert.match(out, /\x1b\[\?1002l/);
  assert.match(out, /\x1b\[\?1006l/);
});

test('installMouseCleanup: SIGTERM clears mouse modes and exits 143', { skip: SKIP_WIN32 }, async () => {
  const { child, output, ready } = spawnCleanupChild();
  try {
    await ready;
    child.kill('SIGTERM');
    // 'close' (not 'exit') guarantees stdio streams have finished emitting
    // 'data' before we assert on the accumulated output.
    const [code] = await new Promise((resolve) => {
      child.on('close', (exitCode, signal) => resolve([exitCode, signal]));
    });
    assert.equal(code, 143);
    assert.match(output.text, /\x1b\[\?1002l/);
    assert.match(output.text, /\x1b\[\?1006l/);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
  }
});

test('installMouseCleanup: SIGTSTP actually suspends the process (does not swallow the stop)', { skip: SKIP_WIN32 }, async () => {
  const { child, ready } = spawnCleanupChild();
  try {
    await ready;
    child.kill('SIGTSTP');
    const deadline = Date.now() + 2000;
    let stat = '';
    while (Date.now() < deadline) {
      try {
        stat = execFileSync('ps', ['-o', 'stat=', '-p', String(child.pid)], { encoding: 'utf-8' }).trim();
      } catch {
        stat = ''; // process already gone — treat as failure below, loop will time out
      }
      if (stat.startsWith('T')) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(stat.startsWith('T'), `expected suspended ('T') state within 2s, got "${stat}"`);
  } finally {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
});
