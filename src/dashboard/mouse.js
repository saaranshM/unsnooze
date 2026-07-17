// Mouse context for the dashboard: enables SGR tracking, parses raw stdin,
// hit-tests presses/wheels against zones registered by <Clickable>.
// Keyboard parity is a hard rule — every click action has a key equivalent.
import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';
import { Box, useStdin, useStdout, measureElement } from 'ink';
import { MOUSE_ENABLE, MOUSE_DISABLE_ALL, parseSgrEvents, hitTest } from './mouse-protocol.js';

const h = React.createElement;
const MouseContext = createContext(null);

let zoneSeq = 0;

// Exported for tests: zones (insertion-ordered) → hitTest rects.
// `measure` is injectable; production uses ink's measureElement.
export function zonesToRects(zones, measure = measureElement) {
  const rects = [];
  for (const z of zones) {
    if (!z.ref.current) continue;
    let m;
    try { m = measure(z.ref.current); } catch { continue; }
    if (!m || m.width <= 0 || m.height <= 0) continue;
    rects.push({ ...m, ...z });
  }
  return rects;
}

export function MouseProvider({ initialEnabled = true, children }) {
  const { stdin, isRawModeSupported } = useStdin();
  const { stdout } = useStdout();
  const supported = Boolean(isRawModeSupported && stdin && stdout);
  const [enabled, setEnabled] = useState(initialEnabled && supported);
  const zones = useRef(new Map());        // id -> { id, ref, onClick, onWheel }
  const wheelFallbacks = useRef(new Set());
  const carry = useRef('');

  const dispatch = useCallback((ev) => {
    if (ev.type === 'press' && ev.button === 'left') {
      const withClick = [...zones.current.values()].filter(z => z.onClick);
      const hit = hitTest(zonesToRects(withClick), ev.x, ev.y);
      if (hit?.onClick) hit.onClick(ev);
      return;
    }
    if (ev.type === 'wheel') {
      const withWheel = [...zones.current.values()].filter(z => z.onWheel);
      const hit = hitTest(zonesToRects(withWheel), ev.x, ev.y);
      if (hit?.onWheel) { hit.onWheel(ev); return; }
      for (const fn of wheelFallbacks.current) fn(ev);
    }
    // release / drag / move: no consumers today — deliberately dropped.
  }, []);

  useEffect(() => {
    if (!enabled || !supported) return undefined;
    carry.current = '';
    stdout.write(MOUSE_ENABLE);
    const onData = (chunk) => {
      const { events, rest } = parseSgrEvents(carry.current + String(chunk));
      carry.current = rest;
      for (const ev of events) dispatch(ev);
    };
    stdin.on('data', onData);
    // Ctrl-Z suspend: ink restores raw mode/alt screen on resume, but mouse
    // modes are ours — re-assert on SIGCONT (research: lazygit #1764 class).
    const onCont = () => stdout.write(MOUSE_ENABLE);
    process.on('SIGCONT', onCont);
    return () => {
      stdin.off('data', onData);
      process.off('SIGCONT', onCont);
      stdout.write(MOUSE_DISABLE_ALL);
    };
  }, [enabled, supported, stdin, stdout, dispatch]);

  const toggle = useCallback(() => setEnabled(e => supported && !e), [supported]);
  const registerZone = useCallback((zone) => {
    zones.current.set(zone.id, zone);
    return () => zones.current.delete(zone.id);
  }, []);
  const registerWheelFallback = useCallback((fn) => {
    wheelFallbacks.current.add(fn);
    return () => wheelFallbacks.current.delete(fn);
  }, []);

  return h(MouseContext.Provider, {
    value: { enabled, supported, toggle, registerZone, registerWheelFallback },
  }, children);
}

export function useMouse() {
  const ctx = useContext(MouseContext);
  return ctx
    ? { enabled: ctx.enabled, supported: ctx.supported, toggle: ctx.toggle }
    : { enabled: false, supported: false, toggle: () => {} };
}

export function useMouseWheel(handler) {
  const ctx = useContext(MouseContext);
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!ctx) return undefined;
    return ctx.registerWheelFallback((ev) => ref.current?.(ev));
  }, [ctx]);
}

// A Box whose on-screen rect is a mouse zone. All Box props pass through.
export function Clickable({ onClick, onWheel, children, ...boxProps }) {
  const ctx = useContext(MouseContext);
  const ref = useRef(null);
  const idRef = useRef(null);
  if (idRef.current == null) idRef.current = `zone-${++zoneSeq}`;
  const cbs = useRef({ onClick, onWheel });
  cbs.current = { onClick, onWheel };
  // Handler presence is fixed at mount (undefined→function post-mount is a no-op; remount to change).
  // Handler identity stays fresh via cbs ref, so onClick/onWheel changes do not require re-registration.
  useEffect(() => {
    if (!ctx) return undefined;
    return ctx.registerZone({
      id: idRef.current,
      ref,
      onClick: cbs.current.onClick ? (ev) => cbs.current.onClick?.(ev) : cbs.current.onClick,
      onWheel: cbs.current.onWheel ? (ev) => cbs.current.onWheel?.(ev) : cbs.current.onWheel,
    });
  }, [ctx]);
  return h(Box, { ref, ...boxProps }, children);
}
