/**
 * WSPR-2 decoder, a port of wsprd (WSJT-X lib/wsprd/wsprd.c, K1JT and K9AN) for one
 * 2-minute period of 12 kHz audio that starts at the even minute.
 *
 * The steps, in wsprd's order:
 *   1. Downsample: one FFT of the first 114 s, keep 1500 +/- 187.5 Hz, inverse FFT
 *      -> 46080 complex samples at 375 Hz (256 per symbol).
 *   2. Spectrum: 512-point FFTs over two symbols, stepped by half a symbol; average,
 *      smooth over 7 bins (5.1 Hz), take the 30th percentile as the noise floor. Every
 *      local maximum within +/-110 Hz (+/-150 wideband) is a candidate, with its SNR in
 *      2500 Hz (10 log10(peak/noise - 1) - 26.3 dB).
 *   3. Coarse search on the spectrogram: +/-2 bins, -10..21 half-symbols of lag (about
 *      -1.4 .. +6.7 s of DT), drift -4..4 Hz over the transmission, by sync correlation.
 *   4. Refine on the time series: lag +/-128 then +/-32 samples, frequency in 0.25 Hz then
 *      0.05 Hz steps, drift +/-0.5 Hz.
 *   5. For each distinct candidate with enough sync: noncoherent soft symbols (later
 *      passes also coherent over 2 and 3 symbol blocks), deinterleave, Fano decode, and
 *      if that fails, try again with the start nudged by up to +/-64 samples.
 *   6. Unpack and sanity-check; subtract the decoded signal (amplitude and phase tracked
 *      through a 1 s low-pass) so weaker stations underneath can be found.
 *   7. A second pass on the residual (skipped if the first decoded nothing), then a
 *      third with block detection and no drift search.
 *
 * Arithmetic is double precision where wsprd uses float, except the subtraction's phase
 * accumulator (see subtractSignal); on WSJT-X's sample recording this reproduces
 * wsprd's decodes, SNRs, DTs, frequencies and even its Fano cycle counts. Deliberate
 * deviations: the decoded signal is subtracted using the decoded bits rather than by
 * re-encoding the printed text (identical except for a type 3 message with an unknown
 * hash, which wsprd re-encodes as the hash of "..."), and WSJT-X's optional OSD
 * fallback (-o) and quick mode (-q) are not ported.
 */

import { WsprHashTable, unpackWspr, type WsprMessage, type WsprMessageType } from "./codec.ts";
import { WSPR_SYNC as PR3, channelTones, deinterleave, fano, fanoMetricTable } from "./fec.ts";
import { fftMixed } from "./fft.ts";

export interface WsprDecodeOptions {
  /** Dial frequency in Hz, added to the reported audio frequency. */
  dialHz?: number;
  /** wsprd -w: search +/-150 Hz around 1500 Hz instead of +/-110 Hz. */
  wideband?: boolean;
  /** wsprd -d: also try every third bin above the SNR floor, not just the peaks. */
  deep?: boolean;
  /**
   * 3 (default, as wsprd): two subtraction passes plus a block-detection pass.
   * 2 = wsprd -B (no block detection), 1 = wsprd -s (one pass, no subtraction).
   */
  passes?: number;
  /** Callsign hashes for type 3 messages; learns from this period's type 1/2 decodes. */
  hashTable?: WsprHashTable;
  /** Fano cycles per bit before giving up (wsprd -C; default 10000, WSJT-X uses 500 + OSD). */
  maxCycles?: number;
}

export interface WsprDecode {
  /** As wsprd prints it but with single spaces: "K1ABC FN42 37", "<PJ4/K1ABC> FK52UD 37". */
  message: string;
  type: WsprMessageType;
  /** Full callsign; for type 3 from the hash table, null if the hash is not known yet. */
  callsign: string | null;
  /** 4-character (type 1) or 6-character (type 3) locator; null for type 2. */
  grid: string | null;
  dbm: number;
  /** Centre of the four tones: audio Hz, plus dialHz when given. */
  freqHz: number;
  /** Start time minus 1 s (WSJT-X starts sending 1 s after the even minute). */
  dtSec: number;
  /** Frequency drift over the transmission, Hz (truncated, as wsprd prints it). */
  driftHz: number;
  /** Signal-to-noise ratio in 2500 Hz, dB, from the averaged spectrum (rounded, as wsprd). */
  snrDb: number;
  /** wsprd's sync metric, 0..1. */
  sync: number;
  /** Decoding pass that found it (1-3). */
  pass: number;
  /** Fano decoder cycles (wsprd's ALL_WSPR.TXT shows cycles / 81). */
  cycles: number;
}

const NFFT2 = 46080; // downsampled points
const NFFT1 = NFFT2 * 32; // 12 kHz FFT size
const NPOINTS_12K = 114 * 12000; // samples wsprd reads
const MAXPTS = 65536; // idat/qdat length in wsprd (zero beyond the data)
const DT = 1 / 375;
const DF = 375 / 256; // tone spacing
const DF_SPEC = 375 / 256 / 2; // spectrum bin
const TWOPIDT = 2 * Math.PI * DT;

// Performance-tuning constants from wsprd.c main().
const MINSYNC1 = 0.1;
const IIFAC = 8;
const SYMFAC = 50;
const MINRMS = 52.0 * (SYMFAC / 64.0);
const FANO_DELTA = 60;
const MIN_SNR = Math.pow(10, -8 / 10);
const SNR_SCALING = 26.3;

const METTAB = fanoMetricTable(0.45);

interface Cand {
  freq: number;
  snr: number;
  shift: number;
  drift: number;
  sync: number;
}

// ---------------------------------------------------------------------------------------
// Downsampling (readwavfile)

function downsample(samples: Float32Array): { id: Float64Array; qd: Float64Array } {
  const re = new Float64Array(NFFT1);
  const im = new Float64Array(NFFT1);
  const n = Math.min(samples.length, NPOINTS_12K);
  for (let i = 0; i < n; i++) re[i] = samples[i]!;
  fftMixed(re, im);
  const df = 12000 / NFFT1;
  const i0 = Math.trunc(1500 / df + 0.5);
  const nh2 = NFFT2 / 2;
  const br = new Float64Array(NFFT2);
  const bi = new Float64Array(NFFT2);
  for (let i = 0; i < NFFT2; i++) {
    let j = i0 + i;
    if (i > nh2) j -= NFFT2;
    br[i] = re[j]!;
    bi[i] = im[j]!;
  }
  fftMixed(br, bi, true);
  const id = new Float64Array(MAXPTS);
  const qd = new Float64Array(MAXPTS);
  for (let i = 0; i < NFFT2; i++) {
    id[i] = br[i]! / 1000;
    qd[i] = bi[i]! / 1000;
  }
  return { id, qd };
}

// ---------------------------------------------------------------------------------------
// Tone oscillators: e^(i 2 pi f t) for the four tones around fp, j = 0..256 samples,
// built by the same complex recurrence as wsprd.

const OSC_C = [new Float64Array(257), new Float64Array(257), new Float64Array(257), new Float64Array(257)];
const OSC_S = [new Float64Array(257), new Float64Array(257), new Float64Array(257), new Float64Array(257)];
const TONE_OFFSETS = [-1.5 * DF, -0.5 * DF, 0.5 * DF, 1.5 * DF];

function oscillators(fp: number, len: number): void {
  for (let t = 0; t < 4; t++) {
    const dphi = TWOPIDT * (fp + TONE_OFFSETS[t]!);
    const cd = Math.cos(dphi);
    const sd = Math.sin(dphi);
    const c = OSC_C[t]!;
    const s = OSC_S[t]!;
    c[0] = 1;
    s[0] = 0;
    for (let j = 1; j < len; j++) {
      c[j] = c[j - 1]! * cd - s[j - 1]! * sd;
      s[j] = c[j - 1]! * sd + s[j - 1]! * cd;
    }
  }
}

// Per-tone correlations of one symbol, filled by correlate().
const CI = new Float64Array(4);
const CQ = new Float64Array(4);

/** Correlate 256 samples from `start` against the four oscillators (wsprd skips k <= 0). */
function correlate(id: Float64Array, qd: Float64Array, np: number, start: number): void {
  const j0 = Math.max(0, 1 - start);
  const j1 = Math.min(256, np - start);
  const c0 = OSC_C[0]!, s0 = OSC_S[0]!, c1 = OSC_C[1]!, s1 = OSC_S[1]!;
  const c2 = OSC_C[2]!, s2 = OSC_S[2]!, c3 = OSC_C[3]!, s3 = OSC_S[3]!;
  let i0 = 0, q0 = 0, i1 = 0, q1 = 0, i2 = 0, q2 = 0, i3 = 0, q3 = 0;
  for (let j = j0; j < j1; j++) {
    const x = id[start + j]!;
    const y = qd[start + j]!;
    i0 += x * c0[j]! + y * s0[j]!;
    q0 += y * c0[j]! - x * s0[j]!;
    i1 += x * c1[j]! + y * s1[j]!;
    q1 += y * c1[j]! - x * s1[j]!;
    i2 += x * c2[j]! + y * s2[j]!;
    q2 += y * c2[j]! - x * s2[j]!;
    i3 += x * c3[j]! + y * s3[j]!;
    q3 += y * c3[j]! - x * s3[j]!;
  }
  CI[0] = i0; CQ[0] = q0;
  CI[1] = i1; CQ[1] = q1;
  CI[2] = i2; CQ[2] = q2;
  CI[3] = i3; CQ[3] = q3;
}

/**
 * sync_and_demodulate, modes 0 (best lag for fixed frequency) and 1 (best frequency for
 * fixed lag). Sync is sum over symbols of +/-((p1 + p3) - (p0 + p2)) by the sync bit,
 * divided by the total power, so 0..1.
 */
function syncSearch(
  id: Float64Array,
  qd: Float64Array,
  np: number,
  f1: number,
  ifmin: number,
  ifmax: number,
  fstep: number,
  shift1: number,
  lagmin: number,
  lagmax: number,
  lagstep: number,
  drift1: number,
  mode: 0 | 1,
): { sync: number; shift: number; freq: number } {
  if (mode === 0) {
    ifmin = 0;
    ifmax = 0;
    fstep = 0;
  } else {
    lagmin = shift1;
    lagmax = shift1;
  }
  let syncmax = -1e30;
  let bestShift = 0;
  let fbest = 0;
  for (let ifreq = ifmin; ifreq <= ifmax; ifreq++) {
    const f0 = f1 + ifreq * fstep;
    for (let lag = lagmin; lag <= lagmax; lag += lagstep) {
      let ss = 0;
      let totp = 0;
      let fplast = NaN;
      for (let i = 0; i < 162; i++) {
        const fp = f0 + ((drift1 / 2) * (i - 81)) / 81;
        if (i === 0 || fp !== fplast) {
          oscillators(fp, 256);
          fplast = fp;
        }
        correlate(id, qd, np, lag + i * 256);
        const p0 = Math.sqrt(CI[0]! * CI[0]! + CQ[0]! * CQ[0]!);
        const p1 = Math.sqrt(CI[1]! * CI[1]! + CQ[1]! * CQ[1]!);
        const p2 = Math.sqrt(CI[2]! * CI[2]! + CQ[2]! * CQ[2]!);
        const p3 = Math.sqrt(CI[3]! * CI[3]! + CQ[3]! * CQ[3]!);
        totp += p0 + p1 + p2 + p3;
        const cmet = p1 + p3 - (p0 + p2);
        ss = PR3[i] === 1 ? ss + cmet : ss - cmet;
      }
      ss /= totp;
      if (ss > syncmax) {
        syncmax = ss;
        bestShift = lag;
        fbest = f0;
      }
    }
  }
  return { sync: syncmax, shift: bestShift, freq: fbest };
}

const IS = [new Float64Array(162), new Float64Array(162), new Float64Array(162), new Float64Array(162)];
const QS = [new Float64Array(162), new Float64Array(162), new Float64Array(162), new Float64Array(162)];
const CF = [new Float64Array(162), new Float64Array(162), new Float64Array(162), new Float64Array(162)];
const SF = [new Float64Array(162), new Float64Array(162), new Float64Array(162), new Float64Array(162)];
const FSYMB = new Float64Array(162);
const PBLK = new Float64Array(512);

/**
 * noncoherent_sequence_detection: soft symbols (0..255, 128 = unknown) for the code bits.
 * With nblock > 1 the tones of a block are combined coherently (the transmitter's phase
 * is continuous), each bit taking the best block hypothesis with that bit 1 minus the
 * best with it 0; bitmetric divides by the larger of the two.
 */
function softSymbols(
  id: Float64Array,
  qd: Float64Array,
  np: number,
  f0: number,
  lag: number,
  drift: number,
  nblock: number,
  bitmetric: boolean,
  out: Uint8Array,
): void {
  let fplast = NaN;
  for (let i = 0; i < 162; i++) {
    const fp = f0 + ((drift / 2) * (i - 81)) / 81;
    if (i === 0 || fp !== fplast) {
      oscillators(fp, 257);
      fplast = fp;
    }
    for (let t = 0; t < 4; t++) {
      CF[t]![i] = OSC_C[t]![256]!;
      SF[t]![i] = OSC_S[t]![256]!;
    }
    correlate(id, qd, np, lag + i * 256);
    for (let t = 0; t < 4; t++) {
      IS[t]![i] = CI[t]!;
      QS[t]![i] = CQ[t]!;
    }
  }
  const nseq = 1 << nblock;
  for (let i = 0; i < 162; i += nblock) {
    for (let j = 0; j < nseq; j++) {
      let xi = 0;
      let xq = 0;
      let cm = 1;
      let sm = 0;
      for (let ib = 0; ib < nblock; ib++) {
        const b = (j >> (nblock - 1 - ib)) & 1;
        const itone = PR3[i + ib]! + 2 * b;
        const is = IS[itone]![i + ib]!;
        const qs = QS[itone]![i + ib]!;
        xi += is * cm + qs * sm;
        xq += qs * cm - is * sm;
        const cf = CF[itone]![i + ib]!;
        const sf = SF[itone]![i + ib]!;
        const cmp = cf * cm - sf * sm;
        const smp = sf * cm + cf * sm;
        cm = cmp;
        sm = smp;
      }
      PBLK[j] = Math.sqrt(xi * xi + xq * xq);
    }
    for (let ib = 0; ib < nblock; ib++) {
      const imask = 1 << (nblock - 1 - ib);
      let xm1 = 0;
      let xm0 = 0;
      for (let j = 0; j < nseq; j++) {
        if ((j & imask) !== 0) {
          if (PBLK[j]! > xm1) xm1 = PBLK[j]!;
        } else if (PBLK[j]! > xm0) xm0 = PBLK[j]!;
      }
      let v = xm1 - xm0;
      if (bitmetric) v /= xm1 > xm0 ? xm1 : xm0;
      FSYMB[i + ib] = v;
    }
  }
  normalise(FSYMB, out);
}

/** Scale soft symbols to rms SYMFAC about their mean and offset to 0..255. */
function normalise(fsymb: Float64Array, out: Uint8Array): void {
  let fsum = 0;
  let f2sum = 0;
  for (let i = 0; i < 162; i++) {
    fsum += fsymb[i]! / 162;
    f2sum += (fsymb[i]! * fsymb[i]!) / 162;
  }
  const fac = Math.sqrt(f2sum - fsum * fsum);
  for (let i = 0; i < 162; i++) {
    let v = (SYMFAC * fsymb[i]!) / fac;
    if (v > 127) v = 127;
    if (v < -128) v = -128;
    out[i] = Number.isNaN(v) ? 128 : Math.trunc(v + 128);
  }
}

/**
 * subtract_signal2: estimate the complex amplitude of the decoded signal against a
 * unit reference, low-pass it (360-sample sine window, about 1 s), and subtract.
 */
function subtractSignal(
  id: Float64Array,
  qd: Float64Array,
  np: number,
  f0: number,
  shift0: number,
  drift0: number,
  tones: ArrayLike<number>,
): void {
  const nsym = 162;
  const nspersym = 256;
  const nfilt = 360;
  const nsig = nsym * nspersym;
  const nc2 = 45000;
  const refi = new Float64Array(nc2);
  const refq = new Float64Array(nc2);
  const ci = new Float64Array(nc2);
  const cq = new Float64Array(nc2);
  const cfi = new Float64Array(nc2);
  const cfq = new Float64Array(nc2);

  // The reference phase is accumulated in single precision, as wsprd does. Over 110 s
  // that drifts by a fraction of a radian, which the 1 s low-pass tracks anyway, but the
  // residual it leaves differs by about 1% from a double-precision one, and that is
  // enough to change which marginal signals the later passes decode. With the float
  // accumulator the residual matches wsprd's (its -c .c2 dump) to 6e-7, and so do the
  // decodes, down to the Fano cycle counts.
  const f = Math.fround;
  let phi = 0;
  for (let i = 0; i < nsym; i++) {
    const dphi = f(TWOPIDT * (f0 + ((drift0 / 2) * (i - nsym / 2)) / (nsym / 2) + (tones[i]! - 1.5) * DF));
    for (let j = 0; j < nspersym; j++) {
      const ii = nspersym * i + j;
      refi[ii] = Math.cos(phi);
      refq[ii] = Math.sin(phi);
      phi = f(phi + dphi);
    }
  }

  const w = new Float64Array(nfilt);
  const partialsum = new Float64Array(nfilt);
  let norm = 0;
  for (let i = 0; i < nfilt; i++) {
    w[i] = Math.sin((Math.PI * i) / (nfilt - 1));
    norm += w[i]!;
  }
  for (let i = 0; i < nfilt; i++) w[i] = w[i]! / norm;
  for (let i = 1; i < nfilt; i++) partialsum[i] = partialsum[i - 1]! + w[i]!;

  // s(t) * conj(r(t)), with nfilt zeros of padding in front
  for (let i = 0; i < nsig; i++) {
    const k = shift0 + i;
    if (k > 0 && k < np) {
      ci[i + nfilt] = id[k]! * refi[i]! + qd[k]! * refq[i]!;
      cq[i + nfilt] = qd[k]! * refi[i]! - id[k]! * refq[i]!;
    }
  }

  // Low-pass; only the outputs the subtraction reads (nfilt .. nfilt + nsig) are needed.
  const h = nfilt / 2;
  for (let i = nfilt; i < nfilt + nsig; i++) {
    let sr = 0;
    let si = 0;
    const base = i - h;
    for (let j = 0; j < nfilt; j++) {
      sr += w[j]! * ci[base + j]!;
      si += w[j]! * cq[base + j]!;
    }
    cfi[i] = sr;
    cfq[i] = si;
  }

  for (let i = 0; i < nsig; i++) {
    if (i < h) norm = partialsum[h + i]!;
    else if (i > nsig - 1 - h) norm = partialsum[h + nsig - 1 - i]!;
    else norm = 1;
    const k = shift0 + i;
    const j = i + nfilt;
    if (k > 0 && k < np) {
      id[k] = id[k]! - (cfi[j]! * refi[i]! - cfq[j]! * refq[i]!) / norm;
      qd[k] = qd[k]! - (cfi[j]! * refq[i]! + cfq[j]! * refi[i]!) / norm;
    }
  }
}

// ---------------------------------------------------------------------------------------

interface Found {
  key: string;
  message: WsprMessage;
  f1: number;
  shift: number;
  drift: number;
  snr: number;
  sync: number;
  pass: number;
  cycles: number;
}

/**
 * Decode one WSPR-2 period: `samples12k` is mono 12 kHz audio starting at the even
 * minute (the first 114 s are used; shorter input is zero-padded). Returns the decodes
 * in order of frequency, as wsprd prints them.
 */
export function decodeWspr(samples12k: Float32Array, opts: WsprDecodeOptions = {}): WsprDecode[] {
  const npasses = Math.max(1, Math.min(3, Math.trunc(opts.passes ?? 3)));
  const subtraction = npasses > 1;
  const maxCycles = opts.maxCycles ?? 10000;
  const hashTable = opts.hashTable ?? new WsprHashTable();
  const fmin = opts.wideband ? -150 : -110;
  const fmax = opts.wideband ? 150 : 110;

  const { id, qd } = downsample(samples12k);
  const np = NFFT2;

  // Spectrogram over two symbols, stepped by half a symbol.
  const nffts = 4 * Math.floor(np / 512) - 1;
  const ps = new Float64Array(512 * nffts); // ps[bin * nffts + time]
  const sps = new Float64Array(512 * nffts); // sqrt(ps), for the coarse search
  const win = new Float64Array(512);
  for (let i = 0; i < 512; i++) win[i] = Math.sin(0.006147931 * i);
  const fr = new Float64Array(512);
  const fi = new Float64Array(512);
  const symbols = new Uint8Array(162);

  const found: Found[] = [];
  let ndecodesPass = 0;

  for (let ipass = 0; ipass < npasses; ipass++) {
    if (ipass === 1 && ndecodesPass === 0 && npasses > 2) ipass = 2;
    let nblocksize: number;
    let maxdrift: number;
    let minsync2: number;
    if (ipass < 2) {
      nblocksize = 1;
      maxdrift = 4;
      minsync2 = 0.12;
    } else {
      nblocksize = 4; // block sizes 1, 2, 3, then 1 with bit-by-bit normalisation
      maxdrift = 0; // no drift, for a lower-variance frequency estimate
      minsync2 = 0.1;
    }
    ndecodesPass = 0;

    for (let i = 0; i < nffts; i++) {
      for (let j = 0; j < 512; j++) {
        const k = i * 128 + j;
        fr[j] = id[k]! * win[j]!;
        fi[j] = qd[k]! * win[j]!;
      }
      fftMixed(fr, fi);
      for (let j = 0; j < 512; j++) {
        const k = (j + 256) & 511;
        const p = fr[k]! * fr[k]! + fi[k]! * fi[k]!;
        ps[j * nffts + i] = p;
        sps[j * nffts + i] = Math.sqrt(p);
      }
    }

    const psavg = new Float64Array(512);
    for (let j = 0; j < 512; j++) {
      let s = 0;
      for (let i = 0; i < nffts; i++) s += ps[j * nffts + i]!;
      psavg[j] = s;
    }

    // Smooth over 7 bins and keep +/-150 Hz.
    const smspec = new Float64Array(411);
    for (let i = 0; i < 411; i++) {
      let s = 0;
      for (let j = -3; j <= 3; j++) s += psavg[256 - 205 + i + j]!;
      smspec[i] = s;
    }
    const sorted = Float64Array.from(smspec).sort();
    const noiseLevel = sorted[122]!; // 30th percentile
    for (let j = 0; j < 411; j++) {
      smspec[j] = smspec[j]! / noiseLevel - 1;
      if (smspec[j]! < MIN_SNR) smspec[j] = 0.1 * MIN_SNR;
    }

    let cands: Cand[] = [];
    for (let j = 1; j < 410; j++) {
      if (smspec[j]! > smspec[j - 1]! && smspec[j]! > smspec[j + 1]! && cands.length < 200) {
        cands.push({ freq: (j - 205) * DF_SPEC, snr: 10 * Math.log10(smspec[j]!) - SNR_SCALING, shift: 0, drift: 0, sync: 0 });
      }
    }
    if (opts.deep) {
      for (let j = 0; j < 411; j += 3) {
        if (smspec[j]! > MIN_SNR && cands.length < 200) {
          cands.push({ freq: (j - 205) * DF_SPEC, snr: 10 * Math.log10(smspec[j]!) - SNR_SCALING, shift: 0, drift: 0, sync: 0 });
        }
      }
    }
    cands = cands.filter((c) => c.freq >= fmin && c.freq <= fmax);
    // wsprd's bubble sort, strongest first (stable for equal SNR)
    for (let pass = 1; pass <= cands.length - 1; pass++) {
      for (let k = 0; k < cands.length - pass; k++) {
        if (cands[k]!.snr < cands[k + 1]!.snr) {
          const t = cands[k]!;
          cands[k] = cands[k + 1]!;
          cands[k + 1] = t;
        }
      }
    }

    // Coarse estimates of shift (DT), frequency and drift from the spectrogram. Drift is
    // linear, +/-drift/2 over the 162 symbols, zero at the centre.
    for (const c of cands) {
      let smax = -1e30;
      const if0 = Math.trunc(c.freq / DF_SPEC + 256);
      for (let ifr = if0 - 2; ifr <= if0 + 2; ifr++) {
        for (let k0 = -10; k0 < 22; k0++) {
          for (let idrift = -maxdrift; idrift <= maxdrift; idrift++) {
            let ss = 0;
            let pow = 0;
            for (let k = 0; k < 162; k++) {
              const ifd = Math.trunc(ifr + (((k - 81) / 81) * idrift) / (2 * DF_SPEC));
              const kindex = k0 + 2 * k;
              if (kindex >= 0 && kindex < nffts) {
                const p0 = sps[(ifd - 3) * nffts + kindex]!;
                const p1 = sps[(ifd - 1) * nffts + kindex]!;
                const p2 = sps[(ifd + 1) * nffts + kindex]!;
                const p3 = sps[(ifd + 3) * nffts + kindex]!;
                ss += (2 * PR3[k]! - 1) * (p1 + p3 - (p0 + p2));
                pow += p0 + p1 + p2 + p3;
              }
            }
            const sync1 = ss / pow;
            if (sync1 > smax) {
              smax = sync1;
              c.shift = 128 * (k0 + 1);
              c.drift = idrift;
              c.freq = (ifr - 256) * DF_SPEC;
              c.sync = sync1;
            }
          }
        }
      }
    }

    // Refine frequency, shift and drift on the 375 Hz time series.
    for (const c of cands) {
      let f1 = c.freq;
      let drift1 = c.drift;
      let shift1 = c.shift;
      let sync1 = c.sync;
      let lagmin = shift1 - 128;
      let lagmax = shift1 + 128;
      let lagstep = 64;
      let r = syncSearch(id, qd, np, f1, 0, 0, 0, shift1, lagmin, lagmax, lagstep, drift1, 0);
      sync1 = r.sync;
      shift1 = r.shift;
      f1 = r.freq;
      r = syncSearch(id, qd, np, f1, -2, 2, 0.25, shift1, lagmin, lagmax, lagstep, drift1, 1);
      sync1 = r.sync;
      shift1 = r.shift;
      f1 = r.freq;
      if (ipass < 2) {
        const driftp = drift1 + 0.5;
        const rp = syncSearch(id, qd, np, f1, 0, 0, 0, shift1, lagmin, lagmax, lagstep, driftp, 1);
        f1 = rp.freq;
        shift1 = rp.shift;
        const driftm = drift1 - 0.5;
        const rm = syncSearch(id, qd, np, f1, 0, 0, 0, shift1, lagmin, lagmax, lagstep, driftm, 1);
        f1 = rm.freq;
        shift1 = rm.shift;
        if (rp.sync > sync1) {
          drift1 = driftp;
          sync1 = rp.sync;
        } else if (rm.sync > sync1) {
          drift1 = driftm;
          sync1 = rm.sync;
        }
      }
      if (sync1 > MINSYNC1) {
        lagmin = shift1 - 32;
        lagmax = shift1 + 32;
        lagstep = 16;
        r = syncSearch(id, qd, np, f1, 0, 0, 0, shift1, lagmin, lagmax, lagstep, drift1, 0);
        sync1 = r.sync;
        shift1 = r.shift;
        f1 = r.freq;
        r = syncSearch(id, qd, np, f1, -2, 2, 0.05, shift1, lagmin, lagmax, lagstep, drift1, 1);
        sync1 = r.sync;
        shift1 = r.shift;
        f1 = r.freq;
        c.freq = f1;
        c.shift = shift1;
        c.drift = drift1;
        c.sync = sync1;
      }
    }

    // Drop near-duplicates (same frequency within 0.05 Hz and lag within 16), keeping the
    // better sync, and anything below minsync2.
    const watch: Cand[] = [];
    for (const c of cands) {
      const k = watch.findIndex((w) => Math.abs(c.freq - w.freq) < 0.05 && Math.abs(c.shift - w.shift) < 16);
      if (k >= 0) {
        if (c.sync > watch[k]!.sync) watch[k] = { ...c };
      } else if (c.sync > minsync2) watch.push({ ...c });
    }

    for (const c of watch) {
      const f1 = c.freq;
      const shift1 = c.shift;
      const drift1 = c.drift;
      let decoded: { data: Uint8Array; cycles: number } | null = null;
      for (let ib = 1; ib <= nblocksize && !decoded; ib++) {
        const blocksize = ib < 4 ? ib : 1;
        const bitmetric = ib === 4;
        for (let idt = 0; !decoded && idt <= 128 / IIFAC; idt++) {
          // Jitter the start: 0, -8, +8, -16, +16, ... samples
          let ii = (idt + 1) >> 1;
          if (idt % 2 === 1) ii = -ii;
          ii *= IIFAC;
          softSymbols(id, qd, np, f1, shift1 + ii, drift1, blocksize, bitmetric, symbols);
          let sq = 0;
          for (let i = 0; i < 162; i++) {
            const y = symbols[i]! - 128;
            sq += y * y;
          }
          if (Math.sqrt(sq / 162) > MINRMS) {
            deinterleave(symbols);
            const res = fano(symbols, 81, METTAB, FANO_DELTA, maxCycles);
            if (res.ok) decoded = res;
          }
        }
      }
      if (!decoded) continue;
      ndecodesPass++;

      // Unpack, update the hash table, and apply wsprd's sanity checks.
      const msg = unpackWspr(decoded.data, hashTable);
      if (!msg) continue;
      if (subtraction) {
        const data11 = new Uint8Array(11);
        data11.set(decoded.data.subarray(0, 10));
        subtractSignal(id, qd, np, f1, shift1, drift1, channelTones(data11));
      }
      const key = msg.type === 3 ? `<${msg.callsign ?? "..."}>` : msg.callsign!;
      // Same callsign within 4 Hz is the same signal found twice.
      const dupe = found.some((d) => d.key === key && Math.abs(f1 - d.f1) < 4);
      if (!dupe && found.length < 50) {
        found.push({
          key,
          message: msg,
          f1,
          shift: shift1,
          drift: drift1,
          snr: c.snr,
          sync: c.sync,
          pass: ipass + 1,
          cycles: decoded.cycles,
        });
      }
    }
  }

  found.sort((a, b) => a.f1 - b.f1);
  const dial = opts.dialHz ?? 0;
  return found.map((d) => ({
    message: d.message.message,
    type: d.message.type,
    callsign: d.message.callsign,
    grid: d.message.grid,
    dbm: d.message.dbm,
    freqHz: dial + 1500 + d.f1,
    dtSec: Math.round((d.shift * DT - 1) * 100) / 100,
    driftHz: Math.trunc(d.drift) || 0,
    snrDb: Math.round(d.snr),
    sync: d.sync,
    pass: d.pass,
    cycles: d.cycles,
  }));
}
