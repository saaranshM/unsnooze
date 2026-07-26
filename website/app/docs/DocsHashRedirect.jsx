'use client';

import { useEffect } from 'react';
import { SECTION_ROUTE } from '../../components/DocsNav.jsx';

// /docs/#fleet and friends are in the README and in whatever external links
// exist. Fragments never reach the server, so the redirect has to happen here.
export default function DocsHashRedirect() {
  useEffect(() => {
    const go = () => {
      const id = window.location.hash.slice(1);
      if (!id) return;
      const route = SECTION_ROUTE[id];
      // replace(), not assign(): a legacy anchor should not cost a back-button press.
      if (route && route !== '/docs/') window.location.replace(`${route}#${id}`);
    };

    go();
    // A same-document fragment change never remounts, so catch those too.
    window.addEventListener('hashchange', go);
    return () => window.removeEventListener('hashchange', go);
  }, []);

  return null;
}
