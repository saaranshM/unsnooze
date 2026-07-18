import Reveal from './Reveal.jsx';
import { FAQ } from '../lib/faq-data.jsx';

export default function Faq() {
  return (
    <section id="faq">
      <Reveal>
        <p className="eyebrow">asked at 4am</p>
        <h2>Questions people <span className="hl">actually ask</span></h2>
      </Reveal>
      <Reveal delay={0.08}>
        <div className="faq">
          {FAQ.map(({ q, jsx }) => (
            <details key={q}>
              <summary>{q}</summary>
              <p>{jsx}</p>
            </details>
          ))}
        </div>
      </Reveal>
    </section>
  );
}
