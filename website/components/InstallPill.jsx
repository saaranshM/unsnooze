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
      <button type="button" className="copy-btn" onClick={copy} aria-label="Copy install command">
        {copied ? 'copied' : 'copy'}
      </button>
    </div>
  );
}