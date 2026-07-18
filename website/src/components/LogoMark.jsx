// The unsnooze mark (same artwork as assets/logo.svg, inlined so it renders
// crisply from every route under the relative base with zero asset requests):
// a crescent moon cradling the terminal prompt, z's drifting away — asleep
// until the prompt wakes.
export default function LogoMark({ size = 22 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 128 128" aria-hidden="true" focusable="false">
      <defs>
        <mask id="lm-cut">
          <rect width="128" height="128" fill="#fff" />
          <circle cx="83" cy="49" r="34" fill="#000" />
        </mask>
      </defs>
      <rect x="1" y="1" width="126" height="126" rx="28" fill="#0d1117" stroke="#30363d" strokeWidth="2" />
      <circle cx="60" cy="68" r="38" mask="url(#lm-cut)" fill="#e6edf3" />
      <path d="M70 40 L88 54 L70 68" fill="none" stroke="#f59e0b" strokeWidth="10"
        strokeLinecap="round" strokeLinejoin="round" />
      <path d="M96 34 h10 l-10 10 h10" fill="none" stroke="#8b949e" strokeWidth="4"
        strokeLinecap="round" strokeLinejoin="round" opacity="0.9" />
      <path d="M110 18 h7 l-7 7 h7" fill="none" stroke="#8b949e" strokeWidth="3"
        strokeLinecap="round" strokeLinejoin="round" opacity="0.55" />
      <circle cx="28" cy="34" r="2" fill="#e6edf3" opacity="0.75" />
      <circle cx="40" cy="22" r="1.4" fill="#e6edf3" opacity="0.5" />
    </svg>
  );
}
