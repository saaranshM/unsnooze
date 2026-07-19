import fs from 'node:fs';
import path from 'node:path';
import { marked } from 'marked';

// The single source of truth: the repository's own CHANGELOG.md, read at
// build time, cross-checked against the npm registry so only versions that
// actually shipped to npm appear on the site. A version that's merged and
// dated but not yet published (e.g. tagged later by CI) stays hidden until
// the next build after it goes live.
async function npmLatest() {
  try {
    const res = await fetch('https://registry.npmjs.org/unsnooze', {
      headers: { Accept: 'application/vnd.npm.install-v1+json' }, // abbreviated doc
    });
    if (!res.ok) return null;
    const doc = await res.json();
    return doc['dist-tags']?.latest ?? null;
  } catch {
    return null; // offline build — fall back to showing every dated entry
  }
}

// true when a <= b for dotted numeric versions
const lte = (a, b) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0);
  }
  return true;
};

export async function readChangelog() {
  const raw = fs.readFileSync(path.join(process.cwd(), '..', 'CHANGELOG.md'), 'utf8');
  const latest = await npmLatest();

  return raw
    .split(/\n(?=## )/)
    .filter((chunk) => chunk.startsWith('## '))
    .map((chunk) => {
      const nl = chunk.indexOf('\n');
      const heading = chunk.slice(3, nl).trim();
      const [version, date] = heading.split(' — ');
      return {
        version,
        date: date || null,
        html: marked.parse(chunk.slice(nl + 1).trim()),
      };
    })
    .filter((e) => e.version !== 'Unreleased')
    // hide only versions NEWER than npm's latest: a dated section at or below
    // the latest release is shipped history even if that exact number was
    // folded into a later publish (1.13.0 shipped inside 1.14.0)
    .filter((e) => (latest ? lte(e.version, latest) : true));
}
