'use client';

import { useRef, useState } from 'react';

const CMD = 'npm install -g unsnooze && unsnooze setup';

export default function InstallPill() {
  const [copied, setCopied] = useState(false);
  const timer = useRef(null);

  const copy = () => {
    navigator.clipboard.writeText(CMD).then(() => {
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1600);
    });
  };

  return (
    <div className="install">
      <code><span className="p">$</span> npm install -g unsnooze <span className="amp">&amp;&amp;</span> unsnooze setup</code>
      <button
        type="button"
        className={copied ? 'copy-btn copied' : 'copy-btn'}
        onClick={copy}
        aria-label={copied ? 'Copied' : 'Copy install command'}
        title="Copy install command"
      >
        {copied ? (
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M2.5 8.5l3.5 3.5 7.5-8" />
          </svg>
        ) : (
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
            <path d="M10.5 3.5v-1a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h1" />
          </svg>
        )}
      </button>
    </div>
  );
}