import { motion, useScroll, useTransform } from 'framer-motion';
import SiteNav from './components/SiteNav.jsx';
import NightClock from './components/NightClock.jsx';
import Celestial from './components/Celestial.jsx';
import Hero from './components/Hero.jsx';
import Compare from './components/Compare.jsx';
import Timeline from './components/Timeline.jsx';
import Agents from './components/Agents.jsx';
import Contract from './components/Contract.jsx';
import Dashboard from './components/Dashboard.jsx';
import Usage from './components/Usage.jsx';
import Guards from './components/Guards.jsx';
import Commands from './components/Commands.jsx';
import Faq from './components/Faq.jsx';
import Footer from './components/Footer.jsx';

// Deterministic star field — same sky on every visit.
const STARS = Array.from({ length: 42 }, (_, i) => {
  const rand = (n) => {
    const x = Math.sin(i * 127.1 + n * 311.7) * 43758.5453;
    return x - Math.floor(x);
  };
  return {
    top: `${rand(1) * 92}%`,
    left: `${rand(2) * 98}%`,
    size: rand(3) > 0.75 ? 2 : 1.4,
    delay: `${rand(4) * 4.5}s`,
  };
});

export default function App() {
  const { scrollYProgress } = useScroll();
  // Night → dawn: the warm glow rises as you scroll; the stars go out.
  const dawnOpacity = useTransform(scrollYProgress, [0, 0.5, 0.85, 1], [0, 0.05, 0.3, 1]);
  const starOpacity = useTransform(scrollYProgress, [0, 0.7, 0.95], [1, 0.8, 0]);

  return (
    <div id="app">
      <motion.div className="stars-layer" aria-hidden="true" style={{ opacity: starOpacity }}>
        {STARS.map((s, i) => (
          <span
            key={i}
            style={{
              top: s.top, left: s.left,
              width: s.size, height: s.size,
              animationDelay: s.delay,
            }}
          />
        ))}
      </motion.div>
      <motion.div className="dawn-layer" aria-hidden="true" style={{ opacity: dawnOpacity }} />
      <Celestial />

      <SiteNav />
      <NightClock />

      <main className="wrap" id="top">
        <Hero />
        <Compare />
        <Timeline />
        <Agents />
        <Contract />
        <Dashboard />
        <Usage />
        <Guards />
        <Commands />
        <Faq />
        <Footer />
      </main>
    </div>
  );
}
