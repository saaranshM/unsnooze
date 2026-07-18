// Deterministic star field — same sky on every visit (and on the server;
// fixed-precision strings so serialized styles hydrate cleanly). Each star
// gets its own phase AND period so the twinkle never looks synchronized;
// roughly one in six is a "bright" star that glints with a soft glow.
const STARS = Array.from({ length: 42 }, (_, i) => {
  const rand = (n) => {
    const x = Math.sin(i * 127.1 + n * 311.7) * 43758.5453;
    return x - Math.floor(x);
  };
  return {
    top: `${(rand(1) * 92).toFixed(2)}%`,
    left: `${(rand(2) * 98).toFixed(2)}%`,
    size: rand(3) > 0.75 ? '2px' : '1.4px',
    delay: `${(rand(4) * 6).toFixed(2)}s`,
    dur: `${(3.5 + rand(5) * 3.5).toFixed(2)}s`,
    bright: rand(6) > 0.84,
  };
});

export default function Stars() {
  return STARS.map((s, i) => (
    <span
      key={i}
      className={s.bright ? 'bright' : undefined}
      style={{
        top: s.top, left: s.left,
        width: s.size, height: s.size,
        animationDelay: s.delay,
        animationDuration: s.dur,
      }}
    />
  ));
}
