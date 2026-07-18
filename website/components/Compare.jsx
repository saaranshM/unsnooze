import Reveal from './Reveal.jsx';

const ROWS = [
  ['Multi-CLI (Claude · Codex · Grok · Qwen · Kimi · OpenCode · Antigravity)', 'yes', 'no', 'no', 'part'],
  ['GUI sessions (VS Code extension, desktop apps)', 'yes', 'no', 'no', 'no'],
  ['Waits for reset & resumes the same session', 'yes', 'yes', 'yes', 'no'],
  ['All sessions at once (shared ledger + one daemon)', 'yes', 'no', 'yes', 'yes'],
  ['Revives sessions whose pane or process is gone', 'yes', 'no', 'no', 'no'],
  ['Survives laptop sleep & weekly-scale waits', 'yes', 'part', 'part', 'no'],
  ['Settings + first-run wizard', 'yes', 'no', 'no', 'no'],
];

const MARKS = { yes: <span className="yes">✓</span>, no: <span className="no">—</span>, part: <span className="part">partial</span> };

export default function Compare() {
  return (
    <section id="why">
      <Reveal>
        <p className="eyebrow">the problem</p>
        <h2>Every other tool solves <span className="hl">a slice</span>.</h2>
        <p className="section-lede">
          Overnight and long-running agent work dies at the 5-hour or weekly cap — one
          pane retried, one CLI covered, or your session abandoned for a different
          provider mid-thought. unsnooze guards all of it and always brings back
          the <em>same</em> session, same context, same conversation.
        </p>
      </Reveal>
      <Reveal delay={0.1}>
        <div className="compare-scroll">
          <table className="compare">
            <thead>
              <tr>
                <th scope="col"></th>
                <th scope="col" className="us">unsnooze</th>
                <th scope="col">claude-auto-retry</th>
                <th scope="col">autoclaude</th>
                <th scope="col">hydra</th>
              </tr>
            </thead>
            <tbody>
              {ROWS.map(([label, ...cells]) => (
                <tr key={label}>
                  <td>{label}</td>
                  {cells.map((c, i) => (
                    <td key={i} className={i === 0 ? 'us' : undefined}>{MARKS[c]}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Reveal>
    </section>
  );
}
