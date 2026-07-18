import Reveal from './Reveal.jsx';

const TERMS = [
  {
    dt: 'Types only after proving the pane is yours',
    dd: <>Every keystroke requires identity (an ownership stamp or a process-id + birth-time
      lease — pane ids get recycled, so a mismatch vetoes) and liveness (your agent is still
      running there, foreground, not mid-stream). Ownership unprovable → it opens a fresh
      session instead of typing.</>,
  },
  {
    dt: 'Never a blind Enter',
    dd: <>Claude's limit menu is located and read before any key is sent; unsnooze computes
      the exact moves to “Stop and wait for limit to reset.” Unreadable menu → it presses
      nothing. It will never select “Upgrade your plan.”</>,
  },
  {
    dt: 'No bypass flags, ever',
    dd: <>No <code className="chip">--dangerously-skip-permissions</code>, no auto-trust, no
      auto-approve, no touching MCP config. Whatever your agent does after resuming is
      governed by its own permission model — the same as if you'd typed the message
      yourself.</>,
  },
  {
    dt: 'See before you trust',
    dd: <><code className="chip">unsnooze preview</code> is a true dry-run: it prints exactly
      what would be typed, where, and why — or what's holding it back — and sends nothing.
      It shares its decision code with the real dispatcher, so it cannot drift from what
      dispatch actually does.</>,
  },
  {
    dt: 'Nearly zero network, zero telemetry',
    dd: <>One daily version check to the npm registry (nothing identifying; off with one
      setting), and push notifications only if you configure an ntfy topic. All state stays
      local under <code className="chip">~/.unsnooze</code>.</>,
  },
  {
    dt: 'Reversible install',
    dd: <>The settings hook and rc-file wrappers are backed up first;
      <code className="chip">unsnooze uninstall</code> removes every change. Releases are
      published to npm with provenance.</>,
  },
];

export default function Contract() {
  return (
    <section id="contract">
      <Reveal>
        <p className="eyebrow">trust <span className="tick">·</span> before you install</p>
        <h2>It presses your keys.<br />Here's <span className="hl">the contract</span>.</h2>
        <p className="section-lede">
          A tool that types into your terminal at 3am has to earn that. unsnooze is a
          scheduler, not an auto-approver — it never changes how your agent handles
          permissions.
        </p>
      </Reveal>
      <dl className="contract">
        {TERMS.map((t, i) => (
          <Reveal key={t.dt} delay={Math.min(i * 0.04, 0.14)}>
            <div className="row">
              <dt>{t.dt}</dt>
              <dd>{t.dd}</dd>
            </div>
          </Reveal>
        ))}
      </dl>
      <Reveal>
        <p className="honest">
          <strong>Honest limits:</strong> unsnooze <em>does</em> inject keystrokes into your
          live terminal on your behalf, and it does not sandbox your agent or defend against
          prompt injection — that's your agent's job. The full threat model and residual
          risks live in{' '}
          <a href="https://github.com/saaranshM/unsnooze/blob/main/SECURITY.md">SECURITY.md</a>.
        </p>
      </Reveal>
    </section>
  );
}
