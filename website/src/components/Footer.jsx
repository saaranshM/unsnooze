import Reveal from './Reveal.jsx';
import InstallPill from './InstallPill.jsx';

export default function Footer() {
  return (
    <footer>
      {/* Landing spot for the traveling sun — kept outside the Reveal so the
          horizon doesn't move while the footer animates in. Renders as a
          static sun only for reduced-motion visitors. */}
      <div className="sun-anchor" id="sun-anchor" aria-hidden="true" />
      <Reveal>
        <p className="eyebrow">07:22 <span className="tick">·</span> the next morning</p>
        <h2>Good morning.<br />The work is <span className="hl">done</span>.</h2>
        <p className="section-lede">One command tonight; every limit-stopped session awake by sunrise.</p>
        <InstallPill />
      </Reveal>
      <div className="foot-links">
        <a href="docs/">docs</a>
        <a href="changelog/">changelog</a>
        <a href="https://github.com/saaranshM/unsnooze">github</a>
        <a href="https://www.npmjs.com/package/unsnooze">npm</a>
        <a href="https://github.com/saaranshM/unsnooze/blob/main/SECURITY.md">security</a>
        <a href="https://github.com/saaranshM/unsnooze/issues">issues</a>
      </div>
      <p className="colophon">❯ z z z &nbsp;·&nbsp; MIT © Saaransh Menon</p>
    </footer>
  );
}
