import { useEffect } from 'react';
import {
  motion, useScroll, useTransform, useMotionValue, useMotionValueEvent, useReducedMotion,
} from 'framer-motion';

const lerp = (a, b, t) => a + (b - a) * t;
const seg = (p, a, b) => Math.min(1, Math.max(0, (p - a) / (b - a)));

const BASE = 112; // disc diameter at the top of the page
const DOCK = 0.93; // scroll progress where the sun starts settling onto the footer horizon
const GLOW = 90; // how far the halo extends past the disc

// One body crosses the whole page: a crescent moon in the hero that sinks as
// you read (moonset by mid-page), slips below the fold during the darkest
// hours, and comes back up the middle as the sun. Over the last stretch it
// docks onto the footer's #sun-anchor — measured live every frame — and sinks
// half-below the horizon, everything (disc AND halo) cut at the horizon line.
// The halo is painted by radial-gradient layers inside the clipped tree, not
// box-shadow — a shadow on the clipped element would either vanish or outline
// the missing half.
export default function Celestial() {
  const { scrollYProgress } = useScroll();
  const reduced = useReducedMotion();

  const left = useMotionValue(-9999);
  const top = useMotionValue(-9999);
  const width = useMotionValue(BASE);
  const height = useMotionValue(BASE);
  const clipPath = useMotionValue(`inset(0 0 0 0 round ${BASE / 2}px)`); // the disc
  const horizonClip = useMotionValue('inset(-999px)'); // the horizon cut, disc + halo

  const opacity = useMotionValue(1);
  const backgroundColor = useTransform(scrollYProgress, [0.35, 0.78], ['#dfe6f2', '#f59e0b']);
  const moonGlow = useTransform(scrollYProgress, [0, 0.5, 0.78], [1, 0.7, 0]);
  const sunGlow = useTransform(scrollYProgress, [0.62, 0.9, 1], [0, 0.85, 1]);
  const shadeX = useTransform(scrollYProgress, [0, 0.55], ['32%', '100%']);
  const shadeOpacity = useTransform(scrollYProgress, [0.5, 0.62], [1, 0]);
  const gradOpacity = useTransform(scrollYProgress, [0.62, 0.85], [0, 1]);

  const update = (p) => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const narrow = vw <= 640;
    // On narrow screens the path hugs the right edge so the body stays out of
    // the text column as long as possible.
    const edge = narrow ? 0.08 : 0;
    const size = BASE * (narrow ? 0.57 : 1) * (
      p < 0.5 ? lerp(1, 0.85, seg(p, 0, 0.5))
        : p < 0.65 ? lerp(0.85, 1.05, seg(p, 0.5, 0.65))
          : lerp(1.05, 1.25, seg(p, 0.65, DOCK))
    );

    // Path of the disc's center, in viewport px.
    let cx;
    let cy;
    if (p < 0.45) { // moonset down the right edge
      cx = (lerp(0.82, 0.86, seg(p, 0, 0.45)) + edge) * vw;
      cy = lerp(0.21, 0.72, seg(p, 0, 0.45)) * vh;
    } else if (p < 0.55) { // dipping below the fold
      cx = (lerp(0.86, 0.88, seg(p, 0.45, 0.55)) + edge) * vw;
      cy = lerp(0.72, 1.16, seg(p, 0.45, 0.55)) * vh;
    } else if (p < 0.62) { // the darkest hour — crossing to center, out of sight
      cx = lerp(0.88 + edge, 0.5, seg(p, 0.55, 0.62)) * vw;
      cy = 1.16 * vh;
    } else { // sunrise up the middle
      cx = 0.5 * vw;
      cy = lerp(1.16, 0.3, seg(p, 0.62, DOCK)) * vh;
    }

    // Base fade over the night, plus a strong dim on narrow screens while the
    // body travels through the text column — restored as it lands in the
    // footer's open space.
    let op = p < 0.45 ? lerp(1, 0.9, seg(p, 0, 0.45))
      : p < 0.55 ? lerp(0.9, 0.5, seg(p, 0.45, 0.55))
        : p < 0.65 ? lerp(0.5, 1, seg(p, 0.55, 0.65)) : 1;
    if (narrow) op *= lerp(0.4, 1, seg(p, DOCK, 1));

    const r = size / 2;
    let visibleBottom = cy + r; // where the lowest visible pixel sits
    let clip = 0; // how much of the disc is behind the horizon
    let rBottom = r; // bottom corner radius of the disc clip — 0 once landed
    let horizonBottom = -999; // halo uncut until the sun starts landing

    const anchor = document.getElementById('sun-anchor');
    if (anchor && p > DOCK) {
      const t = seg(p, DOCK, 1);
      const rect = anchor.getBoundingClientRect();
      cx = lerp(cx, rect.left + rect.width / 2, t);
      visibleBottom = lerp(visibleBottom, rect.bottom, t);
      clip = r * t; // half-set at full scroll — the footer's half-disc
      rBottom = r * (1 - t);
      horizonBottom = lerp(-(GLOW + 50), clip, t); // halo recedes to the horizon line
    }

    opacity.set(op);
    left.set(cx - r);
    top.set(visibleBottom + clip - size);
    width.set(size);
    height.set(size);
    clipPath.set(`inset(0 0 ${clip}px 0 round ${r}px ${r}px ${rBottom}px ${rBottom}px)`);
    horizonClip.set(`inset(-999px -999px ${horizonBottom}px -999px)`);
  };

  useMotionValueEvent(scrollYProgress, 'change', update);

  useEffect(() => {
    if (reduced) return undefined;
    const sync = () => update(scrollYProgress.get());
    sync();
    window.addEventListener('resize', sync);
    return () => window.removeEventListener('resize', sync);
  }, [reduced]); // eslint-disable-line react-hooks/exhaustive-deps

  if (reduced) return null;

  return (
    <motion.div
      className="celestial"
      aria-hidden="true"
      style={{ left, top, width, height, opacity, clipPath: horizonClip }}
    >
      <motion.div className="celestial-glow glow-moon" style={{ opacity: moonGlow }} />
      <motion.div className="celestial-glow glow-sun" style={{ opacity: sunGlow }} />
      <motion.div className="celestial-disc" style={{ clipPath, backgroundColor }}>
        <motion.div className="celestial-grad" style={{ opacity: gradOpacity }} />
        <motion.div className="celestial-shade" style={{ x: shadeX, opacity: shadeOpacity }} />
      </motion.div>
    </motion.div>
  );
}
