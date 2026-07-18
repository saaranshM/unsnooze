import { useState } from 'react';
import { useScroll, useMotionValueEvent } from 'framer-motion';
import LogoMark from './LogoMark.jsx';

// Shared top nav. `root` is the relative path back to the site root ('' on
// the home page, '../' on subpages) so the same component works from every
// route under a relative base.
export default function SiteNav({ root = '', page = 'home' }) {
  const { scrollY } = useScroll();
  const [scrolled, setScrolled] = useState(false);
  useMotionValueEvent(scrollY, 'change', (y) => setScrolled(y > 24));

  const home = page === 'home';

  return (
    <div className={`nav-bar${scrolled ? ' scrolled' : ''}`}>
      <nav className="nav-inner" aria-label="Main">
        <a className="brand" href={home ? '#top' : `${root}`}>
          <LogoMark size={22} />
          unsnooze<span className="zz">&nbsp;z z z</span>
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
            <a href={root || './'}>overview</a>
          )}
          <a href={`${root}docs/`} className={page === 'docs' ? 'active always' : 'always'}>docs</a>
          <a href={`${root}changelog/`} className={page === 'changelog' ? 'active always' : 'always'}>changelog</a>
          <a className="always" href="https://github.com/saaranshM/unsnooze">github</a>
        </div>
      </nav>
    </div>
  );
}
