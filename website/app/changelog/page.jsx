import SiteNav from '../../components/SiteNav.jsx';
import SubFooter from '../../components/SubFooter.jsx';
import { readChangelog } from '../../lib/changelog.js';
import { JsonLd, breadcrumbs } from '../../lib/jsonld.js';

export const metadata = {
  title: 'Changelog — every unsnooze release',
  description:
    "unsnooze release history, rendered straight from the repository's CHANGELOG.md — new agent adapters, guards, the usage forecast, the ssh fleet, and every fix with the reasoning behind it.",
  alternates: { canonical: '/changelog/' },
  openGraph: {
    title: 'unsnooze changelog',
    description: 'Every release, straight from the repository — nothing shown that has not shipped.',
    url: '/changelog/',
  },
};

export default async function ChangelogPage() {
  const entries = await readChangelog();

  return (
    <div className="subpage">
      <JsonLd data={breadcrumbs([['unsnooze', '/'], ['Changelog', '/changelog/']])} />
      <SiteNav page="changelog" />
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
                <h2>{`v${e.version}`}</h2>
                {e.date && <time>{e.date}</time>}
                {i === 0 && <span className="tag stable">latest</span>}
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
