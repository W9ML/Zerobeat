/**
 * JTTY modem: frames to audio and back.
 *
 * A frame is 13 sync tones (WSJT-X's is13 array, chosen for low autocorrelation
 * sidelobes) then the 46 coded tones: 59 symbols at 31.25 baud, 1.888 s, four tones
 * 31.25 Hz apart, Gaussian-smoothed with BT = 2 (lib/jtty/gen_jttywave.f90). A
 * transmission is its frames back to back, one continuous-phase waveform.
 *
 * Receiving is untimed: frames can start anywhere. JttyReceiver keeps a running
 * spectrogram at an eighth-symbol hop, looks for the sync pattern at every hop and
 * every 7.8 Hz, refines each candidate in time and frequency, measures the 46 data
 * symbols and hands them to the list decoder. Consecutive frames at the same frequency
 * are joined into messages, which end at the end-of-message flag.
 *
 * Strong and weak signals together, as WSJT-X does (lib/jtty/subtract_jtty.f90 and the
 * two-pass sweep in jtty_mdecode.f90): every decoded frame is re-encoded and subtracted
 * from the audio, the search surface is rebuilt from the residual, and the candidates
 * are searched again, reaching back three quarter-frames so a weaker frame that started
 * under the strong one is found too.
 */
import { fft } from "../../dsp/dsp.ts";
import { decodeLadder, encodeTones, type Correlation } from "./fec.ts";
import { frameBits, packAtom, renderAtom, unpackFrame, AtomKind, type Atom } from "./source.ts";

export const IS13 = [0, 2, 2, 3, 0, 0, 3, 2, 1, 3, 1, 2, 0];
export const BAUD = 31.25;
export const FRAME_SYMBOLS = 59;
export const FRAME_MS = (FRAME_SYMBOLS / BAUD) * 1000; // 1888
const BT = 2.0;

// ---------------------------------------------------------------------------
// Transmit
// ---------------------------------------------------------------------------

/** Abramowitz & Stegun 7.1.26, |error| < 1.5e-7. */
function erf(x: number): number {
  const s = Math.sign(x);
  x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}

function gfskPulse(bt: number, t: number): number {
  const c = Math.PI * Math.sqrt(2 / Math.log(2));
  return 0.5 * (erf(c * bt * (t + 0.5)) - erf(c * bt * (t - 0.5)));
}

/** Tones for a run of atoms: each frame is sync + 46 coded tones; the last one carries EOM. */
export function atomsToTones(atoms: Atom[]): number[] {
  const out: number[] = [];
  atoms.forEach((a, i) => {
    const w = packAtom(a);
    if (w === null) throw new Error(`cannot pack ${renderAtom(a)}`);
    out.push(...IS13, ...encodeTones(frameBits(w, i === atoms.length - 1)));
  });
  return out;
}

/** The GFSK phase of a tone sequence, sample by sample, as gen_jttywave builds it. */
function gfskPhase(tones: ArrayLike<number>, f0: number, sampleRate: number): Float64Array {
  const nsps = Math.round(sampleRate / BAUD);
  const nsym = tones.length;
  const pulse = new Float64Array(3 * nsps);
  for (let i = 0; i < 3 * nsps; i++) pulse[i] = gfskPulse(BT, (i + 1 - 1.5 * nsps) / nsps);
  const dphi = new Float64Array((nsym + 2) * nsps);
  const peak = (2 * Math.PI) / nsps;
  for (let j = 0; j < nsym; j++) {
    const ib = j * nsps;
    for (let i = 0; i < 3 * nsps; i++) dphi[ib + i]! += peak * pulse[i]! * tones[j]!;
  }
  // Dummy symbols at the ends with the first and last tone.
  for (let i = 0; i < 2 * nsps; i++) dphi[i]! += peak * tones[0]! * pulse[nsps + i]!;
  for (let i = 0; i < 2 * nsps; i++) dphi[nsym * nsps + i]! += peak * tones[nsym - 1]! * pulse[i]!;
  const step = (2 * Math.PI * f0) / sampleRate;
  const out = new Float64Array(nsym * nsps);
  let phi = 0;
  for (let k = 0; k < out.length; k++) {
    out[k] = phi;
    phi = (phi + dphi[nsps + k]! + step) % (2 * Math.PI);
  }
  return out;
}

/** The transmit waveform: f0 is the lowest tone, in Hz. */
export function tonesToWaveform(tones: number[], f0: number, sampleRate: number): Float32Array {
  const nsps = Math.round(sampleRate / BAUD);
  const phase = gfskPhase(tones, f0, sampleRate);
  const wave = new Float32Array(phase.length);
  for (let k = 0; k < wave.length; k++) wave[k] = Math.sin(phase[k]!);
  const ramp = Math.round(nsps / 8);
  for (let i = 0; i < ramp; i++) {
    const g = (1 - Math.cos((Math.PI * i) / ramp)) / 2;
    wave[i]! *= g;
    wave[wave.length - ramp + i]! *= 1 - g;
  }
  return wave;
}

// ---------------------------------------------------------------------------
// Receive
// ---------------------------------------------------------------------------

const RATE = 12_000;
const NSPS = 384; // samples per symbol at 12 kHz
const HOP = 48; // spectrogram hop: an eighth of a symbol
const PER_SYM = NSPS / HOP; // 8 columns per symbol
const NFFT = 1536; // 384-sample symbol zero-padded 4x: 7.8125 Hz bins, tones 4 bins apart
const BIN_HZ = RATE / NFFT;
const MAX_BIN = Math.ceil(3200 / BIN_HZ);
const FRAME_SAMPLES = FRAME_SYMBOLS * NSPS; // 22656
const RING = RATE * 10;
// Spectrogram sync ratio (pure noise ≈ 1, a clean frame ≈ 4). The SNR admission below works out
// to about 2 here, so 1.8 lets every admissible frame through and little else.
const SYNC_THRESHOLD = 2.0;
// Admission, as WSJT-X's jtty_mdecode: near the operator's receive frequency more than
// 6 of 13 sync tones right and SNR ≥ 4.6; elsewhere more than 8 and SNR ≥ 5.
const NEAR = { sync: 7, snr: 4.6 };
const WIDE = { sync: 9, snr: 5 };
const MIN_SYNC_SHARE = 0.4; // share of sync-symbol energy in the expected tones (noise: 0.25)
const SCAN_EVERY = 3_000; // samples: a quarter second
const CANDIDATES_PER_PASS = 10;
// WSJT-X reaches back up to three quarter-frame search windows after a subtraction.
const RETRO_SAMPLES = Math.round((3 * FRAME_SAMPLES) / 4);
// A decoded frame blocks new candidates this close to it (WSJT-X's nfz, 10 Hz).
const SAME_SIGNAL_HZ = 10;
// SNR as WSJT-X reports it: in 2500 Hz, never below -17 dB.
const SNR_REF_DB = 10 * Math.log10(2500 / BAUD);
const SNR_FLOOR_DB = -17;

// Subtraction: the channel gain is smoothed over two symbols with a cos² window (subtract_jtty's nfilt).
const SUB_N = 32_768; // power of two ≥ a frame plus the filter
const NFILT = 2 * NSPS;
let subFilter: { re: Float32Array; im: Float32Array; norm: Float32Array } | null = null;

function ifftInPlace(re: Float32Array, im: Float32Array): void {
  for (let i = 0; i < im.length; i++) im[i] = -im[i]!;
  fft(re, im);
  const g = 1 / re.length;
  for (let i = 0; i < re.length; i++) {
    re[i]! *= g;
    im[i] = -im[i]! * g;
  }
}

/** Circular convolution of (re, im) with the smoothing window, in place. */
function smooth(re: Float32Array, im: Float32Array, h: { re: Float32Array; im: Float32Array }): void {
  fft(re, im);
  for (let i = 0; i < re.length; i++) {
    const a = re[i]!;
    const b = im[i]!;
    re[i] = a * h.re[i]! - b * h.im[i]!;
    im[i] = a * h.im[i]! + b * h.re[i]!;
  }
  ifftInPlace(re, im);
}

function subtractionFilter(): { re: Float32Array; im: Float32Array; norm: Float32Array } {
  if (subFilter) return subFilter;
  const re = new Float32Array(SUB_N);
  const im = new Float32Array(SUB_N);
  let sum = 0;
  for (let j = -NFILT / 2; j <= NFILT / 2; j++) sum += Math.cos((Math.PI * j) / NFILT) ** 2;
  for (let j = -NFILT / 2; j <= NFILT / 2; j++) re[(j + SUB_N) % SUB_N] = Math.cos((Math.PI * j) / NFILT) ** 2 / sum;
  fft(re, im);
  const h = { re, im };
  // The window's own smoothing of a frame-long gate: dividing by it keeps the gain right
  // at the frame's ends, where WSJT-X's estimate falls to half.
  const nr = new Float32Array(SUB_N);
  const ni = new Float32Array(SUB_N);
  nr.fill(1, 0, FRAME_SAMPLES);
  smooth(nr, ni, h);
  subFilter = { re, im, norm: nr };
  return subFilter;
}

export interface JttyFrame {
  /** Absolute sample index (12 kHz) where the frame's first sync symbol starts. */
  at: number;
  /** Wall-clock time of that sample, ms. */
  atMs: number;
  /** Lowest tone, Hz. */
  freqHz: number;
  snr: number;
  atom: Atom;
  /** The atom's text; TEXT5 padding replaced with spaces as sent. */
  text: string;
  eom: boolean;
  /** Coherent block length that decoded it (1, 2 or 4). */
  coherent: number;
}

/** 1536-point FFT of a 384-sample frame as three 512-point FFTs. */
class Fft1536 {
  private readonly re = [new Float32Array(512), new Float32Array(512), new Float32Array(512)];
  private readonly im = [new Float32Array(512), new Float32Array(512), new Float32Array(512)];
  private readonly cos = new Float64Array(NFFT);
  private readonly sin = new Float64Array(NFFT);
  constructor() {
    for (let k = 0; k < NFFT; k++) {
      this.cos[k] = Math.cos((-2 * Math.PI * k) / NFFT);
      this.sin[k] = Math.sin((-2 * Math.PI * k) / NFFT);
    }
  }
  /** Power in bins 0..maxBin of x[off .. off+384) zero-padded to 1536. */
  power(x: Float32Array, off: number, ringLen: number, out: Float32Array, maxBin: number): void {
    for (let r = 0; r < 3; r++) {
      const re = this.re[r]!;
      const im = this.im[r]!;
      re.fill(0);
      im.fill(0);
      for (let m = 0; 3 * m + r < NSPS; m++) re[m] = x[(off + 3 * m + r) % ringLen]!;
      fft(re, im);
    }
    for (let k = 0; k <= maxBin; k++) {
      const km = k & 511;
      let sr = this.re[0]![km]!;
      let si = this.im[0]![km]!;
      for (let r = 1; r < 3; r++) {
        const w = (r * k) % NFFT;
        const fr = this.re[r]![km]!;
        const fi = this.im[r]![km]!;
        sr += fr * this.cos[w]! - fi * this.sin[w]!;
        si += fr * this.sin[w]! + fi * this.cos[w]!;
      }
      out[k] = sr * sr + si * si;
    }
  }
}

interface Slot {
  freqHz: number;
  nextAt: number; // where its next frame would start
  /** The atoms in order; null where frames were missed. */
  atoms: (Atom | null)[];
  frames: JttyFrame[];
  done: boolean;
}

export interface JttyMessage {
  id: number;
  freqHz: number;
  startMs: number;
  updatedMs: number;
  snr: number;
  text: string;
  complete: boolean;
  frames: number;
}

/** Frames a weak transmission may lose in a row and still read as one line. */
const MAX_MISSED_FRAMES = 8;

/** Joins frames at one frequency into the text a station is sending. */
export class JttyAssembler {
  private slots = new Map<number, Slot & { id: number }>();
  private nextId = 1;

  add(f: JttyFrame): JttyMessage {
    let slot: (Slot & { id: number }) | null = null;
    let missed = 0;
    for (const s of this.slots.values()) {
      if (s.done || Math.abs(s.freqHz - f.freqHz) > 12) continue;
      // The next frame of a transmission starts right where the last one ended. A weak
      // signal loses frames: then it starts a whole number of frames later. Up to eight
      // missed frames join the same line, marked "…", instead of starting a new one.
      const d = f.at - s.nextAt;
      const k = Math.round(d / FRAME_SAMPLES);
      if (k >= 0 && k <= MAX_MISSED_FRAMES && Math.abs(d - k * FRAME_SAMPLES) <= NSPS * 2 && (!slot || k < missed)) {
        slot = s;
        missed = k;
        if (k === 0) break;
      }
    }
    if (!slot) {
      slot = { id: this.nextId++, freqHz: f.freqHz, nextAt: 0, atoms: [], frames: [], done: false };
      this.slots.set(slot.id, slot);
    }
    if (missed > 0) slot.atoms.push(null);
    slot.atoms.push(f.atom);
    slot.frames.push(f);
    slot.nextAt = f.at + FRAME_SAMPLES;
    slot.freqHz = (slot.freqHz * (slot.frames.length - 1) + f.freqHz) / slot.frames.length;
    if (f.eom) slot.done = true;
    // Forget old slots.
    for (const [id, s] of this.slots) if (f.at - s.nextAt > RATE * 60) this.slots.delete(id);
    let text = "";
    for (const a of slot.atoms) {
      if (a === null) text = `${text.trimEnd()}… `;
      else text += a.kind === AtomKind.Text5 ? renderAtom(a) : renderAtom(a) + " ";
    }
    return {
      id: slot.id,
      freqHz: Math.round(slot.freqHz),
      startMs: slot.frames[0]!.atMs,
      updatedMs: f.atMs,
      snr: Math.max(...slot.frames.map((x) => x.snr)),
      text: text.trimEnd().slice(0, 80),
      complete: slot.done,
      frames: slot.frames.length,
    };
  }
}

/**
 * Streaming JTTY receiver. push() 12 kHz audio as it arrives; frames come out through
 * the callback, typically within a few hundred ms of their last symbol.
 */
export class JttyReceiver {
  private readonly ring = new Float32Array(RING);
  private total = 0; // samples received
  private t0Ms: number | null = null; // wall time of sample 0
  private cols: Float32Array[] = []; // spectrogram columns, by absolute column index
  private colBase = 0; // absolute index of cols[0]
  private nextCol = 0;
  private scanned = 0; // next column to look for sync at
  private readonly fft = new Fft1536();
  private decoded: { at: number; freqHz: number }[] = [];
  /** The operator's receive frequency and tolerance: candidates here get the easier admission. */
  rxHz = 1500;
  rxTolHz = 50;
  private lastScanAt = 0;
  /** Where the next frame of a message in progress should start. */
  private expect: { at: number; freqHz: number }[] = [];
  minHz = 200;
  maxHz = 3000;
  /** Set while we transmit, so our own signal is not decoded. */
  muted = false;
  /** Subtract each decoded frame and search the residual (off only to measure what it buys). */
  subtraction = true;
  private subtractedAt: number[] = [];

  constructor(private readonly onFrame: (f: JttyFrame) => void) {}

  reset(): void {
    this.total = 0;
    this.t0Ms = null;
    this.cols = [];
    this.colBase = 0;
    this.nextCol = 0;
    this.scanned = 0;
    this.decoded = [];
    this.expect = [];
    this.lastScanAt = 0;
  }

  /** Audio at 12 kHz; `firstSampleMs` is the wall time of samples[0]. */
  push(samples: Float32Array, firstSampleMs: number): void {
    if (this.t0Ms === null) this.t0Ms = firstSampleMs - (this.total / RATE) * 1000;
    for (let i = 0; i < samples.length; i++) this.ring[(this.total + i) % RING] = this.muted ? 0 : samples[i]!;
    this.total += samples.length;
    // Spectrogram columns for every complete 384-sample window.
    while (this.nextCol * HOP + NSPS <= this.total) {
      const col = new Float32Array(MAX_BIN + 1);
      this.fft.power(this.ring, (this.nextCol * HOP) % RING, RING, col, MAX_BIN);
      this.cols.push(col);
      this.nextCol++;
    }
    // Keep about six seconds of columns.
    const keep = Math.ceil((RATE * 6) / HOP);
    if (this.cols.length > keep) {
      const drop = this.cols.length - keep;
      this.cols.splice(0, drop);
      this.colBase += drop;
    }
    if (this.total - this.lastScanAt >= SCAN_EVERY) {
      this.lastScanAt = this.total;
      this.scan();
    }
  }

  private col(c: number): Float32Array | null {
    return this.cols[c - this.colBase] ?? null;
  }

  /** Sync search over every column whose whole frame is now in the buffer. */
  private scan(): void {
    const lastStart = Math.floor((this.total - FRAME_SAMPLES) / HOP); // newest column a full frame fits from
    // Local maxima need a few columns either side; leave the newest four for next time.
    const end = lastStart - 4;
    if (end <= this.scanned) return;
    const first = this.scanned;
    this.scanned = end + 1;
    this.subtractedAt = [];
    for (const k of this.candidates(first, end)) this.tryDecode(k.c * HOP, k.b * BIN_HZ, false);
    // Sticky retry: a message's next frame where it must be, even if its sync was weak.
    for (const e of this.expect.splice(0)) {
      if (e.at + FRAME_SAMPLES > this.total) {
        this.expect.push(e);
        continue;
      }
      this.tryDecode(e.at, e.freqHz, true);
    }
    // Second pass over the residual, once, if anything was subtracted: from three
    // quarter-frames before the earliest subtracted frame, so weaker frames that began
    // under it (and failed while it was there) are tried again.
    if (this.subtractedAt.length) {
      const back = Math.floor((Math.min(...this.subtractedAt) - RETRO_SAMPLES) / HOP);
      const from = Math.max(this.colBase + 4, Math.min(first, back));
      for (const k of this.candidates(from, end)) this.tryDecode(k.c * HOP, k.b * BIN_HZ, false);
    }
    // Forget decodes that can no longer collide with new candidates.
    this.decoded = this.decoded.filter((d) => this.total - d.at < RATE * 20);
  }

  /** Sync peaks among frame starts in columns [first, end], strongest first. */
  private candidates(first: number, end: number): { c: number; b: number; r: number }[] {
    const b0 = Math.ceil(this.minHz / BIN_HZ);
    const b1 = Math.min(MAX_BIN - 12, Math.floor(this.maxHz / BIN_HZ));
    const from = Math.max(first - 4, this.colBase);
    const nb = b1 - b0 + 1;
    const ratios: Float32Array[] = [];
    for (let c = from; c <= end + 4; c++) {
      const r = new Float32Array(nb);
      const cs: Float32Array[] = [];
      let ok = true;
      for (let j = 0; j < 13; j++) {
        const col = this.col(c + PER_SYM * j);
        if (!col) {
          ok = false;
          break;
        }
        cs.push(col);
      }
      if (ok) {
        for (let b = b0; b <= b1; b++) {
          let s = 0;
          let n = 0;
          for (let j = 0; j < 13; j++) {
            const col = cs[j]!;
            s += col[b + 4 * IS13[j]!]!;
            n += col[b]! + col[b + 4]! + col[b + 8]! + col[b + 12]!;
          }
          r[b - b0] = n > 0 ? (4 * s) / n : 0;
        }
      }
      ratios.push(r);
    }
    // Peaks: above threshold and the largest within ±4 columns and ±2 bins.
    const cands: { c: number; b: number; r: number }[] = [];
    for (let c = Math.max(from + 4, first); c <= end; c++) {
      const row = ratios[c - from]!;
      for (let i = 0; i < nb; i++) {
        const v = row[i]!;
        if (v < SYNC_THRESHOLD) continue;
        let peak = true;
        for (let dc = -4; dc <= 4 && peak; dc++) {
          const rr = ratios[c - from + dc];
          if (!rr) continue;
          for (let di = -2; di <= 2; di++) {
            if (dc === 0 && di === 0) continue;
            const w = rr[i + di];
            if (w !== undefined && w > v) {
              peak = false;
              break;
            }
          }
        }
        if (peak) cands.push({ c, b: i + b0, r: v });
      }
    }
    cands.sort((a, b) => b.r - a.r);
    return cands.slice(0, CANDIDATES_PER_PASS);
  }

  /**
   * Remove a decoded frame from the audio (subtract_jtty): rebuild its waveform from the
   * error-corrected tones, estimate the complex gain against the audio, smooth it over
   * two symbols, subtract, and redo the spectrogram columns it touched.
   */
  private subtract(at: number, f: number, tones: number[]): void {
    const h = subtractionFilter();
    const phase = gfskPhase(tones, f, RATE);
    const cos = new Float64Array(FRAME_SAMPLES);
    const sin = new Float64Array(FRAME_SAMPLES);
    const re = new Float32Array(SUB_N);
    const im = new Float32Array(SUB_N);
    for (let i = 0; i < FRAME_SAMPLES; i++) {
      const c = Math.cos(phase[i]!);
      const sn = Math.sin(phase[i]!);
      cos[i] = c;
      sin[i] = sn;
      const x = this.ring[(at + i) % RING]!;
      re[i] = x * c;
      im[i] = -x * sn;
    }
    smooth(re, im, h);
    // The audio is real: x ≈ Re(g·e^{iφ}) and the low-passed x·e^{-iφ} is g/2, hence the 2.
    for (let i = 0; i < FRAME_SAMPLES; i++) {
      const g = 2 / h.norm[i]!;
      const idx = (at + i) % RING;
      this.ring[idx] = this.ring[idx]! - g * (re[i]! * cos[i]! - im[i]! * sin[i]!);
    }
    const c0 = Math.max(this.colBase, Math.floor((at - NSPS) / HOP) + 1);
    const c1 = Math.min(this.nextCol - 1, Math.floor((at + FRAME_SAMPLES) / HOP));
    for (let c = c0; c <= c1; c++) {
      const col = this.cols[c - this.colBase];
      if (col) this.fft.power(this.ring, (c * HOP) % RING, RING, col, MAX_BIN);
    }
    this.subtractedAt.push(at);
  }

  /** Baseband samples x(n)·e^{-i2πfn/fs} for n in [start, start+len). */
  private baseband(start: number, len: number, f: number): { re: Float64Array; im: Float64Array } {
    const re = new Float64Array(len);
    const im = new Float64Array(len);
    // A rotating phasor, renormalized now and then, instead of sin/cos per sample.
    const w = (2 * Math.PI * f) / RATE;
    const cw = Math.cos(w);
    const sw = Math.sin(w);
    let pr = 1;
    let pi = 0;
    let idx = ((start % RING) + RING) % RING;
    for (let n = 0; n < len; n++) {
      const x = this.ring[idx]!;
      re[n] = x * pr;
      im[n] = -x * pi;
      const nr = pr * cw - pi * sw;
      pi = pr * sw + pi * cw;
      pr = nr;
      if ((n & 1023) === 1023) {
        const g = 1 / Math.hypot(pr, pi);
        pr *= g;
        pi *= g;
      }
      if (++idx === RING) idx = 0;
    }
    return { re, im };
  }

  /** Complex correlation of symbol `j` (from `off`) against tone k, phase-continuous within the frame. */
  private static readonly TONE_COS = Array.from({ length: 4 }, (_, k) => Float64Array.from({ length: NSPS }, (_, m) => Math.cos((2 * Math.PI * k * m) / NSPS)));
  private static readonly TONE_SIN = Array.from({ length: 4 }, (_, k) => Float64Array.from({ length: NSPS }, (_, m) => Math.sin((2 * Math.PI * k * m) / NSPS)));
  private symbols(bb: { re: Float64Array; im: Float64Array }, off: number, count: number): { re: Float64Array; im: Float64Array } {
    const zr = new Float64Array(count * 4);
    const zi = new Float64Array(count * 4);
    for (let j = 0; j < count; j++) {
      const base = off + j * NSPS;
      for (let k = 0; k < 4; k++) {
        const c = JttyReceiver.TONE_COS[k]!;
        const s = JttyReceiver.TONE_SIN[k]!;
        let ar = 0;
        let ai = 0;
        for (let m = 0; m < NSPS; m++) {
          const xr = bb.re[base + m]!;
          const xi = bb.im[base + m]!;
          // (xr + i xi) · (c - i s)
          ar += xr * c[m]! + xi * s[m]!;
          ai += xi * c[m]! - xr * s[m]!;
        }
        zr[j * 4 + k] = ar;
        zi[j * 4 + k] = ai;
      }
    }
    return { re: zr, im: zi };
  }

  private tryDecode(at: number, f: number, continuation: boolean): void {
    for (const d of this.decoded) {
      if (Math.abs(d.freqHz - f) < SAME_SIGNAL_HZ && Math.abs(d.at - at) < FRAME_SAMPLES - NSPS * 2) return; // inside a decoded frame
    }
    if (at < this.total - RING + FRAME_SAMPLES) return;
    // Refine: ±4 Hz in 1 Hz steps, ±24 samples in 6-sample steps, on the sync symbols.
    let best = { f, at, score: -1 };
    const span = 13 * NSPS + 48;
    let cacheF = NaN;
    let cache: { re: Float64Array; im: Float64Array } | null = null;
    const trial = (ff: number, tt: number) => {
      if (ff !== cacheF) {
        cache = this.baseband(at - 24, span + 24, ff);
        cacheF = ff;
      }
      const off = tt - (at - 24);
      if (off < 0 || off + 13 * NSPS > span + 24) return;
      const z = this.symbols(cache!, off, 13);
      let s = 0;
      let tot = 0;
      for (let j = 0; j < 13; j++) {
        for (let k = 0; k < 4; k++) {
          const p = z.re[j * 4 + k]! ** 2 + z.im[j * 4 + k]! ** 2;
          tot += p;
          if (k === IS13[j]) s += p;
        }
      }
      const score = tot > 0 ? s / tot : 0;
      if (score > best.score) best = { f: ff, at: tt, score };
    };
    trial(f, at);
    if (best.score < MIN_SYNC_SHARE && !continuation) return; // nothing there
    for (let df = -4; df <= 4; df += 2) for (let dt = -24; dt <= 24; dt += 12) if (df || dt) trial(f + df, at + dt);
    // A frame scores well above the 0.25 of pure noise; skip the rest early.
    if (best.score < MIN_SYNC_SHARE && !continuation) return;
    const c0 = best;
    for (let df = -1; df <= 1; df++) for (let dt = -6; dt <= 6; dt += 6) if (df || dt) trial(c0.f + df, c0.at + dt);
    // Hard sync check and SNR, as WSJT-X: more than 6 of 13 sync tones right.
    const bb = this.baseband(best.at, FRAME_SAMPLES, best.f);
    const sync = this.symbols(bb, 0, 13);
    let right = 0;
    let pt = 0;
    let pa = 0;
    for (let j = 0; j < 13; j++) {
      let kmax = 0;
      let pmax = -1;
      for (let k = 0; k < 4; k++) {
        const p = sync.re[j * 4 + k]! ** 2 + sync.im[j * 4 + k]! ** 2;
        pa += p;
        if (k === IS13[j]) pt += p;
        if (p > pmax) {
          pmax = p;
          kmax = k;
        }
      }
      if (kmax === IS13[j]) right++;
    }
    const pn = (pa - pt) / 3;
    const snrDb = pn > 0 ? 10 * Math.log10(pt / pn) : -99;
    const near = continuation || Math.abs(best.f - this.rxHz) <= this.rxTolHz;
    const gate = near ? NEAR : WIDE;
    if (right < gate.sync || snrDb < gate.snr) return;
    const data = this.symbols(bb, 13 * NSPS, 46);
    // Normalize so the decoder's metrics are on a sensible scale.
    let e = 0;
    for (let i = 0; i < data.re.length; i++) e += data.re[i]! ** 2 + data.im[i]! ** 2;
    const k = e > 0 ? 1 / Math.sqrt(e / data.re.length) : 1;
    const z: Correlation = { re: data.re.map((v) => v * k), im: data.im.map((v) => v * k) };
    const r = decodeLadder(z);
    if (!r) return;
    const back = unpackFrame(r.payload);
    if (!back) return;
    // SNR the way WSJT-X reports it: signal over noise in the decoded tones of all 59
    // symbols, referred to 2500 Hz (jtty_mdecode's decode_and_merge).
    const coded = encodeTones(r.payload);
    for (let j = 0; j < 46; j++) {
      for (let k = 0; k < 4; k++) {
        const p = data.re[j * 4 + k]! ** 2 + data.im[j * 4 + k]! ** 2;
        pa += p;
        if (k === coded[j]) pt += p;
      }
    }
    const pn2 = (pa - pt) / 3;
    const snr = Math.round(pn2 > 0 && pt > pn2 ? Math.max(10 * Math.log10((pt - pn2) / pn2) - SNR_REF_DB, SNR_FLOOR_DB) : SNR_FLOOR_DB);
    if (this.subtraction) this.subtract(best.at, best.f, [...IS13, ...coded]);
    this.decoded.push({ at: best.at, freqHz: best.f });
    if (!back.eom) this.expect.push({ at: best.at + FRAME_SAMPLES, freqHz: best.f });
    const atMs = (this.t0Ms ?? 0) + (best.at / RATE) * 1000;
    this.onFrame({ at: best.at, atMs, freqHz: Math.round(best.f * 10) / 10, snr, atom: back.atom, text: renderAtom(back.atom), eom: back.eom, coherent: r.coherent });
  }
}

