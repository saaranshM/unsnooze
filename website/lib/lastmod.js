import { execFileSync } from 'node:child_process';
import path from 'node:path';

// Real per-page modification dates, read from the git history of the files that
// actually render each route.
//
// Google honours <lastmod> only when it is "consistently and verifiably
// accurate". The two easy ways to produce one are both worse than omitting it:
// a build timestamp marks every page as changed on every deploy, and a shared
// release date claims the docs changed when only the changelog did. Either
// teaches Google to distrust the signal for the whole site.
//
// Git is the only source that knows when a page's content actually changed, so
// each route declares the files it is built from. A route whose date cannot be
// established gets NO lastmod — sitemaps handle its absence gracefully, and a
// wrong date is worse than no date.

const REPO_ROOT = path.join(process.cwd(), '..');
const cache = new Map();

function gitLastModified(files) {
  const key = files.join('|');
  if (cache.has(key)) return cache.get(key);
  let result = null;
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%cI', '--', ...files], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    // Empty output means the file is outside this clone's history (a shallow
    // CI checkout, or a build with no .git at all) — not an error, just no
    // answer. Falling back to "now" here is exactly the mistake described above.
    if (out) {
      const d = new Date(out);
      if (!Number.isNaN(d.getTime())) result = d;
    }
  } catch {
    result = null;   // git missing or repo unavailable — omit rather than guess
  }
  cache.set(key, result);
  return result;
}

// The files whose content a reader would see change on each route. Shared
// chrome (nav, footer) is deliberately excluded: a footer tweak is not a
// content update, and treating it as one is how lastmod stops being trusted.
const ROUTE_SOURCES = {
  '/': ['website/app/page.jsx', 'website/components', 'website/lib/faq-data.jsx'],
  '/docs/': ['website/app/docs/page.jsx'],
  '/docs/commands/': ['website/app/docs/commands/page.jsx'],
  '/docs/settings/': ['website/app/docs/settings/page.jsx'],
  '/docs/fleet/': ['website/app/docs/fleet/page.jsx'],
  '/docs/troubleshooting/': ['website/app/docs/troubleshooting/page.jsx'],
  // The changelog page renders CHANGELOG.md, so the markdown IS the content.
  '/changelog/': ['CHANGELOG.md'],
  '/feedback/': ['website/app/feedback/page.jsx', 'website/components/FeedbackClient.jsx'],
};

export function lastModifiedFor(route) {
  const files = ROUTE_SOURCES[route];
  return files ? gitLastModified(files) : null;
}
