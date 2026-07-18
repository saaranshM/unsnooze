export default function SubFooter({ root = '../' }) {
  return (
    <footer className="sub-footer">
      <div className="foot-links">
        <a href={root || './'}>overview</a>
        <a href={`${root}docs/`}>docs</a>
        <a href={`${root}changelog/`}>changelog</a>
        <a href={`${root}feedback/`}>feedback</a>
        <a href="https://github.com/saaranshM/unsnooze">github</a>
        <a href="https://www.npmjs.com/package/unsnooze">npm</a>
        <a href="https://github.com/saaranshM/unsnooze/blob/main/SECURITY.md">security</a>
      </div>
      <p className="colophon">❯ z z z &nbsp;·&nbsp; MIT © Saaransh Menon</p>
    </footer>
  );
}
