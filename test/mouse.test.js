// SGR-1006 mouse protocol: parsing, chunk reassembly, hit-testing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MOUSE_ENABLE,
  MOUSE_DISABLE_ALL,
  parseSgrEvents,
  isMouseNoise,
  hitTest,
} from '../src/dashboard/mouse-protocol.js';

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
