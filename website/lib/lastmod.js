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

function git(args) {
  try {
    return execFileSync('git', args, {
      cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

// Vercel checks out at depth 10. In a truncated history `git log -1 -- <file>`
// cannot say "this file last changed before the clone begins" — it reports the
// oldest commit it can see, so every untouched file collapses onto the boundary
// commit and claims to have changed on the same day.
//
// This shipped once and was visibly wrong: five of eight URLs all carried the
// boundary commit's timestamp. So when the clone is shallow, a date equal to
// the boundary commit is treated as unknown. Pages genuinely edited inside the
// clone window still get a real date — which is the recency that actually
// matters for crawl scheduling — and the rest get nothing rather than a lie.
const shallow = git(['rev-parse', '--is-shallow-repository']) === 'true';
const boundary = shallow ? git(['rev-list', 'HEAD']).split('\n').pop().trim() : null;

function gitLastModified(files) {
  const key = files.join('|');
  if (cache.has(key)) return cache.get(key);
  let result = null;
  const out = git(['log', '-1', '--format=%cI%n%H', '--', ...files]);
  // Empty means no git, no repo, or a path outside this history — not an
  // error, just no answer. Falling back to "now" is the mistake described above.
  if (out) {
    const [iso, sha] = out.split('\n');
    const d = new Date(iso);
    const unreliable = shallow && sha && sha === boundary;
    if (!unreliable && !Number.isNaN(d.getTime())) result = d;
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
