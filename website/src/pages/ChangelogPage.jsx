import { marked } from 'marked';
import SiteNav from '../components/SiteNav.jsx';
import SubFooter from '../components/SubFooter.jsx';
// The single source of truth: the repository's own changelog, imported at
// build time. This page cannot drift from what actually shipped.
import raw from '../../../CHANGELOG.md?raw';

const entries = raw
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
  });

const latestIndex = entries.findIndex((e) => e.version !== 'Unreleased');

export default function ChangelogPage() {
  return (
    <div className="subpage">
      <SiteNav root="../" page="changelog" />
      <main className="wrap subpage-main">
        <header className="sub-hero">
          <p className="eyebrow">release history</p>
          <h1 className="sub-title">Changelog</h1>
          <p className="section-lede">
            Rendered straight from the repository's{' '}
            <a href="https://github.com/saaranshM/unsnooze/blob/main/CHANGELOG.md">CHANGELOG.md</a>{' '}
            at build time. Install any version with{' '}
            <code className="chip">npm i -g unsnooze@&lt;version&gt;</code>.
          </p>
        </header>

        <div className="cl-entries">
          {entries.map((e, i) => (
            <article className="cl-entry" key={e.version} id={`v${e.version}`}>
              <div className="cl-meta">
                <h2>{e.version === 'Unreleased' ? 'Unreleased' : `v${e.version}`}</h2>
                {e.date && <time>{e.date}</time>}
                {e.version === 'Unreleased' && <span className="tag exp">on main</span>}
                {i === latestIndex && <span className="tag stable">latest</span>}
              </div>
              {/* eslint-disable-next-line react/no-danger */}
              <div className="prose" dangerouslySetInnerHTML={{ __html: e.html }} />
            </article>
          ))}
        </div>
      </main>
      <SubFooter />
    </div>
  );
}
