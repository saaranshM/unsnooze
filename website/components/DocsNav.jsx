// The docs used to be one page with fourteen in-page anchors, which meant
// fourteen distinct search intents competed for a single URL. They are now five
// routes grouped by what people actually search for. Labels are deliberately
// query-shaped rather than terse, since sidebar anchor text is one of the few
// direct topical signals left.

export const DOC_PAGES = [
  {
    path: '/docs/',
    label: 'Install & setup',
    sections: [['install', 'Getting started'], ['terminals', 'Supported terminals'], ['everyday', 'Day to day']],
  },
  {
    path: '/docs/commands/',
    label: 'Command reference',
    sections: [
      ['commands', 'Every command'],
      ['usage', 'Usage forecast'],
      ['prompts', 'Queued prompts'],
    ],
  },
  {
    path: '/docs/settings/',
    label: 'Settings & guards',
    sections: [
      ['settings', 'All settings'],
      ['guards', 'Guards'],
      ['notifications', 'Notifications'],
    ],
  },
  {
    path: '/docs/fleet/',
    label: 'SSH multi-host fleet',
    sections: [
      ['fleet', 'Fleet setup'],
      ['gui', 'GUI surfaces'],
      ['platforms', 'Platforms'],
    ],
  },
  {
    path: '/docs/troubleshooting/',
    label: 'Troubleshooting & security',
    sections: [
      ['troubleshooting', 'Troubleshooting'],
      ['security', 'Security model'],
      ['development', 'Development'],
    ],
  },
];

/** section id -> the route that now owns it, for redirecting legacy /docs/#id links. */
export const SECTION_ROUTE = Object.fromEntries(
  DOC_PAGES.flatMap((p) => p.sections.map(([id]) => [id, p.path])),
);

export default function DocsNav({ current }) {
  return (
    <aside className="docs-side">
      <nav aria-label="Docs sections">
        {DOC_PAGES.map((page) => {
          const active = page.path === current;
          return (
            <span key={page.path} className="docs-nav-group">
              <a href={page.path} className={active ? 'docs-nav-page is-active' : 'docs-nav-page'}>
                {page.label}
              </a>
              {active && page.sections.map(([id, title]) => (
                <a key={id} href={`#${id}`} className="docs-nav-sec">{title}</a>
              ))}
            </span>
          );
        })}
      </nav>
    </aside>
  );
}

/** Prev/next strip so the five pages form a readable path, not five islands. */
export function DocsPager({ current }) {
  const i = DOC_PAGES.findIndex((p) => p.path === current);
  const prev = i > 0 ? DOC_PAGES[i - 1] : null;
  const next = i >= 0 && i < DOC_PAGES.length - 1 ? DOC_PAGES[i + 1] : null;
  if (!prev && !next) return null;
  return (
    <nav className="docs-pager" aria-label="Docs pagination">
      {prev ? <a href={prev.path}>← {prev.label}</a> : <span />}
      {next ? <a href={next.path}>{next.label} →</a> : <span />}
    </nav>
  );
}
