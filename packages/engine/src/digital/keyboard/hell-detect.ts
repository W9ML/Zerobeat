/**
 * What is at the Hell marker: which Hell mode, CW, or something else.
 *
 * Three looks at the last few seconds of audio, once a second:
 *
 * 1. The spectrum near the marker: is there a signal, where is its centre, and does it
 *    have a second tone beside it (FSK Hell: 55 Hz apart for FSKH105, 122.5 for FSKH245,
 *    300 for Hell 80)?
 * 2. Its envelope: an on/off keyed carrier (Feld, Slow, x5, x9, and CW) drops out for the
 *    paper; the two-tone modes never do.
 * 3. A receiver for every speed, all printing the same audio. Only the right speed prints
 *    text, and text has a shape the others lack: folded on to a column, its ink leaves the
 *    gap between one printed copy and the next (hellStructure). At the wrong speed the
 *    print slopes and smears and the fold comes out flat.
 *
 * A keyed carrier that prints nothing at any speed but keys in dots and dashes three times
 * as long is CW: 14.063 MHz, the Feld Hell Club's 20 m frequency, is in the CW end of the
 * band, and a CW station on the marker prints as fat sloping bars.
 */
import { hellStructure } from "@zerobeat/core/ham/hell-align";

import { fft } from "../../dsp/dsp.ts";
import { Baseband, RATE } from "./common.ts";
import { HELL_ROWS, HELL_SPEEDS, HellReceiver, type HellSpeed } from "./hell.ts";

export interface HellSeen {
  /** A Hell mode (speed and reverse say which), CW, or a signal that is neither. */
  kind: "hell" | "cw" | "other";
  speed?: HellSpeed;
  reverse?: boolean;
  /** The signal's centre, audio Hz: the carrier, or midway between the two tones. */
  centreHz: number;
  /** When it was last heard like this, ms. */
  at: number;
}

const SPEEDS = Object.keys(HELL_SPEEDS) as HellSpeed[];
const OOK = SPEEDS.filter((s) => !HELL_SPEEDS[s].shiftHz);

/** Audio looked at each time, and kept. */
const LOOK_S = 3;
const KEEP_S = 4;
const FFT_N = 8192;
const BIN_HZ = RATE / FFT_N;
/** How far from the marker a signal still counts as at it. */
const NEAR_HZ = 200;
/** How long a definite answer stands against looks that cannot tell. */
const HOLD_MS = 6_000;

/** Print kept per speed: six seconds' worth, and never fewer than 40 columns (Slow Hell: 18 s). */
function keepColumns(speed: HellSpeed): number {
  return Math.max(40, Math.ceil((6 * HELL_SPEEDS[speed].pxPerSec) / HELL_ROWS));
}

/**
 * How strong a print's fold must be to call it that mode, and by how much it must beat
 * the next speed. Text at its own speed folds at 0.85 to 0.95; at a wrong speed, or CW at
 * any, it comes out anywhere up to about 0.7.
 */
const CALL = 0.78;
const MARGIN = 0.15;

/** The best of some candidates, if it clears CALL and beats the rest by MARGIN. */
function pick<T extends { strength: number }>(c: T[]): T | null {
  const s = [...c].sort((a, b) => b.strength - a.strength);
  if (!s[0] || s[0].strength < CALL) return null;
  if (s[1] && s[0].strength - s[1].strength < MARGIN) return null;
  return s[0];
}

export class HellDetector {
  private readonly audio = new Float32Array(RATE * KEEP_S);
  private write = 0;
  private filled = 0;
  private sinceLook = 0;
  private readonly bank: { speed: HellSpeed; rx: HellReceiver; px: number[] }[];
  private _rxHz = 1500;
  muted = false;
  /** The last thing heard at the marker. */
  seen: HellSeen | null = null;

  constructor(private readonly emit: (s: HellSeen) => void) {
    this.bank = SPEEDS.map((speed) => {
      const entry = {
        speed,
        px: [] as number[],
        rx: null as unknown as HellReceiver,
      };
      const keep = keepColumns(speed) * HELL_ROWS;
      entry.rx = new HellReceiver((c) => {
        for (const b of c.px) entry.px.push(b);
        if (entry.px.length > keep) entry.px.splice(0, entry.px.length - keep);
      }, speed);
      entry.rx.rxHz = this._rxHz;
      return entry;
    });
  }

  get rxHz(): number {
    return this._rxHz;
  }

  set rxHz(hz: number) {
    if (hz === this._rxHz) return;
    this._rxHz = hz;
    for (const b of this.bank) {
      b.rx.rxHz = hz;
      b.px = [];
    }
    this.seen = null;
  }

  /** 12 kHz receive audio. */
  push(samples: Float32Array, nowMs = Date.now()): void {
    if (this.muted) return;
    for (const b of this.bank) b.rx.push(samples, nowMs);
    for (let i = 0; i < samples.length; i++) {
      this.audio[this.write] = samples[i]!;
      this.write = (this.write + 1) % this.audio.length;
    }
    this.filled = Math.min(this.audio.length, this.filled + samples.length);
    this.sinceLook += samples.length;
    if (this.sinceLook >= RATE && this.filled >= RATE * LOOK_S) {
      this.sinceLook = 0;
      let s = this.look(nowMs);
      // A look that cannot tell does not undo one that could a moment ago, on the same
      // signal: Hell between words, or a CW station between characters, often cannot.
      const last = this.seen;
      if (s?.kind === "other" && last && last.kind !== "other" && s.at - last.at < HOLD_MS && Math.abs(s.centreHz - last.centreHz) < 25) s = null;
      if (s) {
        this.seen = s;
        this.emit(s);
      }
    }
  }

  /** The last `n` samples, oldest first. */
  private recent(n: number): Float32Array {
    const out = new Float32Array(n);
    const len = this.audio.length;
    for (let i = 0; i < n; i++) out[i] = this.audio[(this.write - n + i + len * 2) % len]!;
    return out;
  }

  /** What is at the marker now, or null for nothing. */
  look(nowMs: number): HellSeen | null {
    const x = this.recent(RATE * LOOK_S);
    const spec = spectrum(x);
    const bin = (hz: number) => Math.round(hz / BIN_HZ);
    // Noise: the median across the passband.
    const band = Array.from(spec.slice(bin(200), bin(2900))).sort((a, b) => a - b);
    const noise = band[band.length >> 1]! || 1e-20;
    // The strongest tone near the marker, and is it a signal at all (9 dB over the noise).
    let p1 = -1;
    for (let k = bin(this._rxHz - NEAR_HZ); k <= bin(this._rxHz + NEAR_HZ); k++) if (k > 0 && k < spec.length && (p1 < 0 || spec[k]! > spec[p1]!)) p1 = k;
    if (p1 < 0 || spec[p1]! < noise * 8) return null;
    const f1 = p1 * BIN_HZ;

    // Keyed off and on, or a carrier that never stops?
    if (steadiness(x, f1) > 0.85) {
      // Two tones. The strong one is the paper (text is mostly paper); the ink is a broad
      // hump half a shift away, below the paper, or above it when the sender is reversed.
      // FSKH105 and FSKH245 print alike, at the same speed, so they stand as one candidate
      // against Hell 80, and where the ink hump sits says which of the two it is.
      const read = (speed: HellSpeed) => {
        // The reversed reading is not a rival: a print and its negative.
        const fwd = this.structure(speed, false) ?? 0;
        const rev = this.structure(speed, true) ?? 0;
        return { speed, reverse: rev > fwd, strength: Math.max(fwd, rev) };
      };
      const a = read("fsk105");
      const b = read("fsk245");
      const slow = a.strength >= b.strength ? a : b;
      const h80 = read("hell80");
      // Hell 80 is exactly twice their speed, and read at half its speed it is still text:
      // each column holds two of its columns, half height. Theirs read at twice their speed
      // is not. So when Hell 80 reads as text and about as well, it is Hell 80.
      const best = h80.strength >= CALL && h80.strength + 0.1 >= slow.strength ? h80 : pick([slow, h80]);
      if (!best) return { kind: "other", centreHz: Math.round(f1), at: nowMs };
      const toInk = best.reverse ? 1 : -1;
      const near = (hz: number) => {
        let e = 0;
        for (let k = bin(hz - 12); k <= bin(hz + 12); k++) e += spec[k] ?? 0;
        return e;
      };
      const speed = best.speed === "hell80" ? "hell80" : near(f1 + toInk * 55) >= near(f1 + toInk * 122.5) ? "fsk105" : "fsk245";
      const centre = f1 + (toInk * HELL_SPEEDS[speed].shiftHz!) / 2;
      return {
        kind: "hell",
        speed,
        reverse: best.reverse,
        centreHz: Math.round(centre),
        at: nowMs,
      };
    }

    // Text that prints clearly wins (a CW station keying on the same frequency now and then
    // does not make Feld Hell CW). Then CW, then Slow Hell: its long elements print a CW
    // station nearer to text than the fast speeds do.
    const best = pick(
      OOK.map((speed) => ({
        speed,
        strength: this.structure(speed, false) ?? 0,
      })),
    );
    const hell = best && {
      kind: "hell" as const,
      speed: best.speed,
      reverse: false,
      centreHz: Math.round(f1),
      at: nowMs,
    };
    if (hell && best.speed !== "slow") return hell;
    if (looksLikeCw(x, f1)) return { kind: "cw", centreHz: Math.round(f1), at: nowMs };
    if (hell) return hell;
    return { kind: "other", centreHz: Math.round(f1), at: nowMs };
  }

  /** How much like text a speed's recent print is (null: too little printed to tell). */
  structure(speed: HellSpeed, invert: boolean): number | null {
    const b = this.bank.find((e) => e.speed === speed)!;
    const raw = invert ? Uint8Array.from(b.px, (v) => 255 - v) : Uint8Array.from(b.px);
    const cols = Math.floor(raw.length / HELL_ROWS);
    // Only columns with something on them: a column all paper or all ink (a CW dash)
    // says nothing about where text's gaps are.
    const busy = (k: number) => {
      let lo = 255;
      let hi = 0;
      for (let r = 0; r < HELL_ROWS; r++) {
        const v = raw[k * HELL_ROWS + r]!;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      return hi - lo >= 90;
    };
    const s = hellStructure(raw, 0, cols, busy, 21);
    if (!s) return null;
    // Reversed two-tone Hell prints as a negative: mostly ink. Text is mostly paper.
    let sum = 0;
    let n = 0;
    // And text's inked columns are mostly part ink, part paper. A carrier keyed in marks
    // longer than a column (CW, at a fast speed) prints solid columns, with the part-inked
    // ones only at its key-down and key-up edges.
    let inked = 0;
    let part = 0;
    for (let k = 0; k < cols; k++) {
      let hi = 0;
      for (let r = 0; r < HELL_ROWS; r++) hi = Math.max(hi, raw[k * HELL_ROWS + r]!);
      if (hi >= 128) inked++;
      if (!busy(k)) continue;
      part++;
      for (let r = 0; r < HELL_ROWS; r++) sum += raw[k * HELL_ROWS + r]!;
      n += HELL_ROWS;
    }
    if (n && sum / n > 0.55 * 255) return 0;
    if (part < 0.5 * inked) return 0;
    return s.strength;
  }
}

/** Mean power spectrum of a stretch (Hann windows, half overlapped), lightly smoothed. */
function spectrum(x: Float32Array): Float32Array {
  const acc = new Float32Array(FFT_N / 2);
  const win = new Float32Array(FFT_N).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_N - 1)));
  let segs = 0;
  for (let s = 0; s + FFT_N <= x.length; s += FFT_N / 2) {
    const re = new Float32Array(FFT_N);
    const im = new Float32Array(FFT_N);
    for (let i = 0; i < FFT_N; i++) re[i] = x[s + i]! * win[i]!;
    fft(re, im);
    for (let k = 0; k < FFT_N / 2; k++) acc[k] = acc[k]! + re[k]! * re[k]! + im[k]! * im[k]!;
    segs++;
  }
  // Smooth over about 7 Hz: a keyed tone is a little wide.
  const out = new Float32Array(acc.length);
  for (let k = 0; k < acc.length; k++) {
    let s = 0;
    let n = 0;
    for (let d = -2; d <= 2; d++) {
      const v = acc[k + d];
      if (v !== undefined) {
        s += v;
        n++;
      }
    }
    out[k] = s / n / Math.max(1, segs);
  }
  return out;
}

/** The signal's strength at `hz`, every `boxMs` (averaged over the box). */
function envelope(x: Float32Array, hz: number, boxMs: number): number[] {
  const box = Math.max(2, Math.round((RATE * boxMs) / 1000));
  const bb = new Baseband(hz, box, box);
  const out: number[] = [];
  bb.push(x, (re, im) => out.push(Math.hypot(re, im)));
  return out;
}

function percentile(v: number[], p: number): number {
  const s = [...v].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? 0;
}

/**
 * Over the stretches where the signal is on the air (100 ms blocks with signal in them),
 * the fraction of the time it is up. A keyed carrier spends much of a block off; a
 * two-tone carrier never is.
 */
function steadiness(x: Float32Array, hz: number): number {
  // 2 ms: quick enough to see a Feld Hell element drop out, wide enough (a null at 500 Hz)
  // to keep both of Hell 80's tones.
  const env = envelope(x, hz, 2);
  const top = percentile(env, 0.95);
  if (top <= 0) return 0;
  const per = 50;
  let up = 0;
  let all = 0;
  for (let b = 0; b + per <= env.length; b += per) {
    const blk = env.slice(b, b + per);
    if (Math.max(...blk) < 0.5 * top) continue;
    up += blk.filter((v) => v > 0.3 * top).length;
    all += per;
  }
  return all ? up / all : 0;
}

/**
 * Morse: a keyed carrier whose marks are dots and dashes, the dashes three dots long
 * (5 to 48 WPM: a dot 25 to 240 ms), the spaces at least a dot.
 */
export function looksLikeCw(x: Float32Array, hz: number): boolean {
  const env = envelope(x, hz, 10);
  const lo = percentile(env, 0.3);
  const hi = percentile(env, 0.98);
  if (hi <= lo * 2) return false;
  const th = (lo + hi) / 2;
  const marks: number[] = [];
  let run = 0;
  let on = false;
  for (const v of env) {
    const o = v > th;
    if (o === on) run++;
    else {
      if (on) marks.push(run * 10);
      on = o;
      run = 1;
    }
  }
  const long = marks.filter((m) => m >= 20);
  if (long.length < 6) return false;
  const dot = percentile(long, 0.2);
  if (dot < 25 || dot > 240) return false;
  const fits = long.filter((m) => (m >= 0.5 * dot && m <= 1.7 * dot) || (m >= 2.2 * dot && m <= 4.2 * dot)).length;
  return fits >= 0.8 * long.length;
}
