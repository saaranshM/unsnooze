'use client';

import { useRef, useState } from 'react';

const CMD = 'npm install -g unsnooze && unsnooze setup';

// The pill is a live terminal line — blinking caret, no chrome — and the
// whole thing is the copy trigger. On tap the command dims to sleep and a
// tiny sun rises inside the pill with "copied": the site's night-to-dawn
// story in miniature.
export default function InstallPill() {
  const [copied, setCopied] = useState(false);
  const timer = useRef(null);

  const copy = () => {
    navigator.clipboard?.writeText(CMD).catch(() => {});
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1700);
  };

  return (
    <button
      type="button"
      className={copied ? 'install copied' : 'install'}
      onClick={copy}
      aria-label="Copy install command"
    >
      <code className="cmd">
        <span className="p">$</span> npm install -g unsnooze <span className="amp">&amp;&amp;</span> unsnooze
        setup<span className="caret" aria-hidden="true" />
      </code>
      <span className="copy-fx" aria-hidden="true">
        <span className="mini-sun" />
        <span className="copied-word">copied</span>
      </span>
      <span className="sr-only" aria-live="polite">{copied ? 'Copied to clipboard' : ''}</span>
    </button>
  );
}
