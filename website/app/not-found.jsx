import SiteNav from '../components/SiteNav.jsx';
import SubFooter from '../components/SubFooter.jsx';

export const metadata = {
  title: 'Page not found',
  robots: { index: false },
};

export default function NotFound() {
  return (
    <div className="subpage">
      <SiteNav page="404" />
      <main className="wrap subpage-main">
        <header className="sub-hero">
          <p className="eyebrow">404 <span className="tick">·</span> lost in the dark</p>
          <h1 className="sub-title">This page is still asleep.</h1>
          <p className="section-lede">
            Nothing lives at this address. Try the <a href="/">overview</a>, the{' '}
            <a href="/docs/">docs</a>, or the <a href="/changelog/">changelog</a>.
          </p>
        </header>
      </main>
      <SubFooter />
    </div>
  );
}
