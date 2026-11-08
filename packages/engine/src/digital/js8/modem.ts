/**
 * JS8 physical layer: framing, the transmit waveform and the receiver
 * (JS8Call-improved JS8_Mode/JS8.cpp: JS8::encode, the DecodeMode template with syncjs8,
 * baselinejs8, js8_downsample, syncjs8d, js8dec, genjs8refsig and subtractjs8;
 * JS8_Mode/Modulator.cpp for the waveform; the older js8call JS8.cpp it grew from was the
 * main reference for the decoder's control flow).
 *
 * A frame is 79 continuous-phase 8-FSK symbols: Costas sync at symbols 0, 36 and 72, the 29
 * parity symbols after the first, the 29 message symbols after the second. Each data symbol
 * carries three codeword bits in plain binary (no Gray code): tone = 4·b0 + 2·b1 + b2.
 *
 * The receiver follows JS8Call step by step. Per pass: quarter-symbol power spectra (see
 * syncjs8 for which flavour), a polynomial noise baseline, a Costas sync score for every frequency bin
 * and time offset, candidates above 1.5× the 40th-percentile score; then per candidate a
 * mix-down to baseband by FFT, a quarter-symbol time and ½ Hz frequency peak-up, 8-bin
 * symbol spectra, a hard Costas check (at least 7 of 21), two kinds of soft metric and four
 * BP attempts (plain, log-metric, and with the first 24 and 48 LLRs erased), each followed
 * by OSD at depth 3. Every decode is regenerated and subtracted from the audio so the next
 * pass can find what it was hiding. The pass schedule per depth and the OSD stage are the
 * Fortran decoder's (lib/js8/js8a_decode.f90, js8dec.f90), which is what JS8Call's test
 * recordings were labelled with, and so are the noise baseline and SNR (what JS8Call 2.2
 * reports, and what stations send back in their SNR replies).
 *
 * Input audio is scaled to JS8Call's int16 range internally; nothing in the decoder depends
 * on absolute level except through ratios, but it keeps the arithmetic in the same range.
 */

import { bpDecode174, checkCrc12, ldpcEncode, osdDecode174, withCrc12, K, N } from "./ldpc.ts";
import { FRAME_ALPHABET, NUM_DATA_SYMBOLS, NUM_SYMBOLS, RX_SAMPLE_RATE, js8Params, type Js8Submode, type Js8SubmodeParams } from "./params.ts";

const TAU = 2 * Math.PI;

/* -------------------------------------------------------------------------------------- */
/* FFT                                                                                     */
/* -------------------------------------------------------------------------------------- */

/**
 * Mixed-radix complex FFT (Stockham, decimation in frequency) for any length. JS8's
 * transform sizes are set by its symbol lengths (3840, 180000, 192000, 3008 = 2⁶·47 …), so
 * the radix-2 FFT in dsp.ts won't do. Radix 4 and 2 are unrolled; every other prime factor
 * goes through a direct DFT, which is plenty for the 3s, 5s and a lone 47.
 * Forward is e^(-i…) and inverse e^(+i…), both unnormalised, as in FFTW.
 */
class ComplexFft {
  readonly n: number;
  private readonly factors: number[];
  private readonly cos: Float64Array;
  private readonly sin: Float64Array;
  private readonly yr: Float64Array;
  private readonly yi: Float64Array;
  private readonly tr: Float64Array;
  private readonly ti: Float64Array;

  constructor(n: number) {
    this.n = n;
    const f: number[] = [];
    let m = n;
    while (m % 4 === 0) {
      f.push(4);
      m /= 4;
    }
    while (m % 2 === 0) {
      f.push(2);
      m /= 2;
    }
    for (let p = 3; m > 1; p += 2) {
      while (m % p === 0) {
        f.push(p);
        m /= p;
      }
    }
    this.factors = f;
    this.cos = new Float64Array(n);
    this.sin = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      this.cos[k] = Math.cos((TAU * k) / n);
      this.sin[k] = -Math.sin((TAU * k) / n);
    }
    this.yr = new Float64Array(n);
    this.yi = new Float64Array(n);
    const maxR = Math.max(1, ...f);
    this.tr = new Float64Array(maxR);
    this.ti = new Float64Array(maxR);
  }

  /** In-place transform of (re, im), each at least n long. */
  transform(re: Float64Array, im: Float64Array, inverse = false): void {
    const n = this.n;
    const C = this.cos;
    const S = this.sin;
    const sg = inverse ? -1 : 1; // multiplies the imaginary part of every root
    let xr = re;
    let xi = im;
    let yr = this.yr;
    let yi = this.yi;
    let len = n;
    let s = 1;
    for (const r of this.factors) {
      const m = len / r;
      const step = n / len;
      if (r === 4) {
        for (let p = 0; p < m; p++) {
          const w1r = C[p * step]!, w1i = sg * S[p * step]!;
          const w2r = C[2 * p * step]!, w2i = sg * S[2 * p * step]!;
          const w3r = C[3 * p * step]!, w3i = sg * S[3 * p * step]!;
          for (let q = 0; q < s; q++) {
            const i0 = q + s * p;
            const i1 = i0 + s * m;
            const i2 = i1 + s * m;
            const i3 = i2 + s * m;
            const a0r = xr[i0]!, a0i = xi[i0]!;
            const a1r = xr[i1]!, a1i = xi[i1]!;
            const a2r = xr[i2]!, a2i = xi[i2]!;
            const a3r = xr[i3]!, a3i = xi[i3]!;
            const s02r = a0r + a2r, s02i = a0i + a2i;
            const d02r = a0r - a2r, d02i = a0i - a2i;
            const s13r = a1r + a3r, s13i = a1i + a3i;
            // -i·sg·(a1 - a3)
            const d13r = sg * (a1i - a3i), d13i = -sg * (a1r - a3r);
            const o = q + s * 4 * p;
            yr[o] = s02r + s13r;
            yi[o] = s02i + s13i;
            const b1r = d02r + d13r, b1i = d02i + d13i;
            yr[o + s] = b1r * w1r - b1i * w1i;
            yi[o + s] = b1r * w1i + b1i * w1r;
            const b2r = s02r - s13r, b2i = s02i - s13i;
            yr[o + 2 * s] = b2r * w2r - b2i * w2i;
            yi[o + 2 * s] = b2r * w2i + b2i * w2r;
            const b3r = d02r - d13r, b3i = d02i - d13i;
            yr[o + 3 * s] = b3r * w3r - b3i * w3i;
            yi[o + 3 * s] = b3r * w3i + b3i * w3r;
          }
        }
      } else if (r === 2) {
        for (let p = 0; p < m; p++) {
          const wr = C[p * step]!, wi = sg * S[p * step]!;
          for (let q = 0; q < s; q++) {
            const i0 = q + s * p;
            const i1 = i0 + s * m;
            const ar = xr[i0]!, ai = xi[i0]!;
            const br = xr[i1]!, bi = xi[i1]!;
            const o = q + s * 2 * p;
            yr[o] = ar + br;
            yi[o] = ai + bi;
            const dr = ar - br, di = ai - bi;
            yr[o + s] = dr * wr - di * wi;
            yi[o + s] = dr * wi + di * wr;
          }
        }
      } else {
        const tr = this.tr;
        const ti = this.ti;
        const rstep = n / r;
        for (let p = 0; p < m; p++) {
          for (let q = 0; q < s; q++) {
            for (let t = 0; t < r; t++) {
              const idx = q + s * (p + t * m);
              tr[t] = xr[idx]!;
              ti[t] = xi[idx]!;
            }
            const o = q + s * r * p;
            for (let u = 0; u < r; u++) {
              let br = 0;
              let bi = 0;
              for (let t = 0; t < r; t++) {
                const k = ((t * u) % r) * rstep;
                const cr = C[k]!, ci = sg * S[k]!;
                br += tr[t]! * cr - ti[t]! * ci;
                bi += tr[t]! * ci + ti[t]! * cr;
              }
              const k = p * u * step;
              const wr = C[k]!, wi = sg * S[k]!;
              yr[o + s * u] = br * wr - bi * wi;
              yi[o + s * u] = br * wi + bi * wr;
            }
          }
        }
      }
      len = m;
      s *= r;
      const swr = xr, swi = xi;
      xr = yr;
      xi = yi;
      yr = swr;
      yi = swi;
    }
    if (xr !== re) {
      re.set(xr.subarray(0, n));
      im.set(xi.subarray(0, n));
    }
  }
}

const complexFfts = new Map<number, ComplexFft>();
function complexFft(n: number): ComplexFft {
  let f = complexFfts.get(n);
  if (!f) complexFfts.set(n, (f = new ComplexFft(n)));
  return f;
}

/** Real forward FFT of even length n through a half-length complex FFT; bins 0..n/2. */
class RealFft {
  readonly n: number;
  private readonly half: ComplexFft;
  private readonly zr: Float64Array;
  private readonly zi: Float64Array;
  private readonly wr: Float64Array;
  private readonly wi: Float64Array;

  constructor(n: number) {
    this.n = n;
    const h = n / 2;
    this.half = complexFft(h);
    this.zr = new Float64Array(h);
    this.zi = new Float64Array(h);
    this.wr = new Float64Array(h + 1);
    this.wi = new Float64Array(h + 1);
    for (let k = 0; k <= h; k++) {
      this.wr[k] = Math.cos((TAU * k) / n);
      this.wi[k] = -Math.sin((TAU * k) / n);
    }
  }

  /** x (length ≤ n, zero padded) → outRe/outIm[0..n/2]. */
  forward(x: ArrayLike<number>, len: number, outRe: Float64Array, outIm: Float64Array): void {
    const h = this.n / 2;
    const zr = this.zr;
    const zi = this.zi;
    for (let k = 0; k < h; k++) {
      const a = 2 * k;
      zr[k] = a < len ? x[a]! : 0;
      zi[k] = a + 1 < len ? x[a + 1]! : 0;
    }
    this.half.transform(zr, zi);
    for (let k = 0; k <= h; k++) {
      const k1 = k % h;
      const k2 = (h - k) % h;
      const ar = zr[k1]!, ai = zi[k1]!;
      const br = zr[k2]!, bi = -zi[k2]!; // conj(Z[h-k])
      const er = 0.5 * (ar + br), ei = 0.5 * (ai + bi);
      // (Z[k] - conj(Z[h-k])) / 2i
      const or = 0.5 * (ai - bi), oi = -0.5 * (ar - br);
      const wr = this.wr[k]!, wi = this.wi[k]!;
      outRe[k] = er + (or * wr - oi * wi);
      outIm[k] = ei + (or * wi + oi * wr);
    }
  }
}

/* -------------------------------------------------------------------------------------- */
/* Framing and the transmit waveform                                                       */
/* -------------------------------------------------------------------------------------- */

const WORD_OF = new Map<string, number>([...FRAME_ALPHABET].map((c, i) => [c, i]));

/** 12 frame characters + 3-bit frame type → the 87 information bits (with CRC). */
export function js8FrameBits(message12: string, i3: number): Uint8Array {
  if (message12.length !== 12) throw new Error(`JS8 frame must be 12 characters, got ${message12.length}`);
  const bits = new Uint8Array(75);
  for (let i = 0; i < 12; i++) {
    const w = WORD_OF.get(message12[i]!);
    if (w === undefined) throw new Error(`Invalid character in JS8 frame: ${JSON.stringify(message12[i])}`);
    for (let b = 0; b < 6; b++) bits[i * 6 + b] = (w >> (5 - b)) & 1;
  }
  for (let b = 0; b < 3; b++) bits[72 + b] = (i3 >> (2 - b)) & 1;
  return withCrc12(bits);
}

/** 79 tones (0-7) for a frame. Submode decides only the Costas arrays. */
export function encodeJs8(message12: string, i3: number, submode: Js8Submode | Js8SubmodeParams = "normal"): number[] {
  const costas = js8Params(submode).costas;
  const cw = ldpcEncode(js8FrameBits(message12, i3));
  const tones = new Array<number>(NUM_SYMBOLS).fill(0);
  for (let b = 0; b < 3; b++) for (let n = 0; n < 7; n++) tones[36 * b + n] = costas[b]![n]!;
  for (let j = 0; j < 29; j++) {
    tones[7 + j] = 4 * cw[3 * j]! + 2 * cw[3 * j + 1]! + cw[3 * j + 2]!;
    tones[43 + j] = 4 * cw[87 + 3 * j]! + 2 * cw[87 + 3 * j + 1]! + cw[87 + 3 * j + 2]!;
  }
  return tones;
}

/**
 * Modulator.cpp: phase-continuous 8-FSK with no pulse shaping, tone k at f0 + k·spacing,
 * the phase advanced before each sample; the last 0.017 symbol decays by 0.98 per 48 kHz
 * sample to soften the key-up click. Starts at the first symbol: the submode's start delay
 * is the caller's to schedule. Unit amplitude.
 */
export function js8Waveform(tones: ArrayLike<number>, f0Hz: number, sampleRate = RX_SAMPLE_RATE, submode: Js8Submode | Js8SubmodeParams = "normal"): Float32Array {
  const p = js8Params(submode);
  const spsym = (p.nsps * sampleRate) / RX_SAMPLE_RATE;
  const total = Math.round(tones.length * spsym);
  const out = new Float32Array(total);
  const fadeStart = (tones.length - 0.017) * spsym;
  const decay = Math.pow(0.98, 48000 / sampleRate);
  let phi = 0;
  let amp = 1;
  for (let i = 0; i < total; i++) {
    const sym = Math.min(tones.length - 1, Math.floor(i / spsym));
    phi += (TAU * (f0Hz + tones[sym]! * p.toneSpacingHz)) / sampleRate;
    if (phi > TAU) phi -= TAU;
    if (i > fadeStart) amp *= decay;
    out[i] = amp * Math.sin(phi);
  }
  return out;
}

/* -------------------------------------------------------------------------------------- */
/* Receiver                                                                                */
/* -------------------------------------------------------------------------------------- */

export interface Js8Decode {
  /** The 12 frame characters (Varicode decodes these). */
  message12: string;
  /** 3-bit transmission (frame) type. */
  i3: number;
  /** Frequency of tone 0. */
  freqHz: number;
  /** Signal start relative to the nominal start (period start + start delay), seconds. */
  dtSec: number;
  snrDb: number;
  /** Hard errors BP corrected (0 = clean). */
  hardErrors: number;
}

export interface Js8DecodeOptions {
  /**
   * The Fortran decoder's schedule. 1: one pass, no subtraction. 2 (default): up to three
   * passes with subtraction, which is also what JS8Call's C++ decoder always does. 3: a
   * fourth pass, and ordered-statistics decoding whenever BP fails (more frames, more CPU,
   * and a somewhat higher chance of a CRC-passing false decode).
   */
  depth?: 1 | 2 | 3;
  freqMinHz?: number;
  freqMaxHz?: number;
  /** Candidates within 10 Hz of this are tried first (JS8Call's "QSO frequency"). */
  nfqsoHz?: number;
}

const NN = NUM_SYMBOLS;
const ND = NUM_DATA_SYMBOLS;
const NFOS = 2;
const NSSY = 4;
const NFSRCH = 5;
const ASYNCMIN = 1.5;
const NMAXCAND = 300;
const NFILT = 1400;
const NROWS = 8;
const NP = 3200;
/** JS8.cpp's namespace-level NP2, which js8dec uses (not the mode's 79·NDOWNSPS). */
const NP2_GLOBAL = 2812;
const NAPWID = 75;

interface Candidate {
  freq: number;
  dt: number;
  sync: number;
}

class Js8Receiver {
  private readonly p: Js8SubmodeParams;
  private readonly costas: readonly (readonly number[])[];
  private readonly nsps: number;
  private readonly ndownsps: number;
  private readonly nmax: number;
  private readonly nfft1: number;
  private readonly nstep: number;
  private readonly nhsym: number;
  private readonly ndown: number;
  private readonly nqsymbol: number;
  private readonly ndfft1: number;
  private readonly ndfft2: number;
  private readonly np2: number;
  private readonly tstep: number;
  private readonly jstrt: number;
  private readonly df: number;

  private readonly csyncRe: Float64Array; // [block][symbol][sample]
  private readonly csyncIm: Float64Array;
  private readonly taper: Float64Array;
  private readonly filterRe: Float64Array;
  private readonly filterIm: Float64Array;
  private readonly symCos: Float64Array; // 8-bin DFT of one downsampled symbol
  private readonly symSin: Float64Array;
  private readonly specFft: RealFft;
  private readonly bbFft: RealFft;

  // Working state for one decode.
  private readonly dd: Float64Array;
  private readonly s: Float32Array; // [bin][quarter-symbol]
  private readonly savg: Float64Array;
  private readonly dsRe: Float64Array;
  private readonly dsIm: Float64Array;
  private readonly cdRe: Float64Array;
  private readonly cdIm: Float64Array;

  constructor(p: Js8SubmodeParams) {
    this.p = p;
    this.costas = p.costas;
    this.nsps = p.nsps;
    this.ndownsps = p.ndownsps;
    this.nmax = p.periodSec * RX_SAMPLE_RATE;
    this.nfft1 = p.nsps * NFOS;
    this.nstep = p.nsps / NSSY;
    this.nhsym = Math.floor(this.nmax / this.nstep) - 3;
    this.ndown = p.nsps / p.ndownsps;
    this.nqsymbol = Math.floor(p.ndownsps / 4);
    this.ndfft1 = p.nsps * p.ndd;
    this.ndfft2 = this.ndfft1 / this.ndown;
    this.np2 = NN * p.ndownsps;
    this.tstep = this.nstep / RX_SAMPLE_RATE;
    this.jstrt = Math.floor((p.startDelayMs * 12) / this.nstep);
    this.df = RX_SAMPLE_RATE / this.nfft1;

    let sum = 0;

    // Reference Costas tones at baseband.
    const nds = p.ndownsps;
    this.csyncRe = new Float64Array(3 * 7 * nds);
    this.csyncIm = new Float64Array(3 * 7 * nds);
    for (let b = 0; b < 3; b++) {
      for (let n = 0; n < 7; n++) {
        const dphi = (TAU * this.costas[b]![n]!) / nds;
        for (let k = 0; k < nds; k++) {
          const o = (b * 7 + n) * nds + k;
          this.csyncRe[o] = Math.cos(dphi * k);
          this.csyncIm[o] = Math.sin(dphi * k);
        }
      }
    }

    // Raised-cosine taper for the downsampler's band edges (rising half).
    this.taper = new Float64Array(p.ndd + 1);
    for (let i = 0; i <= p.ndd; i++) this.taper[p.ndd - i] = 0.5 * (1 + Math.cos((i * Math.PI) / p.ndd));

    // Subtraction low-pass: cos² window of NFILT+1 taps, zero phase (JS8Call-improved's
    // layout; the older C++ rotated it into a lopsided kernel), in the frequency domain
    // with the inverse FFT's 1/N folded in.
    this.filterRe = new Float64Array(this.nmax);
    this.filterIm = new Float64Array(this.nmax);
    sum = 0;
    for (let j = -NFILT / 2; j <= NFILT / 2; j++) sum += Math.cos((Math.PI * j) / NFILT) ** 2;
    for (let j = -NFILT / 2; j <= NFILT / 2; j++) this.filterRe[(j + this.nmax) % this.nmax] = Math.cos((Math.PI * j) / NFILT) ** 2 / sum;
    complexFft(this.nmax).transform(this.filterRe, this.filterIm);
    for (let i = 0; i < this.nmax; i++) {
      this.filterRe[i]! /= this.nmax;
      this.filterIm[i]! /= this.nmax;
    }

    this.symCos = new Float64Array(NROWS * nds);
    this.symSin = new Float64Array(NROWS * nds);
    for (let r = 0; r < NROWS; r++) {
      for (let k = 0; k < nds; k++) {
        this.symCos[r * nds + k] = Math.cos((TAU * r * k) / nds);
        this.symSin[r * nds + k] = -Math.sin((TAU * r * k) / nds);
      }
    }

    this.specFft = new RealFft(this.nfft1);
    this.bbFft = new RealFft(this.ndfft1);

    this.dd = new Float64Array(this.nmax);
    this.s = new Float32Array(this.nsps * this.nhsym);
    this.savg = new Float64Array(this.nsps);
    this.dsRe = new Float64Array(this.ndfft1 / 2 + 1);
    this.dsIm = new Float64Array(this.ndfft1 / 2 + 1);
    const ncd = Math.max(NP, this.ndfft2);
    this.cdRe = new Float64Array(ncd);
    this.cdIm = new Float64Array(ncd);
  }

  decode(samples: ArrayLike<number>, opts: Js8DecodeOptions): Js8Decode[] {
    const depth = opts.depth ?? 2;
    const nfa = Math.round(opts.freqMinHz ?? 200);
    const nfb = Math.round(opts.freqMaxHz ?? 4000);
    const nfqso = opts.nfqsoHz ?? 1500;

    const dd = this.dd;
    dd.fill(0);
    const n = Math.min(samples.length, this.nmax);
    for (let i = 0; i < n; i++) dd[i] = samples[i]! * 32768;

    const npass = depth === 1 ? 1 : depth === 2 ? 3 : 4;
    const best = new Map<string, Js8Decode>();

    for (let ipass = 1; ipass <= npass; ipass++) {
      const candidates = this.syncjs8(nfa, nfb);
      if (candidates.length === 0) break;
      candidates.sort((a, b) => {
        const ad = Math.abs(a.freq - nfqso);
        const bd = Math.abs(b.freq - nfqso);
        const an = ad < 10;
        const bn = bd < 10;
        if (an !== bn) return an ? -1 : 1;
        return ad - bd || a.freq - b.freq;
      });

      this.computeBasebandFft();

      // Subtract on every pass that another pass may follow.
      const subtract = ipass < npass;
      let improved = false;

      for (const c of candidates) {
        const d = this.js8dec(subtract, c.freq, c.dt, depth >= 3 ? nfqso : null);
        if (!d) continue;
        const key = `${d.i3}:${d.message12}`;
        const prev = best.get(key);
        const snr = Math.round(d.snrDb);
        if (!prev || Math.round(prev.snrDb) < snr) {
          improved = true;
          best.set(key, d);
        }
      }

      if (!improved) break;
    }

    return [...best.values()];
  }

  /**
   * Quarter-symbol spectra, baseline, Costas sync scores and the candidate list.
   *
   * The spectra are WSJT-X sync8's: one symbol of audio, unwindowed, scaled by 1/300 and
   * zero-padded to two symbols. That is what JS8Call 2.2's js8 binary does, and it differs
   * from the later js8call source (a two-symbol Nuttall window, and candidate times half a
   * step later); the binary's SNRs on the test recordings and on synthetic signals are
   * reproduced to the dB only this way, and so is its A_2_9 decode at 592 Hz. The window
   * sets the noise baseline's scale (the Nuttall one reads 6 dB more noise) and, through
   * its leakage, how much a very strong signal raises its own baseline: JS8Call 2.2 reports
   * a +30 dB signal as about +19.
   */
  private syncjs8(nfa: number, nfb: number): Candidate[] {
    const { nsps, nhsym, nstep, nfft1, nmax } = this;
    const s = this.s;
    const savg = this.savg;
    const dd = this.dd;
    savg.fill(0);
    const re = new Float64Array(nfft1 / 2 + 1);
    const im = new Float64Array(nfft1 / 2 + 1);
    const seg = new Float64Array(nfft1);
    for (let j = 0; j < nhsym; j++) {
      const ia = j * nstep;
      if (ia + nsps > nmax) break;
      for (let i = 0; i < nsps; i++) seg[i] = dd[ia + i]! / 300;
      this.specFft.forward(seg, nfft1, re, im);
      for (let i = 0; i < nsps; i++) {
        const power = re[i]! * re[i]! + im[i]! * im[i]!;
        s[i * nhsym + j] = power;
        savg[i]! += power;
      }
    }

    const nwin = nfb - nfa;
    if (nfa < 100) {
      nfa = 100;
      if (nwin < 100) nfb = nfa + nwin;
    }
    if (nfb > 4910) {
      nfb = 4910;
      if (nwin < 100) nfa = nfb - nwin;
    }
    const ia = Math.max(0, Math.round(nfa / this.df));
    const ib = Math.round(nfb / this.df);
    if (ib < ia) return [];

    this.baselinejs8(nfa, nfb);

    // Sync score per bin: the best over time offsets of the Costas power ratio, using all
    // three blocks or either adjacent pair (so a signal clipped at either end still counts).
    const jz = this.p.jz;
    const jstrt = this.jstrt;
    const costas = this.costas;
    const nb = ib - ia + 1;
    const freqs = new Float64Array(nb);
    const dts = new Float64Array(nb);
    const syncs = new Float64Array(nb);
    const all7 = new Float64Array(nhsym);
    for (let i = ia; i <= ib; i++) {
      // Sum over the 7 tone bins for every time step, shared by all offsets.
      for (let t = 0; t < nhsym; t++) {
        let a = 0;
        for (let f = 0; f < 7; f++) a += s[(i + NFOS * f) * nhsym + t]!;
        all7[t] = a;
      }
      let maxValue = -Infinity;
      let maxIndex = -jz;
      for (let j = -jz; j <= jz; j++) {
        let t00 = 0, t01 = 0, t02 = 0, t10 = 0, t11 = 0, t12 = 0;
        for (let pb = 0; pb < 3; pb++) {
          const row = costas[pb]!;
          let tx = 0;
          let t0 = 0;
          for (let nn = 0; nn < 7; nn++) {
            const off = j + jstrt + NSSY * nn + pb * 36 * NSSY;
            if (off >= 0 && off < nhsym) {
              tx += s[(i + NFOS * row[nn]!) * nhsym + off]!;
              t0 += all7[off]!;
            }
          }
          if (pb === 0) {
            t00 = tx;
            t10 = t0;
          } else if (pb === 1) {
            t01 = tx;
            t11 = t0;
          } else {
            t02 = tx;
            t12 = t0;
          }
        }
        const sa = (t00 + t01 + t02) / ((t10 + t11 + t12 - (t00 + t01 + t02)) / 6);
        const sb = (t00 + t01) / ((t10 + t11 - (t00 + t01)) / 6);
        const sc = (t01 + t02) / ((t11 + t12 - (t01 + t02)) / 6);
        // std::max({...}) semantics: a NaN first value sticks, a later NaN is ignored.
        let v = sa;
        if (v < sb) v = sb;
        if (v < sc) v = sc;
        if (v > maxValue) {
          maxValue = v;
          maxIndex = j;
        }
      }
      const k = i - ia;
      freqs[k] = this.df * i;
      // sync8's (jpeak - 1)·tstep, i.e. the start of the best quarter-symbol step.
      dts[k] = this.tstep * maxIndex;
      syncs[k] = maxValue;
    }

    // Normalise to the 40th percentile.
    const sorted = Float64Array.from(syncs).sort();
    const norm = sorted[Math.floor((nb * 4) / 10)]!;
    for (let k = 0; k < nb; k++) syncs[k]! /= norm;

    // Strongest first; each pick removes its neighbours within AZ Hz.
    const order = Array.from({ length: nb }, (_, k) => k);
    order.sort((a, b) => {
      const sa = syncs[a]!, sb = syncs[b]!;
      const na = Number.isNaN(sa), nbn = Number.isNaN(sb);
      if (na || nbn) return na === nbn ? a - b : na ? 1 : -1;
      return sb - sa || a - b;
    });
    const removed = new Uint8Array(nb);
    const out: Candidate[] = [];
    const az = this.p.azHz;
    for (const k of order) {
      if (out.length >= NMAXCAND) break;
      if (removed[k]) continue;
      const v = syncs[k]!;
      if (!(v >= ASYNCMIN)) break;
      out.push({ freq: freqs[k]!, dt: dts[k]!, sync: v });
      const f = freqs[k]!;
      for (let q = 0; q < nb; q++) if (freqs[q]! >= f - az && freqs[q]! <= f + az) removed[q] = 1;
    }
    return out;
  }

  /**
   * baselinejs8.f90, the noise baseline JS8Call 2.2's js8 decoder uses (and therefore the SNR
   * scale stations put on the air): savg in dB over bins [max(1, ia), ib], split into ten
   * equal segments; every point at or below its segment's 10th percentile (pctile.f90:
   * sorted, index nint(0.1·n)) is a lower-envelope point; a least-squares quartic through
   * those points, plus 0.65 dB, replaces savg there. The C++ ports fit 500-2500 Hz with
   * Chebyshev nodes instead, which reads 10-15 dB high on the noise and low on the SNR.
   */
  private baselinejs8(nfa: number, nfb: number): void {
    const savg = this.savg;
    const ia = Math.max(1, Math.round(nfa / this.df));
    const ib = Math.min(Math.round(nfb / this.df), savg.length - 1);
    const db = new Float64Array(savg.length);
    for (let i = ia; i <= ib; i++) db[i] = Math.fround(10 * Math.log10(savg[i]!));

    const nseg = 10;
    const nlen = Math.floor((ib - ia + 1) / nseg);
    const i0 = Math.floor((ib - ia + 1) / 2);
    const xs: number[] = [];
    const ys: number[] = [];
    for (let n = 0; n < nseg && nlen > 0; n++) {
      const ja = ia + n * nlen;
      const seg = Array.from(db.subarray(ja, ja + nlen)).sort((x, y) => x - y);
      const j = Math.min(Math.max(Math.round(nlen * 0.1), 1), nlen);
      const base = seg[j - 1]!;
      for (let i = ja; i < ja + nlen; i++) {
        if (db[i]! > base) continue;
        // The Fortran keeps at most 1000 points; later ones overwrite the last slot.
        const k = Math.min(xs.length, 999);
        xs[k] = i - i0;
        ys[k] = db[i]!;
      }
    }

    const coef = polyfit4(xs, ys);
    savg.fill(0);
    for (let i = ia; i <= ib; i++) {
      const t = i - i0;
      savg[i] = Math.fround(Math.fround(coef[0]! + t * (coef[1]! + t * (coef[2]! + t * (coef[3]! + t * coef[4]!)))) + 0.65);
    }
  }

  /** Real FFT of the whole (zero-padded) period, the source for every candidate's mix-down. */
  private computeBasebandFft(): void {
    this.bbFft.forward(this.dd, this.nmax, this.dsRe, this.dsIm);
  }

  /** js8_downsample: cut −1.5…+8.5 baud around f0 out of the long FFT, centre f0, IFFT. */
  private downsample(f0: number): void {
    const dfb = RX_SAMPLE_RATE / this.ndfft1;
    const baud = RX_SAMPLE_RATE / this.nsps;
    const ft = f0 + 8.5 * baud;
    const fb = f0 - 1.5 * baud;
    const i0 = Math.round(f0 / dfb);
    const it = Math.min(Math.round(ft / dfb), this.ndfft1 / 2);
    const ib = Math.max(0, Math.round(fb / dfb));
    const cdRe = this.cdRe;
    const cdIm = this.cdIm;
    const n2 = this.ndfft2;
    cdRe.fill(0);
    cdIm.fill(0);
    const range = it - ib + 1;
    for (let k = 0; k < range; k++) {
      cdRe[k] = this.dsRe[ib + k]!;
      cdIm[k] = this.dsIm[ib + k]!;
    }
    const ndd1 = this.p.ndd + 1;
    for (let k = 0; k < ndd1 && k < range; k++) {
      const t = this.taper[k]!;
      cdRe[k]! *= t;
      cdIm[k]! *= t;
      const e = range - ndd1 + k;
      if (e >= 0) {
        const t2 = this.taper[this.p.ndd - k]!;
        cdRe[e]! *= t2;
        cdIm[e]! *= t2;
      }
    }
    // Rotate left so that bin i0 lands at 0 (within the first n2 entries).
    const shift = (((i0 - ib) % n2) + n2) % n2;
    if (shift) {
      const tr = cdRe.slice(0, n2);
      const ti = cdIm.slice(0, n2);
      for (let k = 0; k < n2; k++) {
        cdRe[k] = tr[(k + shift) % n2]!;
        cdIm[k] = ti[(k + shift) % n2]!;
      }
    }
    const re = cdRe.subarray(0, n2);
    const im = cdIm.subarray(0, n2);
    complexFft(n2).transform(re, im, true);
    const factor = 1 / Math.sqrt(this.ndfft1 * n2);
    for (let k = 0; k < n2; k++) {
      cdRe[k]! *= factor;
      cdIm[k]! *= factor;
    }
  }

  /** syncjs8d: coherent Costas power at downsampled offset i0 with a frequency tweak. */
  private syncjs8d(i0: number, delf: number): number {
    const nds = this.ndownsps;
    const dphi = (TAU * delf) / (RX_SAMPLE_RATE / this.ndown);
    const cdRe = this.cdRe;
    const cdIm = this.cdIm;
    let sync = 0;
    for (let b = 0; b < 3; b++) {
      for (let n = 0; n < 7; n++) {
        const off = 36 * b * nds + i0 + n * nds;
        if (off < 0 || off + nds > this.np2) continue;
        const base = (b * 7 + n) * nds;
        let zr = 0;
        let zi = 0;
        for (let k = 0; k < nds; k++) {
          // reference = csync · e^(i·dphi·k); accumulate cd · conj(reference)
          const ph = dphi * k;
          const fr = Math.cos(ph), fi = Math.sin(ph);
          const cr = this.csyncRe[base + k]!, ci = this.csyncIm[base + k]!;
          const rr = fr * cr - fi * ci;
          const ri = fr * ci + fi * cr;
          const xr = cdRe[off + k]!, xi = cdIm[off + k]!;
          zr += xr * rr + xi * ri;
          zi += xi * rr - xr * ri;
        }
        sync += zr * zr + zi * zi;
      }
    }
    return sync;
  }

  /** One candidate; `osdNear` (the QSO frequency) enables the OSD fallback of depth 3. */
  private js8dec(subtract: boolean, f1: number, xdt: number, osdNear: number | null): Js8Decode | null {
    const p = this.p;
    const nds = this.ndownsps;
    const fs2 = RX_SAMPLE_RATE / this.ndown;
    const dt2 = 1 / fs2;

    const index = Math.round(f1 / this.df);
    const xbase = Math.pow(10, 0.1 * ((this.savg[index] ?? 0) - p.basesub));

    this.downsample(f1);

    let i0 = Math.round((xdt + p.astart) * fs2);
    let smax = 0;
    let ibest = 0;
    for (let idt = i0 - this.nqsymbol; idt <= i0 + this.nqsymbol; idt++) {
      const sync = this.syncjs8d(idt, 0);
      if (sync > smax) {
        smax = sync;
        ibest = idt;
      }
    }
    const xdt2 = ibest * dt2;

    i0 = Math.round(xdt2 * fs2);
    smax = 0;
    let delfbest = 0;
    for (let ifr = -NFSRCH; ifr <= NFSRCH; ifr++) {
      const delf = ifr * 0.5;
      const sync = this.syncjs8d(i0, delf);
      if (sync > smax) {
        smax = sync;
        delfbest = delf;
      }
    }

    // Apply the frequency tweak (the phase steps once before the first sample, as in the C++).
    {
      const dphi = (-delfbest * TAU) / fs2;
      const cdRe = this.cdRe;
      const cdIm = this.cdIm;
      const lim = Math.min(NP2_GLOBAL, cdRe.length);
      for (let i = 0; i < lim; i++) {
        const ph = dphi * (i + 1);
        const wr = Math.cos(ph), wi = Math.sin(ph);
        const xr = cdRe[i]!, xi = cdIm[i]!;
        cdRe[i] = xr * wr - xi * wi;
        cdIm[i] = xr * wi + xi * wr;
      }
    }
    const freq = f1 + delfbest;
    const sync = this.syncjs8d(i0, 0);

    // 8-bin spectra of each symbol, s2[row][symbol].
    const s2 = new Float64Array(NROWS * NN);
    const lim = Math.min(NP2_GLOBAL, this.cdRe.length);
    for (let k = 0; k < NN; k++) {
      const i1 = ibest + k * nds;
      if (i1 < 0 || i1 + nds > lim) continue;
      for (let r = 0; r < NROWS; r++) {
        let zr = 0;
        let zi = 0;
        for (let j = 0; j < nds; j++) {
          const c = this.symCos[r * nds + j]!, sn = this.symSin[r * nds + j]!;
          const xr = this.cdRe[i1 + j]!, xi = this.cdIm[i1 + j]!;
          zr += xr * c - xi * sn;
          zi += xr * sn + xi * c;
        }
        s2[r * NN + k] = Math.hypot(zr, zi) / 1000;
      }
    }

    // Hard sync check: at least 7 of the 21 Costas symbols must peak on the right tone.
    let nsync = 0;
    for (let b = 0; b < 3; b++) {
      for (let n = 0; n < 7; n++) {
        const col = 36 * b + n;
        let maxRow = 0;
        for (let r = 1; r < NROWS; r++) if (s2[r * NN + col]! > s2[maxRow * NN + col]!) maxRow = r;
        if (this.costas[b]![n] === maxRow) nsync++;
      }
    }
    if (nsync <= 6) return null;

    // Soft metrics: max-of-group differences on amplitudes (llr0) and log amplitudes (llr1).
    const llr0 = new Float64Array(3 * ND);
    const llr1 = new Float64Array(3 * ND);
    const ps = new Float64Array(8);
    for (let j = 0; j < ND; j++) {
      const k = j < 29 ? 7 + j : 43 + (j - 29);
      for (let r = 0; r < 8; r++) ps[r] = s2[r * NN + k]!;
      metrics(ps, llr0, 3 * j);
      for (let r = 0; r < 8; r++) ps[r] = Math.log(ps[r]! + 1e-32);
      metrics(ps, llr1, 3 * j);
    }
    normalizeLlr(llr0);
    normalizeLlr(llr1);

    for (let ipass = 1; ipass <= 4; ipass++) {
      if (ipass === 3) llr0.fill(0, 0, 24);
      else if (ipass === 4) llr0.fill(0, 24, 48);
      const llr = ipass === 2 ? llr1 : llr0;
      let result: { hardErrors: number; cw: Uint8Array; decoded: Uint8Array } = bpDecode174(llr);
      let dmin = 0;
      if (result.hardErrors < 0 && osdNear !== null) {
        // The Fortran searched one order deeper within NAPWID (75 Hz) of the QSO frequency,
        // except on the erasure passes.
        const ndeep = Math.abs(osdNear - freq) <= NAPWID && ipass < 3 ? 4 : 3;
        const osd = osdDecode174(llr, ndeep);
        result = osd;
        dmin = osd.dmin;
      }
      const nharderrors = result.hardErrors;
      if (result.cw.every((b) => b === 0)) continue;
      if (
        !(
          nharderrors >= 0 &&
          nharderrors + dmin < 60 &&
          !(sync < 2.0 && nharderrors > 35) &&
          !(ipass > 2 && nharderrors > 39) &&
          !(ipass === 4 && nharderrors > 30)
        )
      )
        continue;
      if (!checkCrc12(result.decoded)) continue;

      const decoded = result.decoded;
      let message12 = "";
      for (let i = 0; i < 12; i++) {
        let w = 0;
        for (let b = 0; b < 6; b++) w = (w << 1) | decoded[i * 6 + b]!;
        message12 += FRAME_ALPHABET[w]!;
      }
      const i3 = (decoded[72]! << 2) | (decoded[73]! << 1) | decoded[74]!;
      const itone = encodeJs8(message12, i3, p);

      if (subtract) this.subtractjs8(itone, freq, xdt2);

      let xsig = 0;
      for (let i = 0; i < NN; i++) xsig += s2[itone[i]! * NN + i]! ** 2;
      // js8dec.f90: db(xsig/xbase - 1) - 32, floored at -28 dB as JS8Call 2.2 reports it.
      const ratio = xsig / xbase - 1;
      const snrDb = Math.max(ratio > 1.259e-10 ? 10 * Math.log10(ratio) - 32 : -131, -28);

      return { message12, i3, freqHz: freq, dtSec: xdt2 - p.astart, snrDb, hardErrors: nharderrors };
    }
    return null;
  }

  /**
   * subtractjs8: estimate the decoded signal's complex amplitude by mixing the audio with
   * the conjugate reference and low-passing it, then remove 2·Re{ref·amplitude}.
   */
  private subtractjs8(itone: readonly number[], f0: number, dt: number): void {
    const nsps = this.nsps;
    const nmax = this.nmax;
    const dd = this.dd;
    const nref = NN * nsps;
    const refRe = new Float64Array(nref);
    const refIm = new Float64Array(nref);
    const bfpi = (TAU * f0) / RX_SAMPLE_RATE;
    let phi = 0;
    for (let i = 0, o = 0; i < NN; i++) {
      const dphi = bfpi + (TAU * itone[i]!) / nsps;
      for (let k = 0; k < nsps; k++, o++) {
        refRe[o] = Math.cos(phi);
        refIm[o] = Math.sin(phi);
        phi = (phi + dphi) % TAU;
      }
    }

    const nstart = Math.trunc(dt * RX_SAMPLE_RATE);
    const refStart = nstart < 0 ? -nstart : 0;
    const ddStart = nstart > 0 ? nstart : 0;
    const size = Math.max(0, Math.min(nref - refStart, nmax - ddStart));

    const cr = new Float64Array(nmax);
    const ci = new Float64Array(nmax);
    for (let i = 0; i < size; i++) {
      const x = dd[ddStart + i]!;
      cr[i] = x * refRe[refStart + i]!;
      ci[i] = -x * refIm[refStart + i]!;
    }
    const fft = complexFft(nmax);
    fft.transform(cr, ci);
    for (let i = 0; i < nmax; i++) {
      const ar = cr[i]!, ai = ci[i]!;
      const br = this.filterRe[i]!, bi = this.filterIm[i]!;
      cr[i] = ar * br - ai * bi;
      ci[i] = ar * bi + ai * br;
    }
    fft.transform(cr, ci, true);
    for (let i = 0; i < size; i++) {
      const rr = refRe[refStart + i]!, ri = refIm[refStart + i]!;
      dd[ddStart + i]! -= 2 * (cr[i]! * rr - ci[i]! * ri);
    }
  }
}

/**
 * polyfit.f90 (mode 0, five terms) exactly as the Fortran does it, Cramer's rule over
 * determ.f90's unpivoted elimination, in double precision on the raw bin offsets. That is
 * badly conditioned (x⁸ sums reach 10²⁵), but the baseline, and so every SNR JS8Call 2.2
 * reports, is whatever this arithmetic produces, so it is reproduced rather than improved.
 */
function polyfit4(xs: readonly number[], ys: readonly number[]): Float64Array {
  const nterms = 5;
  const nmax = 2 * nterms - 1;
  const sumx = new Float64Array(nmax);
  const sumy = new Float64Array(nterms);
  for (let i = 0; i < xs.length; i++) {
    const xi = xs[i]!;
    let xterm = 1;
    for (let n = 0; n < nmax; n++) {
      sumx[n]! += xterm;
      xterm *= xi;
    }
    let yterm = ys[i]!;
    for (let n = 0; n < nterms; n++) {
      sumy[n]! += yterm;
      yterm *= xi;
    }
  }
  const matrix = (col: number): number[][] =>
    Array.from({ length: nterms }, (_, j) => Array.from({ length: nterms }, (_, k) => (k === col ? sumy[j]! : sumx[j + k]!)));
  const a = new Float64Array(nterms);
  const delta = determ(matrix(-1));
  if (delta === 0) return a;
  for (let l = 0; l < nterms; l++) a[l] = determ(matrix(l)) / delta;
  return a;
}

/** determ.f90: determinant by elimination without pivoting (a column swap only on a zero diagonal). */
function determ(m: number[][]): number {
  const n = m.length;
  let det = 1;
  for (let k = 0; k < n; k++) {
    if (m[k]![k] === 0) {
      let j = k;
      while (j < n && m[k]![j] === 0) j++;
      if (j === n) return 0;
      for (let i = k; i < n; i++) {
        const t = m[i]![j]!;
        m[i]![j] = m[i]![k]!;
        m[i]![k] = t;
      }
      det = -det;
    }
    det *= m[k]![k]!;
    for (let i = k + 1; i < n; i++) for (let j = k + 1; j < n; j++) m[i]![j]! -= (m[i]![k]! * m[k]![j]!) / m[k]![k]!;
  }
  return det;
}

/** r4, r2, r1 bit metrics for one symbol's eight tone values. */
function metrics(ps: Float64Array, out: Float64Array, o: number): void {
  const p0 = ps[0]!, p1 = ps[1]!, p2 = ps[2]!, p3 = ps[3]!, p4 = ps[4]!, p5 = ps[5]!, p6 = ps[6]!, p7 = ps[7]!;
  out[o] = Math.max(p4, p5, p6, p7) - Math.max(p0, p1, p2, p3);
  out[o + 1] = Math.max(p2, p3, p6, p7) - Math.max(p0, p1, p4, p5);
  out[o + 2] = Math.max(p1, p3, p5, p7) - Math.max(p0, p2, p4, p6);
}

/** normalizebmet then the 2.83 scale factor. */
function normalizeLlr(llr: Float64Array): void {
  let sum = 0;
  let sum2 = 0;
  for (const v of llr) {
    sum += v;
    sum2 += v * v;
  }
  const av = sum / llr.length;
  const av2 = sum2 / llr.length;
  const variance = av2 - av * av;
  const sig = Math.sqrt(variance > 0 ? variance : av2);
  for (let i = 0; i < llr.length; i++) llr[i] = (llr[i]! / sig) * 2.83;
}

const receivers = new Map<string, Js8Receiver>();

/**
 * Decode one period of 12 kHz audio whose first sample is the period boundary (JS8Call's
 * kpos = cycle start); signals are expected to begin at the submode's start delay. Audio
 * beyond one period is ignored and a short buffer is zero padded. Float samples are taken
 * as full scale ±1. Returns one entry per distinct frame (the best-SNR copy).
 */
export function decodeJs8(samples12k: ArrayLike<number>, submode: Js8Submode | Js8SubmodeParams, opts: Js8DecodeOptions = {}): Js8Decode[] {
  const p = js8Params(submode);
  let rx = receivers.get(p.name);
  if (!rx || typeof submode !== "string") {
    rx = new Js8Receiver(p);
    if (typeof submode === "string") receivers.set(p.name, rx);
  }
  return rx.decode(samples12k, opts);
}

export { K as JS8_INFO_BITS, N as JS8_CODEWORD_BITS };
