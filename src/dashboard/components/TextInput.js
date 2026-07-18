// Minimal controlled single-line text input — Ink ships no text-input
// primitive, and pulling in a dependency for one field type isn't worth it.
// `applyKey` is the pure edit reducer (the unit-test surface); the component
// is just useInput + a thin cursor-position wrapper around it.
import React, { useState } from 'react';
import { Text, useInput } from 'ink';
import { theme } from '../theme.js';

const h = React.createElement;

// Control bytes (incl. DEL) stripped from any inserted text — paste can
// arrive as a multi-char chunk carrying \n/\t/escape fragments; a single-line
// field never wants any of them, typed or pasted.
const CONTROL_RE = /[\x00-\x1f\x7f]/g; // eslint-disable-line no-control-regex

// state = {value, cursor}. Enter/Escape are submit/cancel signals owned by
// the component (not edits) — the reducer leaves state untouched for them.
export function applyKey(state, input, key) {
  const { value, cursor } = state;
  if (key.return || key.escape) return { value, cursor };
  if (key.leftArrow) return { value, cursor: Math.max(0, cursor - 1) };
  if (key.rightArrow) return { value, cursor: Math.min(value.length, cursor + 1) };
  if (key.home || (key.ctrl && input === 'a')) return { value, cursor: 0 };
  if (key.end || (key.ctrl && input === 'e')) return { value, cursor: value.length };
  if (key.ctrl || key.meta) return { value, cursor }; // no other modifier combos edit
  if (key.backspace || key.delete) {
    if (cursor === 0) return { value, cursor };
    return { value: value.slice(0, cursor - 1) + value.slice(cursor), cursor: cursor - 1 };
  }
  if (!input) return { value, cursor };
  const clean = input.replace(CONTROL_RE, '');
  if (!clean) return { value, cursor };
  return { value: value.slice(0, cursor) + clean + value.slice(cursor), cursor: cursor + clean.length };
}

export function TextInput({ value = '', onChange, onSubmit, onCancel, focus = true, placeholder = '' }) {
  const [cursor, setCursor] = useState(value.length);
  const c = Math.min(cursor, value.length);

  useInput((input, key) => {
    if (key.return) { onSubmit?.(value); return; }
    if (key.escape) { onCancel?.(); return; }
    const next = applyKey({ value, cursor: c }, input, key);
    if (next.cursor !== c) setCursor(next.cursor);
    if (next.value !== value) onChange?.(next.value);
  }, { isActive: focus });

  if (!value) {
    return h(Text, { color: theme.muted, dimColor: true }, placeholder || (focus ? '█' : ' '));
  }

  const before = value.slice(0, c);
  const after = value.slice(c + 1);
  const atCursor = c < value.length ? value[c] : null;

  return h(Text, null,
    before,
    atCursor != null
      ? h(Text, { inverse: true }, atCursor)
      : (focus ? '█' : ''),
    after,
  );
}
