// Shared building blocks for the docs routes. Extracted when the single
// /docs/ page was split so the five pages stay visually identical.

export function Shell({ title = 'terminal', children }) {
  return (
    <div className="term docs-term">
      <div className="term-bar"><i /><i /><i /><span className="title">{title}</span></div>
      <pre className="term-body docs-term-body">{children}</pre>
    </div>
  );
}

export const C = ({ children }) => <code className="chip">{children}</code>;
