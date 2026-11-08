/**
 * SSTV transmit: the VIS header, then every line as tones, played as one
 * continuous-phase FM signal. Timing is kept in fractional samples, so a long picture
 * ends exactly when its mode says it should (a receiver measures slant from that).
 */
import { F_BLACK, F_LEADER, F_SYNC, F_VIS_0, F_VIS_1, levelToHz, rgbToYcc, scanLines, type SstvMode } from "@zerobeat/core/sstv/modes";

/** One tone: frequency and duration in ms. */
type Seg = [hz: number, ms: number];

/** The VIS header for a mode: 7 code bits LSB first and an even-parity bit. */
export function visSegments(vis: number): Seg[] {
  const out: Seg[] = [[F_LEADER, 300], [F_SYNC, 10], [F_LEADER, 300], [F_SYNC, 30]];
  let ones = 0;
  for (let b = 0; b < 7; b++) {
    const bit = (vis >> b) & 1;
    ones += bit;
    out.push([bit ? F_VIS_1 : F_VIS_0, 30]);
  }
  out.push([ones % 2 ? F_VIS_1 : F_VIS_0, 30]);
  out.push([F_SYNC, 30]);
  return out;
}

/** A scan of pixel values across `ms`. */
function scan(levels: ArrayLike<number>, ms: number, out: Seg[]): void {
  const d = ms / levels.length;
  for (let i = 0; i < levels.length; i++) out.push([levelToHz(levels[i]!), d]);
}

/**
 * The tones of a picture. `rgb` is width × height × 3 bytes, row by row, already the
 * mode's size.
 */
export function pictureSegments(m: SstvMode, rgb: Uint8Array): Seg[] {
  const { width: W, height: H } = m;
  if (rgb.length !== W * H * 3) throw new Error(`${m.name} needs a ${W}x${H} picture`);
  const out: Seg[] = visSegments(m.vis);
  const ch = (y: number, c: number) => {
    const row = new Uint8Array(W);
    for (let x = 0; x < W; x++) row[x] = rgb[(y * W + x) * 3 + c]!;
    return row;
  };
  const ycc = (y: number) => {
    const Y = new Float32Array(W);
    const Cr = new Float32Array(W);
    const Cb = new Float32Array(W);
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      [Y[x], Cr[x], Cb[x]] = rgbToYcc(rgb[i]!, rgb[i + 1]!, rgb[i + 2]!);
    }
    return { Y, Cr, Cb };
  };
  if (m.family === "scottie") out.push([F_SYNC, m.syncMs]); // Scottie's starting sync
  for (let line = 0; line < scanLines(m); line++) {
    switch (m.family) {
      case "martin":
        out.push([F_SYNC, m.syncMs], [F_BLACK, m.porchMs]);
        for (const c of [1, 2, 0]) {
          scan(ch(line, c), m.scanMs, out);
          out.push([F_BLACK, m.sepMs]);
        }
        break;
      case "scottie":
        out.push([F_BLACK, m.sepMs]);
        scan(ch(line, 1), m.scanMs, out);
        out.push([F_BLACK, m.sepMs]);
        scan(ch(line, 2), m.scanMs, out);
        out.push([F_SYNC, m.syncMs], [F_BLACK, m.porchMs]);
        scan(ch(line, 0), m.scanMs, out);
        break;
      case "robot36": {
        const { Y, Cr, Cb } = ycc(line);
        out.push([F_SYNC, m.syncMs], [F_BLACK, m.porchMs]);
        scan(Y, m.scanMs, out);
        // Even lines carry R-Y (separator at black), odd lines B-Y (separator at white).
        const even = line % 2 === 0;
        out.push([even ? F_BLACK : 2300, m.sepMs], [F_LEADER, 1.5]);
        // The chroma is the average of this line and the next one of the pair.
        const other = ycc(Math.min(H - 1, even ? line + 1 : line - 1));
        const c = even ? Cr : Cb;
        const o = even ? other.Cr : other.Cb;
        scan(c.map((v, i) => (v + o[i]!) / 2), m.chromaMs!, out);
        break;
      }
      case "robot72": {
        const { Y, Cr, Cb } = ycc(line);
        out.push([F_SYNC, m.syncMs], [F_BLACK, m.porchMs]);
        scan(Y, m.scanMs, out);
        out.push([F_BLACK, m.sepMs], [F_LEADER, 1.5]);
        scan(Cr, m.chromaMs!, out);
        out.push([2300, m.sepMs], [F_LEADER, 1.5]);
        scan(Cb, m.chromaMs!, out);
        break;
      }
      case "pd": {
        const a = ycc(line * 2);
        const b = ycc(line * 2 + 1);
        out.push([F_SYNC, m.syncMs], [F_BLACK, m.porchMs]);
        scan(a.Y, m.scanMs, out);
        scan(a.Cr.map((v, i) => (v + b.Cr[i]!) / 2), m.scanMs, out);
        scan(a.Cb.map((v, i) => (v + b.Cb[i]!) / 2), m.scanMs, out);
        scan(b.Y, m.scanMs, out);
        break;
      }
    }
  }
  return out;
}

/** `offsetHz` shifts every tone (a mistuned sender), for tests. */
export function sstvWaveform(m: SstvMode, rgb: Uint8Array, sampleRate: number, offsetHz = 0): Float32Array {
  const segs = pictureSegments(m, rgb);
  const totalMs = segs.reduce((a, [, ms]) => a + ms, 0);
  const n = Math.ceil((totalMs / 1000) * sampleRate) + Math.round(0.05 * sampleRate);
  const out = new Float32Array(n);
  let phi = 0;
  let t = 0; // ms at the end of the current segment
  let k = 0;
  let segEnd = 0;
  for (let i = 0; i < n; i++) {
    const ms = (i / sampleRate) * 1000;
    while (k < segs.length && ms >= segEnd) {
      t = segEnd;
      segEnd = t + segs[k]![1];
      k++;
    }
    const f = k <= segs.length && ms < segEnd ? segs[k - 1]![0] : 0;
    if (!f) break;
    phi += (2 * Math.PI * (f + offsetHz)) / sampleRate;
    if (phi > 2 * Math.PI) phi -= 2 * Math.PI;
    out[i] = Math.sin(phi);
  }
  // 5 ms fades so the start and end do not click.
  const e = Math.round(0.005 * sampleRate);
  for (let i = 0; i < e; i++) {
    const g = i / e;
    out[i]! *= g;
  }
  let last = out.length - 1;
  while (last > 0 && out[last] === 0) last--;
  for (let i = 0; i < e && last - i >= 0; i++) out[last - i]! *= i / e;
  return out.subarray(0, last + 1);
}
