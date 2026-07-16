import React from 'react';
import { Box, Text, useAnimation, useIsScreenReaderEnabled } from 'ink';
import { CHEVRON, Z_FRAMES, WORDMARK, WORDMARK_SPLIT, MARK_LINE, markPlainText } from './mark.js';
import { theme } from './theme.js';

const h = React.createElement;

/*
 * Animated brand mark: big "❯" chevron + z's rising off its tip.
 * Slow idle loop (~2.7s cycle) — chrome animation should whisper, not flicker.
 * Static under screen readers (frame pinned so the mark stays announceable).
 */

const FRAME_MS = 450;

export function Logo({ compact = false, wordmark = false } = {}) {
  const screenReader = useIsScreenReaderEnabled();
  const { frame } = useAnimation({ interval: FRAME_MS, isActive: !screenReader && !compact });

  if (compact) {
    return h(Box, { flexDirection: 'row' },
      h(Text, { color: theme.accent, bold: true }, '❯ '),
      h(Text, { color: theme.accent2 }, 'z z z'),
    );
  }

  const zs = screenReader ? Z_FRAMES[2] : Z_FRAMES[frame % Z_FRAMES.length];

  return h(Box, { flexDirection: 'row', alignItems: 'flex-start' },
    h(Box, { flexDirection: 'column' },
      ...CHEVRON.map((line, i) =>
        h(Text, { key: 'c' + i, color: theme.accent, bold: true }, line),
      ),
    ),
    h(Box, { flexDirection: 'column', marginLeft: 1 },
      ...zs.map((line, i) =>
        h(Text, {
          key: 'z' + i,
          color: theme.accent2,
          // The big Z leading the drift reads bright; freshly-spawned z's dim
          bold: /Z/.test(line),
          dimColor: /z/.test(line) && i >= 2,
        }, line || ' '),
      ),
    ),
    wordmark
      ? h(Box, { flexDirection: 'column', marginLeft: 2 },
        // "UN" amber, "SNOOZE" bright — the banner's two-tone treatment
        ...WORDMARK.map((line, i) =>
          h(Text, { key: 'w' + i },
            h(Text, { color: theme.accent, bold: true }, line.slice(0, WORDMARK_SPLIT)),
            h(Text, { color: theme.bright, bold: true }, line.slice(WORDMARK_SPLIT)),
          ),
        ),
      )
      : null,
  );
}

export function logoContainsBrand() {
  const blob = CHEVRON.join('\n') + Z_FRAMES.flat().join('\n');
  return {
    prompt: '❯',
    hasZ: /z/i.test(blob),
    hasChevron: /█|▀|▄/.test(blob),
    frames: Z_FRAMES,
  };
}

export function logoPlainText() {
  return markPlainText();
}

export { MARK_LINE };
