import { SITE_URL } from '../lib/site.js';
import { lastModifiedFor } from '../lib/lastmod.js';

// `priority` and `changefreq` are deliberately absent: Google ignores both
// outright, and Bing treats priority as noise. `lastmod` is the one sitemap
// hint that still influences crawl scheduling, so it is the only one worth
// emitting — and only when it is genuinely accurate. See lib/lastmod.js for
// why an unavailable date is omitted rather than guessed.
const ROUTES = [
  '/',
  '/docs/',
  '/docs/commands/',
  '/docs/settings/',
  '/docs/fleet/',
  '/docs/troubleshooting/',
  '/changelog/',
  '/feedback/',
];

export default function sitemap() {
  return ROUTES.map((route) => {
    const lastModified = lastModifiedFor(route);
    return {
      url: `${SITE_URL}${route}`,
      ...(lastModified ? { lastModified } : {}),
    };
  });
}
