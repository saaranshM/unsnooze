import Reveal from './Reveal.jsx';

const CMDS = [
  ['unsnooze status', <>tracked sessions, reset countdowns, context sizes — or a live dashboard on a TTY</>],
  ['unsnooze dashboard', <>full-screen TUI: status, usage, sessions, doctor, logs — with mouse support</>],
  ['unsnooze usage', <>account burn &amp; time-to-limit forecast (<code className="chip">--json</code> for scripts)</>],
  ['unsnooze preview', <>dry-run: what would happen right now, and why — nothing is typed</>],
  ['unsnooze resume-now', <>don't wait for the reset time (<code className="chip">--all</code> for everything)</>],
  ['unsnooze cancel', <>stop tracking a session</>],
  ['unsnooze message <id>', <>per-session wake message (<code className="chip">--clear</code> to reset)</>],
  ['unsnooze sessions', <>list unsnooze-owned multiplexer sessions and panes</>],
  ['unsnooze hosts add <name>', <>register another machine over ssh — key or password auth (<code className="chip">hosts test</code> pre-flights it)</>],
  ['unsnooze fleet', <>every registered host's sessions in one view; resume/cancel remotely from the dashboard's fleet tab</>],
  ['unsnooze reap', <>close finished panes and empty sessions — dry-run by default</>],
  ['unsnooze doctor', <>install health check, with <code className="chip">--fix</code></>],
  ['unsnooze logs -f', <>what unsnooze has been doing, live</>],
  ['unsnooze report', <>capture a pane to report an undetected banner — how experimental adapters get good</>],
  ['unsnooze update', <>update unsnooze itself (a daily registry check tells you when)</>],
  ['unsnooze uninstall', <>remove every change it made (<code className="chip">--purge</code> for state too)</>],
];

export default function Commands() {
  return (
    <section id="commands">
      <Reveal>
        <p className="eyebrow">the toolbox</p>
        <h2>You mostly just run <span className="hl">claude</span></h2>
        <p className="section-lede">
          Day to day nothing changes — the shell wrapper watches <code className="chip">claude</code>,
          <code className="chip">codex</code> and friends automatically. The rest of the CLI is
          for looking around.
        </p>
      </Reveal>
      <Reveal delay={0.1}>
        <div className="cmds">
          {CMDS.map(([cmd, desc]) => (
            <FragmentRow key={cmd} cmd={cmd} desc={desc} />
          ))}
        </div>
      </Reveal>
    </section>
  );
}

function FragmentRow({ cmd, desc }) {
  return (
    <>
      <code>{cmd}</code>
      <span>{desc}</span>
    </>
  );
}
