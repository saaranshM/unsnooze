'use client';

import { useState } from 'react';
import { useScroll, useMotionValueEvent } from 'framer-motion';

// Shared top nav. Absolute hrefs — the site lives at the domain root on Vercel.
export default function SiteNav({ page = 'home' }) {
  const { scrollY } = useScroll();
  const [scrolled, setScrolled] = useState(false);
  useMotionValueEvent(scrollY, 'change', (y) => setScrolled(y > 24));

  const home = page === 'home';

  return (
    <div className={`nav-bar${scrolled ? ' scrolled' : ''}`}>
      <nav className="nav-inner" aria-label="Main">
        <a className="brand" href={home ? '#top' : '/'}>
          <span className="prompt">❯</span>unsnooze<span className="zz">&nbsp;z z z</span>
        </a>
        <div className="nav-links">
          {home ? (
            <>
              <a href="#why">why</a>
              <a href="#night">how it works</a>
              <a href="#agents">agents</a>
              <a href="#contract">security</a>
            </>
          ) : (
            <a href="/">overview</a>
          )}
          <a href="/docs/" className={page === 'docs' ? 'active always' : 'always'}>docs</a>
          <a href="/changelog/" className={page === 'changelog' ? 'active always' : 'always'}>changelog</a>
          <a href="/feedback/" className={page === 'feedback' ? 'active always' : 'always'}>feedback</a>
          <a className="always" href="https://github.com/saaranshM/unsnooze">github</a>
        </div>
      </nav>
    </div>
  );
}
