/**
 * The Zerobeat mark: a beat note tuned to zero.
 *
 * Two tones a little apart beat against each other: the sum swells and fades at the
 * difference frequency. Tune one onto the other and the beat slows until it stops, which
 * is zero beat, dead on frequency. Here the beat runs in from both sides, its swell
 * shrinking as it nears the middle, and inside the ring (the zero) it lies flat.
 */
export const RING = { cx: 32, cy: 32, r: 13 };

/** The beat waveform across the tile on a 64-unit square: full swing at the edges, flat in the ring. */
export function markGeometry() {
  const pts: string[] = [];
  for (let x = 4; x <= 60.001; x += 0.25) {
    const off = Math.abs(x - 32);
    const swell = Math.min(1, Math.max(0, (off - 11) / 17)) ** 1.3;
    const y = 32 - 9 * swell * Math.sin((2 * Math.PI * (x - 32)) / 4);
    pts.push(`${x.toFixed(1)} ${y.toFixed(2)}`);
  }
  return { ring: RING, wave: `M${pts.join(" L")}` };
}

export function LogoMark({ size = 28, tile = true, className }: { size?: number; tile?: boolean; className?: string }) {
  const { ring, wave } = markGeometry();
  const uid = "zbm";
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} className={className} role="img" aria-label="Zerobeat">
      <defs>
        <linearGradient id={`${uid}-tile`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#1b2029" />
          <stop offset="1" stopColor="#0c0f14" />
        </linearGradient>
        <linearGradient id={`${uid}-hot`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ff9a5c" />
          <stop offset="1" stopColor="#ef5a22" />
        </linearGradient>
      </defs>
      {tile && (
        <>
          <rect width="64" height="64" rx="14" fill={`url(#${uid}-tile)`} />
          <rect x="0.5" y="0.5" width="63" height="63" rx="13.5" fill="none" stroke="#ffffff" strokeOpacity="0.06" />
        </>
      )}
      <path d={wave} fill="none" stroke="#6b7487" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={ring.cx} cy={ring.cy} r={ring.r} fill="none" stroke={`url(#${uid}-hot)`} strokeWidth="5" />
    </svg>
  );
}

/** The product name, drawn as a two-tone wordmark. */
export const PRODUCT = "Zerobeat";

export function Name({ className }: { className?: string }) {
  return (
    <span className={`whitespace-nowrap ${className ?? ""}`} aria-label={PRODUCT}>
      <span className="font-medium text-muted">Zero</span>
      <span className="font-semibold text-fg">beat</span>
    </span>
  );
}

export function Wordmark({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className ?? ""}`}>
      <LogoMark size={size} />
      <Name className="text-[15px] leading-none tracking-tight" />
    </span>
  );
}
