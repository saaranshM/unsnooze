import Reveal from './Reveal.jsx';
import { TermWindow } from './Terminal.jsx';

const CARDS = [
  {
    title: 'One-shot, and verified',
    body: <>Each prompt is delivered exactly once — a fresh window running the agent in that
      project, prompt typed only after the input box is provably idle. If the limit turns
      out to still be active, the entry re-queues using the banner's <em>own</em> reset
      time and the window is closed; after repeated failures it gives up loudly.</>,
  },
  {
    title: 'Anchored, never guessed',
    body: <>Due-ness comes from real signals — the statusline's exact{' '}
      <code className="chip">resets_at</code> or your recorded limit stops. No signal means
      no limit to wait out: it delivers on the next daemon tick and{' '}
      <code className="chip">prompt add</code> says so up front.{' '}
      <code className="chip">--at 9pm</code> / <code className="chip">--at +2h30m</code>{' '}
      schedule an exact time instead.</>,
  },
  {
    title: 'Fleet-wide',
    body: <><code className="chip">--host gpu-box</code> queues on any registered machine
      over your own ssh; that host's daemon delivers under its own gates and reports back
      in <code className="chip">unsnooze fleet</code>. Hosts opt out with{' '}
      <code className="chip">remoteQueue off</code>.</>,
  },
];

export default function Prompts() {
  return (
    <section id="prompts">
      <Reveal>
        <p className="eyebrow">03:00 <span className="tick">·</span> the reset moment</p>
        <h2>Don't just resume — <span className="hl">queue what's next</span></h2>
        <p className="section-lede">
          Resuming snoozed work is half the night. <code className="chip">unsnooze prompt add</code>{' '}
          pre-writes the <em>next</em> task per project: the moment the limit resets, a brand-new
          agent session opens in that directory and your prompt is typed as its first message.
          Manage the queue from the dashboard's prompts tab, or entirely from the CLI.
        </p>
      </Reveal>
      <Reveal delay={0.1}>
        <TermWindow title="unsnooze prompt">
          <pre className="term-body">
            <span className="d-amber">$</span> <span className="d-ink">unsnooze prompt add</span> --project ~/work/payments <span className="d-faint">"run the full test suite and fix any failures"</span>{'\n'}
            <span className="d-dim">prompts: queued p-3f9a1c2e for claude in ~/work/payments — delivering after the reset</span>{'\n\n'}
            <span className="d-faint">  03:00:07</span> <span className="d-amber">queue</span>{'    '}new claude window in ~/work/payments · typing queued prompt{'\n'}
            <span className="d-faint">  03:00:29</span> <span className="d-green">verify</span>{'   '}pane healthy · no banner · <span className="d-green">delivered ▶</span> p-3f9a1c2e consumed{'\n'}
          </pre>
        </TermWindow>
      </Reveal>
      <div className="guards">
        {CARDS.map((c, i) => (
          <Reveal key={c.title} delay={Math.min(i * 0.05, 0.15)} className="guard">
            <h3>{c.title}</h3>
            <p>{c.body}</p>
          </Reveal>
        ))}
      </div>
    </section>
  );
}
