'use client';

import { useEffect, useRef } from 'react';
import { useReducedMotion } from 'framer-motion';

export function TermWindow({ title, children, className = '', ...rest }) {
  return (
    <div className={`term ${className}`} {...rest}>
      <div className="term-bar">
        <i /><i /><i />
        <span className="title">{title}</span>
      </div>
      {children}
    </div>
  );
}

const SCRIPT = [
  { cls: 't-cmd', text: 'claude', pause: 700 },
  { cls: 't-out', text: '… refactoring the payment module …', pause: 900 },
  { cls: 't-limit', text: "You've hit your usage limit · resets 3am", pause: 500 },
  { cls: 't-us', text: 'unsnooze  recorded claude session f3a1 · waking at 3:00 am', pause: 1000 },
  { cls: 't-cmd', text: 'codex', pause: 600 },
  { cls: 't-limit', text: "■ You've hit your usage limit. Try again at 3:00 AM.", pause: 500 },
  { cls: 't-us', text: 'unsnooze  recorded codex session 8c42 · waking at 3:00 am', pause: 1100 },
  { cls: 't-zzz', text: 'z z z', pause: 1800 },
  { cls: 't-us', text: 'unsnooze  03:00 — limit reset', pause: 500 },
  { cls: 't-ok', text: '✓ claude f3a1 resumed · verified', pause: 550 },
  { cls: 't-ok', text: '✓ codex 8c42 resumed · verified', pause: 900 },
  { cls: 't-morning', text: 'good morning — the work is done.', pause: 5200 },
];

// The detect → wait → wake cycle, typed live. Imperative DOM writes keep the
// per-character loop out of React's render path.
export function LiveDemo() {
  const bodyRef = useRef(null);
  const reduced = useReducedMotion();

  useEffect(() => {
    const demo = bodyRef.current;
    if (!demo) return undefined;
    demo.innerHTML = '';

    if (reduced) {
      for (const l of SCRIPT) {
        const el = document.createElement('span');
        el.className = `ln ${l.cls}`;
        el.textContent = l.text;
        demo.appendChild(el);
      }
      return undefined;
    }

    const cursor = document.createElement('span');
    cursor.className = 'cursor';
    const timers = [];
    const later = (fn, ms) => timers.push(setTimeout(fn, ms));

    function typeLine(i) {
      if (i >= SCRIPT.length) {
        later(() => { demo.innerHTML = ''; typeLine(0); }, 400);
        return;
      }
      const l = SCRIPT[i];
      const el = document.createElement('span');
      el.className = `ln ${l.cls}`;
      demo.appendChild(el);
      el.appendChild(cursor);

      const isTyped = l.cls === 't-cmd';
      let pos = 0;
      function step() {
        if (pos < l.text.length) {
          el.insertBefore(document.createTextNode(l.text[pos]), cursor);
          pos += 1;
          later(step, isTyped ? 55 : 6);
        } else {
          later(() => typeLine(i + 1), l.pause);
        }
      }
      step();
    }
    typeLine(0);

    return () => timers.forEach(clearTimeout);
  }, [reduced]);

  return (
    <TermWindow
      title="tmux · unsnooze"
      aria-label="Terminal demo: unsnooze detects two limit-stopped sessions and wakes both at the reset time"
    >
      <div className="term-body" ref={bodyRef} />
    </TermWindow>
  );
}