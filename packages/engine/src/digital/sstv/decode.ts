/**
 * SSTV receive. The audio is FM-demodulated to an instantaneous frequency (mixed to
 * baseband at 1700 Hz, filtered, then the phase step between samples). A VIS header is
 * recognised from that: 300 ms of 1900 Hz, a 1200 Hz start bit, eight 30 ms bits at
 * 1100 Hz (1) or 1300 Hz (0) with even parity, and a 1200 Hz stop bit. The leader also
 * gives the tuning error, which is taken off everything after.
 *
 * Luminance and colour difference travel as BT.601 studio-range values (Y 16-235)
 * on the same 1500-2300 Hz scale as everything else, as PySSTV and QSSTV send them.
 *
 * Then the picture: each line's sync pulse is found near where the lines so far say it
 * should be, and a straight-line fit of sync time against line number gives the real line
 * period. A sender's sound card is never exactly on frequency, so that fit is what keeps
 * the picture from slanting. Lines are drawn as they arrive and the whole picture is
 * redrawn with the final fit at the end.
 */
import { durationSec, F_SYNC, hzToLevel, modeByVis, scanLines, VIS_MS, yccToRgb, type SstvMode } from "@zerobeat/core/sstv/modes";

const RATE = 12_000;
const CENTER = 1700;
const MS = RATE / 1000;

export type SstvEvent =
  | { type: "start"; mode: SstvMode; atMs: number; offsetHz: number }
  | { type: "line"; mode: SstvMode; line: number; rgb: Uint8Array }
  | { type: "done"; mode: SstvMode; rgb: Uint8Array; lines: number; complete: boolean; slantPpm: number; atMs: number };

/** Where in a line (ms from the line's start) its sync begins, and where each scan begins. */
function layout(m: SstvMode): { syncAt: number; scans: number[]; scanMs: number[] } {
  switch (m.family) {
    case "martin": {
      const g = m.syncMs + m.porchMs;
      return { syncAt: 0, scans: [g, g + m.scanMs + m.sepMs, g + 2 * (m.scanMs + m.sepMs)], scanMs: [m.scanMs, m.scanMs, m.scanMs] };
    }
    case "scottie": {
      const g = m.sepMs;
      const b = g + m.scanMs + m.sepMs;
      const sync = b + m.scanMs;
      return { syncAt: sync, scans: [g, b, sync + m.syncMs + m.porchMs], scanMs: [m.scanMs, m.scanMs, m.scanMs] };
    }
    case "robot36": {
      const y = m.syncMs + m.porchMs;
      return { syncAt: 0, scans: [y, y + m.scanMs + m.sepMs + 1.5], scanMs: [m.scanMs, m.chromaMs!] };
    }
    case "robot72": {
      const y = m.syncMs + m.porchMs;
      const cr = y + m.scanMs + m.sepMs + 1.5;
      return { syncAt: 0, scans: [y, cr, cr + m.chromaMs! + m.sepMs + 1.5], scanMs: [m.scanMs, m.chromaMs!, m.chromaMs!] };
    }
    case "pd": {
      const y = m.syncMs + m.porchMs;
      return { syncAt: 0, scans: [y, y + m.scanMs, y + 2 * m.scanMs, y + 3 * m.scanMs], scanMs: [m.scanMs, m.scanMs, m.scanMs, m.scanMs] };
    }
  }
}

interface Capture {
  mode: SstvMode;
  /** Sample index (in the receiver's count) where the picture starts, after the VIS. */
  t0: number;
  offsetHz: number;
  atMs: number;
  freq: Float32Array;
  n: number;
  syncs: { line: number; at: number }[];
  /** Fitted sync time of line 0 and line period, in samples. */
  a: number;
  b: number;
  drawn: number;
  missed: number;
  rgb: Uint8Array;
}

export class SstvReceiver {
  // FM demodulator state
  private pr = 1;
  private pi = 0;
  private readonly cw = Math.cos((2 * Math.PI * CENTER) / RATE);
  private readonly sw = Math.sin((2 * Math.PI * CENTER) / RATE);
  private box1: { r: number; i: number }[] = [];
  private box2: { r: number; i: number }[] = [];
  private lastR = 1;
  private lastI = 0;
  private renorm = 0;
  // Recent frequency, for the VIS search: 2 s. And the audio itself, for the leader's tone.
  private readonly hist = new Float32Array(RATE * 2);
  private readonly audio = new Float32Array(RATE * 2);
  private n = 0;
  private t0Ms = 0;
  private cap: Capture | null = null;
  private visCheckAt = 0;
  muted = false;

  constructor(private readonly onEvent: (e: SstvEvent) => void) {}

  get receiving(): { mode: SstvMode; line: number; of: number } | null {
    const c = this.cap;
    return c ? { mode: c.mode, line: c.drawn, of: c.mode.height } : null;
  }

  push(x: Float32Array, firstMs: number): void {
    if (this.n === 0) this.t0Ms = firstMs;
    for (let k = 0; k < x.length; k++) {
      const v = this.muted ? 0 : x[k]!;
      const f = this.demod(v);
      this.hist[this.n % this.hist.length] = f;
      this.audio[this.n % this.audio.length] = v;
      const c = this.cap;
      if (c) {
        const j = this.n - c.t0;
        if (j >= 0 && j < c.freq.length) {
          c.freq[j] = f - c.offsetHz;
          c.n = j + 1;
        }
      }
      this.n++;
      // Every 10 ms of audio, whatever size the chunks come in: the search below looks for
      // the start bit in a 10 ms window, so a coarser cadence would step over it.
      if (!this.cap && this.n - this.visCheckAt >= MS * 10) {
        this.visCheckAt = this.n;
        this.lookForVis();
      }
    }
    if (this.cap) this.advance();
  }

  /** Instantaneous frequency of one sample. */
  private demod(v: number): number {
    const re = v * this.pr;
    const im = -v * this.pi;
    const nr = this.pr * this.cw - this.pi * this.sw;
    this.pi = this.pr * this.sw + this.pi * this.cw;
    this.pr = nr;
    if (++this.renorm === 4096) {
      this.renorm = 0;
      const g = 1 / Math.hypot(this.pr, this.pi);
      this.pr *= g;
      this.pi *= g;
    }
    // Two short boxcars (4 and 3 samples): pass ±650 Hz, reject the 3.4 kHz image.
    this.box1.push({ r: re, i: im });
    if (this.box1.length > 4) this.box1.shift();
    let r1 = 0;
    let i1 = 0;
    for (const s of this.box1) {
      r1 += s.r;
      i1 += s.i;
    }
    this.box2.push({ r: r1, i: i1 });
    if (this.box2.length > 3) this.box2.shift();
    let r = 0;
    let i = 0;
    for (const s of this.box2) {
      r += s.r;
      i += s.i;
    }
    const dr = r * this.lastR + i * this.lastI;
    const di = i * this.lastR - r * this.lastI;
    this.lastR = r;
    this.lastI = i;
    return CENTER + (Math.atan2(di, dr) * RATE) / (2 * Math.PI);
  }

  /** Power of one tone in the audio over [from, from + len). */
  private toneAt(from: number, len: number, hz: number): number {
    const A = this.audio.length;
    const w = (2 * Math.PI * hz) / RATE;
    let re = 0;
    let im = 0;
    for (let j = 0; j < len; j++) {
      const v = this.audio[(from + j) % A]!;
      re += v * Math.cos(w * j);
      im -= v * Math.sin(w * j);
    }
    return re * re + im * im;
  }

  /** The strongest tone in the audio between lo and hi Hz over [from, from + len). */
  private toneHz(from: number, len: number, lo: number, hi: number): number {
    const power = (hz: number) => this.toneAt(from, len, hz);
    let best = lo;
    let bp = -1;
    for (let hz = lo; hz <= hi; hz += 4) {
      const pw = power(hz);
      if (pw > bp) [bp, best] = [pw, hz];
    }
    const coarse = best;
    for (let hz = coarse - 4; hz <= coarse + 4; hz += 0.5) {
      const pw = power(hz);
      if (pw > bp) [bp, best] = [pw, hz];
    }
    return best;
  }

  /** Plain mean frequency over [from, from + len): cheap, for screening. */
  private quick(from: number, len: number): number {
    const H = this.hist.length;
    let s = 0;
    let k = 0;
    for (let j = Math.max(from, this.n - H + 1); j < from + len && j < this.n; j++) {
      s += this.hist[j % H]!;
      k++;
    }
    return k ? s / k : NaN;
  }

  /**
   * Frequency over [from, from + len) samples of history (absolute indices): the mean of
   * the middle 60 %, so the clicks a weak FM signal makes do not drag it.
   */
  private mean(from: number, len: number): number {
    const H = this.hist.length;
    const v: number[] = [];
    for (let j = Math.max(from, this.n - H + 1); j < from + len && j < this.n; j++) v.push(this.hist[j % H]!);
    if (!v.length) return NaN;
    v.sort((x, y) => x - y);
    const lo = Math.floor(v.length * 0.2);
    const hi = Math.max(lo + 1, Math.ceil(v.length * 0.8));
    let s = 0;
    for (let i = lo; i < hi; i++) s += v[i]!;
    return s / (hi - lo);
  }

  /**
   * Is there a whole VIS header ending now? Its stop bit ends 300 ms after the start
   * bit begins; look for the start bit's edge where it must be, then read the bits.
   */
  private lookForVis(): void {
    const now = this.n;
    const visBits = 300 * MS; // start bit + 8 bits + stop bit
    // The leader→start-bit edge is between 300 and 310 ms ago (we check every 10 ms).
    const lo = now - visBits - 10 * MS;
    const hi = now - visBits;
    if (lo - 300 * MS < this.n - this.hist.length) return;
    // A 200 ms leader before the edge region (screened cheaply first: this runs every 10 ms).
    if (!(Math.abs(this.quick(lo - 210 * MS, 200 * MS) - 1900) < 150)) return;
    if (!(this.quick(hi + 20 * MS, 260 * MS) < 1500)) return; // the bits are all below 1350 Hz
    if (!(Math.abs(this.mean(lo - 210 * MS, 200 * MS) - 1900) < 150)) return;
    // The leader's real frequency, from the audio: the demodulator's mean is pulled toward
    // its 1700 Hz centre by noise clicks (130 Hz on a weak signal off the air), which put
    // every bit outside its tolerance.
    const lead = this.toneHz(lo - 210 * MS, 200 * MS, 1700, 2100);
    if (!(Math.abs(lead - 1900) < 120)) return;
    const off = lead - 1900;
    // Find the edge: the first sample after which 20 ms average below 1550 Hz.
    let edge = -1;
    for (let t = lo - 5 * MS; t <= hi + 5 * MS; t += 6) {
      if (this.quick(t, 10 * MS) - off < 1550 && this.quick(t - 15 * MS, 10 * MS) - off > 1700) {
        edge = t;
        break;
      }
    }
    if (edge < 0) return;
    // Refine to the sample.
    for (let t = edge - 12 * MS; t < edge + 12 * MS; t++) {
      if (this.quick(t, 3 * MS) - off < 1550) {
        edge = t;
        break;
      }
    }
    // Each bit by its tones in the audio, as an FSK modem decides (the demodulated
    // frequency of a weak signal is too noisy over 20 ms): 1100 Hz is 1, 1300 Hz is 0, and
    // the start and stop bits are 1200 Hz.
    const tones = (k: number) => {
      const at = edge + (30 * k + 5) * MS;
      return { f1100: this.toneAt(at, 20 * MS, 1100 + off), f1200: this.toneAt(at, 20 * MS, F_SYNC + off), f1300: this.toneAt(at, 20 * MS, 1300 + off), f1900: this.toneAt(at, 20 * MS, 1900 + off) };
    };
    const frame = (k: number) => {
      const t = tones(k);
      return t.f1200 > t.f1900 && t.f1200 > 0.5 * Math.max(t.f1100, t.f1300);
    };
    if (!frame(0) || !frame(9)) return;
    let code = 0;
    let ones = 0;
    for (let k = 1; k <= 8; k++) {
      const t = tones(k);
      const one = t.f1100 > t.f1300;
      // A bit must be clearly one tone or the other.
      if (Math.max(t.f1100, t.f1300) < 2 * Math.min(t.f1100, t.f1300)) return;
      if (one) ones++;
      if (k <= 7 && one) code |= 1 << (k - 1);
    }
    if (ones % 2 !== 0) return; // even parity over the 7 bits and the parity bit
    const mode = modeByVis(code);
    if (!mode) return;
    const t0 = edge + 300 * MS;
    const atMs = this.t0Ms + ((edge - 610 * MS) / RATE) * 1000;
    const total = Math.ceil(durationSec(mode) * RATE * 1.02) - VIS_MS * MS + RATE;
    this.cap = {
      mode,
      t0,
      offsetHz: off,
      atMs,
      freq: new Float32Array(total),
      n: 0,
      syncs: [],
      a: (mode.family === "scottie" ? mode.syncMs * MS : 0) + layout(mode).syncAt * MS,
      b: mode.lineMs * MS,
      drawn: 0,
      missed: 0,
      rgb: new Uint8Array(mode.width * mode.height * 3),
    };
    // The samples after the edge are already in history: copy them into the capture.
    for (let j = t0; j < this.n; j++) {
      this.cap.freq[j - t0] = this.hist[j % this.hist.length]! - off;
      this.cap.n = j - t0 + 1;
    }
    this.onEvent({ type: "start", mode, atMs, offsetHz: Math.round(off) });
  }

  /** Find syncs for lines whose audio has arrived, draw them, finish at the end. */
  private advance(): void {
    const c = this.cap!;
    const m = c.mode;
    const L = scanLines(m);
    const lay = layout(m);
    const syncLen = Math.round(m.syncMs * MS);
    for (;;) {
      const line = c.syncs.length ? c.syncs.at(-1)!.line + 1 + c.missed : c.missed;
      if (line >= L) return this.finish(true);
      const expect = c.a + c.b * line;
      const lineEnd = expect - lay.syncAt * MS + m.lineMs * MS;
      if (lineEnd + 20 * MS > c.n) {
        if (c.n >= c.freq.length) return this.finish(false);
        return;
      }
      // Search ±3 % of a line (more at the start, when the fit knows little).
      const win = Math.round(c.syncs.length < 4 ? 0.06 * c.b : 0.03 * c.b);
      const found = this.findSync(c, Math.round(expect - win), Math.round(expect + win), syncLen);
      if (found !== null) {
        c.syncs.push({ line, at: found });
        c.missed = 0;
        this.fit(c);
      } else {
        c.missed++;
        if (c.missed > 20) return this.finish(false);
        c.syncs.push({ line, at: NaN });
        c.missed = 0;
      }
      this.drawThrough(c, line);
    }
  }

  /** Best start of a sync pulse in [from, to]: where the most samples are near 1200 Hz. */
  private findSync(c: Capture, from: number, to: number, len: number): number | null {
    const f = c.freq;
    const lo = Math.max(0, from);
    const hi = Math.min(c.n - len - 1, to);
    if (hi < lo) return null;
    const isSync = (j: number) => (f[j]! < 1350 ? 1 : 0);
    let run = 0;
    for (let j = lo; j < lo + len; j++) run += isSync(j);
    let best = run;
    let at = lo;
    for (let j = lo + 1; j <= hi; j++) {
      run += isSync(j + len - 1) - isSync(j - 1);
      if (run > best) {
        best = run;
        at = j;
      }
    }
    return best >= len * 0.6 ? at : null;
  }

  /** Least squares of sync time against line, ignoring outliers. */
  private fit(c: Capture): void {
    let pts = c.syncs.filter((s) => Number.isFinite(s.at));
    for (let pass = 0; pass < 2 && pts.length >= 3; pass++) {
      const n = pts.length;
      let sx = 0;
      let sy = 0;
      let sxx = 0;
      let sxy = 0;
      for (const p of pts) {
        sx += p.line;
        sy += p.at;
        sxx += p.line * p.line;
        sxy += p.line * p.at;
      }
      const d = n * sxx - sx * sx;
      if (d === 0) break;
      const b = (n * sxy - sx * sy) / d;
      const a = (sy - b * sx) / n;
      // Keep the period within 1 % of the mode's: anything else is a bad fit.
      if (Math.abs(b / (c.mode.lineMs * MS) - 1) < 0.01) {
        c.a = a;
        c.b = b;
      }
      const tol = 2 * MS;
      pts = pts.filter((p) => Math.abs(p.at - (c.a + c.b * p.line)) < tol);
    }
    if (pts.length < 3 && pts.length > 0) {
      // Early on: anchor on the last sync with the nominal period.
      const p = pts.at(-1)!;
      c.a = p.at - c.b * p.line;
    }
  }

  private level(c: Capture, startSample: number, durMs: number, px: number, count: number): number {
    const s = startSample + ((durMs * MS) / count) * px;
    const e = s + (durMs * MS) / count;
    let sum = 0;
    let k = 0;
    for (let j = Math.floor(s); j < Math.ceil(e); j++) {
      if (j < 0 || j >= c.n) continue;
      sum += c.freq[j]!;
      k++;
    }
    return k ? hzToLevel(sum / k) : 0;
  }

  /** Draw one scan line (PD: a line pair; Robot 36: a pair once both halves are in). */
  private drawLine(c: Capture, line: number): void {
    const m = c.mode;
    const lay = layout(m);
    const W = m.width;
    const start = c.a + c.b * line - lay.syncAt * MS;
    const put = (y: number, x: number, rgb: [number, number, number]) => {
      const i = (y * W + x) * 3;
      c.rgb[i] = rgb[0];
      c.rgb[i + 1] = rgb[1];
      c.rgb[i + 2] = rgb[2];
    };
    const ch = (k: number, x: number, s = start) => this.level(c, s + lay.scans[k]! * MS, lay.scanMs[k]!, x, W);
    for (let x = 0; x < W; x++) {
      switch (m.family) {
        case "martin":
        case "scottie":
          put(line, x, [Math.round(ch(2, x)), Math.round(ch(0, x)), Math.round(ch(1, x))]);
          break;
        case "robot72": {
          const yv = ch(0, x);
          put(line, x, yccToRgb(yv, ch(1, x), ch(2, x)));
          break;
        }
        case "robot36": {
          if (line % 2 === 0) break; // drawn with its odd partner
          const prev = c.a + c.b * (line - 1) - lay.syncAt * MS;
          const cr = ch(1, x, prev);
          const cb = ch(1, x);
          put(line - 1, x, yccToRgb(ch(0, x, prev), cr, cb));
          put(line, x, yccToRgb(ch(0, x), cr, cb));
          break;
        }
        case "pd": {
          const cr = ch(1, x);
          const cb = ch(2, x);
          put(line * 2, x, yccToRgb(ch(0, x), cr, cb));
          put(line * 2 + 1, x, yccToRgb(ch(3, x), cr, cb));
          break;
        }
      }
    }
  }

  private drawThrough(c: Capture, line: number): void {
    for (let l = c.drawn; l <= line; l++) this.drawLine(c, l);
    c.drawn = line + 1;
    const rows = c.mode.family === "pd" ? c.drawn * 2 : c.drawn;
    this.onEvent({ type: "line", mode: c.mode, line: Math.min(rows, c.mode.height), rgb: c.rgb });
  }

  private finish(complete: boolean): void {
    const c = this.cap!;
    this.cap = null;
    const L = scanLines(c.mode);
    const lines = Math.min(L, c.drawn);
    // Redraw everything with the final fit: this is the slant correction.
    for (let l = 0; l < lines; l++) this.drawLine(c, l);
    const slantPpm = Math.round((c.b / (c.mode.lineMs * MS) - 1) * 1e6);
    if (lines >= L / 8) this.onEvent({ type: "done", mode: c.mode, rgb: c.rgb, lines: c.mode.family === "pd" ? lines * 2 : lines, complete, slantPpm, atMs: c.atMs });
    this.visCheckAt = this.n;
  }

  reset(): void {
    this.cap = null;
  }
}
