// SGR-1006 mouse protocol — pure functions, no React/Ink imports.
// Enable: button-event tracking (1002) + SGR encoding (1006). 1003 (any
// motion) is deliberately never requested: it floods stdin and is the worst
// leak class when cleanup is missed.
export const MOUSE_ENABLE = '\x1b[?1002h\x1b[?1006h';
// Disable every mode we (or a crashed predecessor) might have set — turning
// off a mode that was never on is harmless (tcell does the same).
export const MOUSE_DISABLE_ALL = '\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?1006l\x1b[?1015l';

// \x1b[<b;x;yM (press/motion/wheel) or \x1b[<b;x;ym (release)
const SGR_RE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

// b bit layout: 0/1/2 = left/middle/right (or wheel dir), +4 shift, +8 meta,
// +16 ctrl, +32 motion, +64 wheel.
function decodeEvent(b, x1, y1, final) {
  const base = b & 3;
  const ev = {
    x: x1 - 1,   // SGR is 1-based; everything downstream is 0-based
    y: y1 - 1,
    shift: (b & 4) !== 0,
    meta: (b & 8) !== 0,
    ctrl: (b & 16) !== 0,
    wheel: null,
    button: null,
  };
  if ((b & 64) !== 0 && b < 128) {
    const wheel = base === 0 ? 'up' : base === 1 ? 'down' : null;
    return { ...ev, type: 'wheel', wheel };
  }
  // b >= 128 means extra buttons (xterm 8-11); these map to button: null
  const button = b >= 128 ? null : (base === 0 ? 'left' : base === 1 ? 'middle' : base === 2 ? 'right' : null);
  if (final === 'm') return { ...ev, type: 'release', button };
  if ((b & 32) !== 0) return { ...ev, type: button ? 'drag' : 'move', button };
  return { ...ev, type: 'press', button };
}

// Parse every complete SGR report in `text`. A report can be split across
// stdin chunks — `rest` returns the trailing partial (from its ESC) so the
// caller can prepend it to the next chunk.
export function parseSgrEvents(text) {
  const events = [];
  let lastEnd = 0;
  SGR_RE.lastIndex = 0;
  let m;
  while ((m = SGR_RE.exec(text))) {
    events.push(decodeEvent(parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10), m[4]));
    lastEnd = m.index + m[0].length;
  }
  const tail = text.slice(lastEnd);
  const escAt = tail.lastIndexOf('\x1b');
  let rest = '';
  if (escAt !== -1) {
    const candidate = tail.slice(escAt);
    // Only carry prefixes that can still become an SGR report.
    // Cap at 32 chars to prevent unbounded growth on malformed input.
    if (candidate.length <= 32 && /^\x1b(\[(<[\d;]*)?)?$/.test(candidate)) rest = candidate;
  }
  return { events, rest };
}

// Ink strips the ESC prefix from sequences its key parser can't resolve, so
// useInput handlers can receive fragments like "[<35;10;5M". Guard with this.
export function isMouseNoise(input) {
  return /\[?<\d+;\d+;\d+[Mm]/.test(String(input ?? ''));
}

// Zones are plain rects ({x, y, width, height, ...payload}). Registration
// order is stacking order: the LAST hit wins so overlays beat what's under.
export function hitTest(rects, col, row) {
  for (let i = rects.length - 1; i >= 0; i--) {
    const r = rects[i];
    if (col >= r.x && col < r.x + r.width && row >= r.y && row < r.y + r.height) return r;
  }
  return null;
}
