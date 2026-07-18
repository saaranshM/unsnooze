import fs from 'node:fs';
import path from 'node:path';
import { marked } from 'marked';

// The single source of truth: the repository's own CHANGELOG.md, read at
// build time (this module is only imported from statically-rendered server
// code). Published releases only — the "Unreleased" section stays off the site.
export function readChangelog() {
  const raw = fs.readFileSync(path.join(process.cwd(), '..', 'CHANGELOG.md'), 'utf8');
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
    .filter((e) => e.version !== 'Unreleased');
}
