/**
 * Shared pieces of the keyboard modes (RTTY, PSK31, CW): a channel that mixes 12 kHz
 * audio down to baseband and decimates it, a scanner that finds signals across the
 * passband from an averaged spectrum, and the text stream each channel writes into.
 *
 * Every keyboard mode listens on the operator's frequency and, like fldigi's signal
 * browser, on up to MAX_CHANNELS other signals it finds on the band.
 */
import { fft } from "../../dsp/dsp.ts";

export const RATE = 12_000;

/** A received or sent run of text, as the Operate page shows it. */
export interface KeyLine {
  id: string;
  dir: "rx" | "tx";
  startMs: number;
  updatedMs: number;
  freqHz: number;
  snr: number | null;
  text: string;
  complete: boolean;
  atRx: boolean;
}

/** What every keyboard mode's receiver looks like to the desk. */
export interface KeyReceiver {
  rxHz: number;
  muted: boolean;
  push(samples: Float32Array, firstSampleMs: number): void;
  reset(): void;
}

/**
 * Complex baseband of one signal: x(n)·e^{-i2πfn/fs}, averaged over `box` samples
 * (a matched filter for a rectangular symbol or bit) and kept every `decim` samples.
 */
export class Baseband {
  private pr = 1;
  private pi = 0;
  private cw = 1;
  private sw = 0;
  private readonly rr: Float32Array;
  private readonly ri: Float32Array;
  private pos = 0;
  private sr = 0;
  private si = 0;
  private count = 0;
  private renorm = 0;
  freqHz = 0;

  constructor(
    freqHz: number,
    private readonly decim: number,
    private readonly box: number,
  ) {
    this.rr = new Float32Array(box);
    this.ri = new Float32Array(box);
    this.setFreq(freqHz);
  }

  setFreq(f: number): void {
    this.freqHz = f;
    const w = (2 * Math.PI * f) / RATE;
    this.cw = Math.cos(w);
    this.sw = Math.sin(w);
  }

  /** Feed samples; calls out(re, im) for each decimated output. */
  push(x: Float32Array, out: (re: number, im: number) => void): void {
    const { rr, ri, box, decim } = this;
    let { pr, pi, sr, si, pos, count } = this;
    const cw = this.cw;
    const sw = this.sw;
    for (let n = 0; n < x.length; n++) {
      const v = x[n]!;
      const re = v * pr;
      const im = -v * pi;
      sr += re - rr[pos]!;
      si += im - ri[pos]!;
      rr[pos] = re;
      ri[pos] = im;
      if (++pos === box) pos = 0;
      const nr = pr * cw - pi * sw;
      pi = pr * sw + pi * cw;
      pr = nr;
      if (++this.renorm === 1024) {
        this.renorm = 0;
        const g = 1 / Math.hypot(pr, pi);
        pr *= g;
        pi *= g;
        // Re-sum now and then so rounding in the running sum cannot drift.
        sr = 0;
        si = 0;
        for (let k = 0; k < box; k++) {
          sr += rr[k]!;
          si += ri[k]!;
        }
      }
      if (++count === decim) {
        count = 0;
        out(sr / box, si / box);
      }
    }
    this.pr = pr;
    this.pi = pi;
    this.sr = sr;
    this.si = si;
    this.pos = pos;
    this.count = count;
  }
}

/** A leaky average that rises and falls at different rates (fldigi's decayavg). */
export const decay = (avg: number, v: number, n: number) => avg + (v - avg) / n;

/**
 * Text from one channel, broken into lines at a newline or after `gapMs` without a
 * character, so the page shows readable rows rather than one endless string.
 */
export class TextStream {
  private line: KeyLine | null = null;
  private seq = 0;

  constructor(
    private readonly prefix: string,
    private readonly emit: (l: KeyLine) => void,
    private readonly gapMs = 4_000,
  ) {}

  put(ch: string, atMs: number, freqHz: number, snr: number | null, atRx: boolean): void {
    if (this.line && atMs - this.line.updatedMs > this.gapMs) this.close();
    if (ch === "\r") return;
    if (ch === "\n") {
      if (this.line) this.close();
      return;
    }
    if (!this.line) {
      if (ch === " ") return; // no line starts with a space
      this.line = { id: `${this.prefix}-${++this.seq}`, dir: "rx", startMs: atMs, updatedMs: atMs, freqHz: Math.round(freqHz), snr, text: "", complete: false, atRx };
    }
    const l = this.line;
    l.text = (l.text + ch).slice(-240);
    l.updatedMs = atMs;
    l.freqHz = Math.round(freqHz);
    l.snr = snr;
    l.atRx = atRx;
    if (l.text.length >= 200) this.close();
    // A lone character at a signal edge is usually noise: show a line from its second.
    else if (l.text.replace(/ /g, "").length >= 2) this.emit({ ...l });
  }

  /** End the current line (silence, or the signal went away). */
  close(): void {
    const l = this.line;
    if (!l) return;
    this.line = null;
    if (l.text.replace(/ /g, "").length >= 2) this.emit({ ...l, text: l.text.trimEnd(), complete: true });
  }

  get open(): KeyLine | null {
    return this.line;
  }
}

/** The channels a mode keeps: signals found on the band plus the operator's frequency. */
export const MAX_CHANNELS = 16;

export interface FoundSignal {
  freqHz: number;
  snrDb: number;
}

/**
 * Finds signals in an averaged power spectrum (4096-point FFT, 2.9 Hz bins, every quarter
 * second). `shape` picks what a signal looks like: one peak of about `widthHz`, or two
 * peaks `pairHz` apart (RTTY's mark and space).
 */
export class SignalScanner {
  static readonly N = 4096;
  private readonly win = new Float32Array(SignalScanner.N);
  private readonly buf = new Float32Array(SignalScanner.N);
  private fill = 0;
  private since = 0;
  private avg: Float32Array | null = null;
  private scans = 0;
  readonly binHz = RATE / SignalScanner.N;

  constructor(
    private readonly shape: { widthHz: number; pairHz?: number; minSnrDb: number; minHz: number; maxHz: number; /** Signals closer than this are one signal (its keying sidebands). */ minSepHz?: number;
      /**
       * Pairs only: each tone must stand this far (dB) above its shoulders 25-45 Hz either
       * side. An FSK tone is narrow; FT4 and FT8 signals are flat blocks 50-83 Hz wide, so
       * two of them 170 Hz apart (all over 14.080) do not look like RTTY.
       */
      narrowDb?: number;
    },
    private readonly onScan: (found: FoundSignal[]) => void,
    private readonly hop = 3_000,
  ) {
    for (let i = 0; i < SignalScanner.N; i++) this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (SignalScanner.N - 1));
  }

  push(x: Float32Array): void {
    const N = SignalScanner.N;
    for (let i = 0; i < x.length; i++) {
      this.buf[this.fill++ % N] = x[i]!;
      if (++this.since >= this.hop && this.fill >= N) {
        this.since = 0;
        this.scan();
      }
    }
    if (this.fill > N * 8) this.fill = N + (this.fill % N);
  }

  /**
   * Noise near a frequency, as the mean power of a complex baseband sample averaged over
   * `box` audio samples (what Baseband produces): the 30th-percentile spectrum bin within
   * ±300 Hz, scaled by the Hann window's energy (0.375 N) and the averaging. Null until
   * the spectrum has settled.
   */
  noiseAt(hz: number, box: number): number | null {
    const avg = this.avg;
    if (!avg || this.scans < 8) return null;
    const c = Math.round(hz / this.binHz);
    const w = Math.round(300 / this.binHz);
    const v: number[] = [];
    for (let k = Math.max(1, c - w); k <= Math.min(avg.length - 1, c + w); k++) v.push(avg[k]!);
    v.sort((a, b) => a - b);
    const bin = v[Math.floor(v.length * 0.3)] ?? 0;
    // The spectrum is averaged, so its noise bins are no longer exponential: their 30th
    // percentile is 0.67 of the mean (measured on white noise; one FFT alone would be 0.36).
    return bin / 0.67 / (0.375 * SignalScanner.N) / box;
  }

  private scan(): void {
    const N = SignalScanner.N;
    const re = new Float32Array(N);
    const im = new Float32Array(N);
    const start = this.fill % N;
    for (let i = 0; i < N; i++) re[i] = this.buf[(start + i) % N]! * this.win[i]!;
    fft(re, im);
    const half = N / 2;
    if (!this.avg) this.avg = new Float32Array(half);
    const avg = this.avg;
    for (let k = 0; k < half; k++) {
      const p = re[k]! * re[k]! + im[k]! * im[k]!;
      avg[k] = avg[k]! === 0 ? p : avg[k]! + (p - avg[k]!) * 0.25;
    }
    // Report nothing until the average has settled (about two seconds): one FFT of
    // noise has peaks that look like signals.
    if (++this.scans < 8) return;
    const { widthHz, pairHz, minSnrDb, minHz, maxHz } = this.shape;
    const b0 = Math.ceil(minHz / this.binHz);
    const b1 = Math.min(half - 2, Math.floor(maxHz / this.binHz));
    // Noise: the 30th percentile of the band, as the waterfall does.
    const sample: number[] = [];
    for (let k = b0; k <= b1; k += 2) sample.push(avg[k]!);
    sample.sort((a, b) => a - b);
    const noise = sample[Math.floor(sample.length * 0.3)] ?? 1e-12;
    // Signal power over the signal's own width, against the noise in that width.
    const w = Math.max(1, Math.round(widthHz / this.binHz / 2));
    const level = (k: number) => {
      let s = 0;
      for (let j = -w; j <= w; j++) s += avg[k + j] ?? 0;
      return s / (2 * w + 1);
    };
    // The louder shoulder of a tone, 25-45 Hz either side, against the tone itself.
    const s0 = Math.round(25 / this.binHz);
    const s1 = Math.round(45 / this.binHz);
    const shoulder = (k: number, dir: number) => {
      let s = 0;
      for (let j = s0; j <= s1; j++) s += avg[k + dir * j] ?? 0;
      return s / (s1 - s0 + 1);
    };
    const narrow = (k: number, tone: number) => 10 * Math.log10((tone - noise) / Math.max(1e-30, Math.max(shoulder(k, -1), shoulder(k, 1)) - noise * 0.999)) >= this.shape.narrowDb!;
    const found: FoundSignal[] = [];
    const sep = Math.round(Math.max(this.shape.minSepHz ?? 0, pairHz ? pairHz + widthHz * 2 : widthHz * 2) / this.binHz);
    const pairBins = pairHz ? Math.round(pairHz / 2 / this.binHz) : 0;
    const cands: { k: number; snr: number }[] = [];
    for (let k = b0 + w + pairBins; k <= b1 - w - pairBins; k++) {
      let snr: number;
      if (pairHz) {
        const lo = level(k - pairBins);
        const hi = level(k + pairBins);
        snr = 10 * Math.log10(Math.min(lo, hi) / noise);
        if (snr >= minSnrDb && this.shape.narrowDb !== undefined && (!narrow(k - pairBins, lo) || !narrow(k + pairBins, hi))) continue;
      } else snr = 10 * Math.log10(level(k) / noise);
      if (snr >= minSnrDb) cands.push({ k, snr });
    }
    cands.sort((a, b) => b.snr - a.snr);
    for (const c of cands) {
      if (found.length >= MAX_CHANNELS) break;
      if (found.some((f) => Math.abs(f.freqHz / this.binHz - c.k) < sep)) continue;
      found.push({ freqHz: c.k * this.binHz, snrDb: Math.round(c.snr) });
    }
    this.onScan(found);
  }
}

/**
 * The set of demodulators a mode runs: one pinned to the operator's frequency, and one
 * for each signal the scanner keeps finding, dropped after `idleMs` without it.
 */
export class ChannelSet<D extends { freqHz: number; feed(x: Float32Array, atMs: number): void; close(): void; retune?(hz: number): void }> {
  private chans = new Map<number, { d: D; seenAt: number; snr: number }>();
  /** The last few seconds of audio, replayed into a new channel so it does not miss the start. */
  private history: { x: Float32Array; at: number }[] = [];
  private historySamples = 0;
  private rx: D | null = null;
  private rxAt = NaN;

  constructor(
    private readonly make: (freqHz: number, isRx: boolean) => D,
    private readonly mergeHz: number,
    private readonly idleMs = 20_000,
    /** Move the operator's channel onto a signal found this close to it (0: never). */
    private readonly snapHz = 0,
  ) {}

  setRx(hz: number): void {
    if (this.rx && Math.abs(this.rxAt - hz) < 1) return;
    this.rx?.close();
    this.rx = this.make(hz, true);
    this.rxAt = hz;
    // A band channel on the same signal would print everything twice.
    for (const [k, c] of this.chans) {
      if (Math.abs(c.d.freqHz - hz) < this.mergeHz) {
        c.d.close();
        this.chans.delete(k);
      }
    }
  }

  found(sigs: FoundSignal[], nowMs: number): void {
    if (this.snapHz && this.rx?.retune) {
      let best: FoundSignal | null = null;
      for (const s of sigs) if (Math.abs(s.freqHz - this.rxAt) <= this.snapHz && (!best || s.snrDb > best.snrDb)) best = s;
      // Only when it is further off than AFC pulls in by itself.
      if (best && Math.abs(best.freqHz - this.rx.freqHz) > 6) this.rx.retune(best.freqHz);
    }
    const rxHz = this.rx?.freqHz ?? this.rxAt;
    for (const s of sigs) {
      if (Math.abs(s.freqHz - rxHz) < Math.max(this.mergeHz, this.snapHz) || Math.abs(s.freqHz - this.rxAt) < Math.max(this.mergeHz, this.snapHz)) continue;
      let hit: { d: D; seenAt: number; snr: number } | null = null;
      for (const c of this.chans.values()) if (Math.abs(c.d.freqHz - s.freqHz) < this.mergeHz) hit = c;
      if (hit) {
        hit.seenAt = nowMs;
        hit.snr = s.snrDb;
      } else if (this.chans.size < MAX_CHANNELS) {
        const d = this.make(s.freqHz, false);
        for (const h of this.history) d.feed(h.x, h.at);
        this.chans.set(Math.round(s.freqHz), { d, seenAt: nowMs, snr: s.snrDb });
      }
    }
    for (const [k, c] of this.chans) {
      if (nowMs - c.seenAt > this.idleMs) {
        c.d.close();
        this.chans.delete(k);
      }
    }
  }

  snrOf(d: D): number | null {
    for (const c of this.chans.values()) if (c.d === d) return c.snr;
    return null;
  }

  feed(x: Float32Array, atMs: number): void {
    this.history.push({ x: x.slice(), at: atMs });
    this.historySamples += x.length;
    while (this.historySamples > RATE * 3 && this.history.length > 1) this.historySamples -= this.history.shift()!.x.length;
    this.rx?.feed(x, atMs);
    for (const c of this.chans.values()) c.d.feed(x, atMs);
  }

  clear(): void {
    this.rx?.close();
    this.rx = null;
    this.rxAt = NaN;
    for (const c of this.chans.values()) c.d.close();
    this.chans.clear();
    this.history = [];
    this.historySamples = 0;
  }

  each(fn: (d: D) => void): void {
    if (this.rx) fn(this.rx);
    for (const c of this.chans.values()) fn(c.d);
  }

  get size(): number {
    return this.chans.size + (this.rx ? 1 : 0);
  }
}

/** Raised-cosine ramp from 0 to 1 over n samples. */
export function ramp(i: number, n: number): number {
  return i >= n ? 1 : (1 - Math.cos((Math.PI * i) / n)) / 2;
}
