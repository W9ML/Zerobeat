/** Streaming decimation and a real FFT for the waterfall. */

/** Windowed-sinc low-pass taps. `cutoff` is a fraction of the input sample rate. */
export function lowpassTaps(n: number, cutoff: number): Float32Array {
  const taps = new Float32Array(n);
  const m = (n - 1) / 2;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const x = i - m;
    const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (n - 1)); // Blackman
    taps[i] = sinc * w;
    sum += taps[i]!;
  }
  for (let i = 0; i < n; i++) taps[i]! /= sum;
  return taps;
}

/**
 * Decimate by 2 with a 47-tap low-pass (passband to ~4.5 kHz at 24 kHz in, stop above
 * 6 kHz). Keeps its history across calls, and computes only the outputs it keeps.
 */
export class Decimator2 {
  private readonly taps = lowpassTaps(47, 5000 / 24000);
  private readonly hist: Float32Array;
  private phase = 0;

  constructor() {
    this.hist = new Float32Array(this.taps.length - 1);
  }

  process(input: Float32Array): Float32Array {
    const n = this.taps.length;
    const buf = new Float32Array(this.hist.length + input.length);
    buf.set(this.hist, 0);
    buf.set(input, this.hist.length);
    const outLen = Math.floor((input.length + (this.phase === 0 ? 1 : 0)) / 2);
    const out = new Float32Array(outLen);
    let o = 0;
    for (let i = this.phase; i < input.length; i += 2) {
      let acc = 0;
      const base = i; // buf index of the oldest sample in the window ending at input[i]
      for (let k = 0; k < n; k++) acc += this.taps[k]! * buf[base + k]!;
      out[o++] = acc;
    }
    this.phase = (this.phase + input.length) % 2;
    this.hist.set(buf.subarray(buf.length - this.hist.length));
    return o === outLen ? out : out.subarray(0, o);
  }
}

/** In-place iterative radix-2 FFT. `re`/`im` length must be a power of two. */
export function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const a = i + j;
        const b = a + len / 2;
        const tr = re[b]! * cr - im[b]! * ci;
        const ti = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - tr;
        im[b] = im[a]! - ti;
        re[a] = re[a]! + tr;
        im[a] = im[a]! + ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/**
 * Waterfall rows from 12 kHz audio: Hann-windowed 2048-point FFT (5.86 Hz bins, 0–3000 Hz),
 * a new row every 50 ms (75% overlap), so the picture moves smoothly and FT8/FT4 tones
 * show their steps.
 *
 * Each row is the power of the last AVG spectra averaged (two: the FFT is one FT8 symbol
 * long, so tone hops stay sharp and the trace reads as a smooth wiggling line, as on
 * SmartSDR; four smeared them into blobs), relative to the noise floor, in fixed units:
 * value = (dB above floor + DB_OFFSET) * STEPS_PER_DB. The floor follows within a few
 * rows because DAX audio comes after the radio's AGC: when strong FT4/FT8 signals stop
 * at the end of a cycle the gain recovers, and a slowly tracked floor drew that as a
 * bright band across the whole waterfall every cycle. The browser chooses black level
 * and range, so brightness is a display setting, not an engine one.
 */
export class Waterfall {
  static readonly N = 2048;
  static readonly RATE = 12_000;
  static readonly MAX_HZ = 3000;
  static readonly HOP = 600;
  static readonly ROWS_PER_SEC = Waterfall.RATE / Waterfall.HOP;
  static readonly DB_OFFSET = 10;
  static readonly STEPS_PER_DB = 2.5;
  static readonly AVG = 2;
  readonly bins = Math.floor((Waterfall.MAX_HZ * Waterfall.N) / Waterfall.RATE);
  private readonly window = new Float32Array(Waterfall.N);
  private readonly buf = new Float32Array(Waterfall.N);
  private readonly re = new Float32Array(Waterfall.N);
  private readonly im = new Float32Array(Waterfall.N);
  private readonly db = new Float32Array(this.bins);
  private readonly recent: Float32Array[] = [];
  private readonly sample: number[] = [];
  private fill = 0;
  private sinceRow = 0;
  private floorDb: number | null = null;
  /** True while we transmit: the receive audio is muted, so it must not move the floor. */
  holdFloor = false;

  constructor(private readonly hop = Waterfall.HOP) {
    for (let i = 0; i < Waterfall.N; i++) this.window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (Waterfall.N - 1));
  }

  /** Feed samples; returns any rows completed. `ends` gets the index in `samples` each row completed at. */
  push(samples: Float32Array, ends?: number[]): Uint8Array[] {
    const rows: Uint8Array[] = [];
    for (let i = 0; i < samples.length; i++) {
      this.buf[this.fill++ % Waterfall.N] = samples[i]!;
      this.sinceRow++;
      if (this.fill >= Waterfall.N && this.sinceRow >= this.hop) {
        this.sinceRow = 0;
        rows.push(this.row());
        ends?.push(i);
      }
    }
    if (this.fill > Waterfall.N * 4) this.fill = Waterfall.N + (this.fill % Waterfall.N);
    return rows;
  }

  private row(): Uint8Array {
    const n = Waterfall.N;
    const { re, im, db } = this;
    const start = this.fill % n;
    for (let i = 0; i < n; i++) {
      re[i] = this.buf[(start + i) % n]! * this.window[i]!;
      im[i] = 0;
    }
    fft(re, im);
    const pw = this.recent.length >= Waterfall.AVG ? this.recent.shift()! : new Float32Array(this.bins);
    for (let k = 0; k < this.bins; k++) pw[k] = re[k]! * re[k]! + im[k]! * im[k]!;
    this.recent.push(pw);
    const sample = this.sample;
    sample.length = 0;
    const m = this.recent.length;
    for (let k = 0; k < this.bins; k++) {
      let p = 0;
      for (let j = 0; j < m; j++) p += this.recent[j]![k]!;
      db[k] = 10 * Math.log10(p / m + 1e-20);
      // Skip the bottom 100 Hz (filter skirt) when estimating the floor.
      if (k > 17 && k % 2 === 0) sample.push(db[k]!);
    }
    sample.sort((a, b) => a - b);
    // 30th percentile: the noise, even on a crowded band.
    const p30 = sample[Math.floor(sample.length * 0.3)] ?? -100;
    if (this.floorDb === null) this.floorDb = p30;
    else if (!this.holdFloor) this.floorDb += (p30 - this.floorDb) * 0.3;
    const out = new Uint8Array(this.bins);
    const off = Waterfall.DB_OFFSET - this.floorDb;
    for (let k = 0; k < this.bins; k++) {
      const v = (db[k]! + off) * Waterfall.STEPS_PER_DB;
      out[k] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
    return out;
  }
}
