import Reveal from './Reveal.jsx';

const C = ({ children }) => <code className="chip">{children}</code>;

// Ordered by how much of unsnooze each one lights up. headless is last and
// framed as the floor, not a peer — it is what you get when there is no
// multiplexer at all, and it gives up real things.
const TERMINALS = [
  {
    name: 'tmux',
    req: '≥ 3.2',
    href: 'https://github.com/tmux/tmux',
    body: <>The reference backend, and the only one that can push OSC notifications straight
      to the terminal you are actually looking at. Everything else is measured against it.</>,
  },
  {
    name: 'Zellij',
    href: 'https://zellij.dev',
    body: <>Full parity for the whole session lifecycle — detect, resume in place, revive a
      dead pane, reap idle sessions.</>,
  },
  {
    name: 'herdr',
    req: '≥ 0.8.0',
    href: 'https://herdr.dev',
    body: <>Built for running coding agents, and it restores saved agent panes by itself — so
      unsnooze never restarts a stopped herdr session, and revives into a fresh name instead.
      Restarting one could resume the same conversation twice.</>,
  },
  {
    name: 'cmux',
    href: 'https://cmux.dev',
    body: <>Detect, resume and revive all work. It has no joinable named session, so a revival
      opens a fresh workspace and there is no <C>attach:</C> hint to print.</>,
  },
];

export default function Terminals() {
  return (
    <section id="terminals">
      <Reveal>
        <p className="eyebrow">wherever you work</p>
        <h2>Supported <span className="hl">terminals</span></h2>
        <p className="section-lede">
          Four terminal multiplexers, on macOS, Linux and Windows — and if you have none of
          them, unsnooze still catches and resumes your limit stops.
        </p>
      </Reveal>

      <div className="agents-core">
        {TERMINALS.map((t, i) => (
          <Reveal key={t.name} delay={Math.min(i * 0.06, 0.12)} className="cell">
            <h3>
              <a href={t.href} target="_blank" rel="noreferrer">{t.name}</a>
              {t.req && <span className="tag stable">{t.req}</span>}
            </h3>
            <p>{t.body}</p>
          </Reveal>
        ))}
      </div>

      <Reveal>
        <div className="exp-head">
          <span className="tag exp">no multiplexer</span>
          <span>
            With none installed, unsnooze runs <strong>headless</strong>: it reads limit stops
            from the Claude <C>StopFailure</C> hook and the session transcript instead of a
            pane, and revives into a detached process. That is what makes native Windows,
            bare servers and CI work. You give up the limit-menu answering and the live pane —
            so <C>headless</C> is only ever chosen when nothing else is there, never ahead of
            a real multiplexer.
          </span>
        </div>
        <div className="exp-rows">
          <div className="exp-row">
            <code>auto</code>
            <span>Uses the multiplexer you are already inside; failing that, the only one
              installed, with tmux breaking ties; failing that, headless.</span>
          </div>
          <div className="exp-row">
            <code>pin it</code>
            <span><C>unsnooze config set multiplexer tmux|zellij|herdr|cmux|headless</C> —
              and <a href="/docs/#terminals">the full capability table</a> is in the docs.</span>
          </div>
        </div>
      </Reveal>
    </section>
  );
}
