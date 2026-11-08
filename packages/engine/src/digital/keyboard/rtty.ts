/**
 * RTTY: 45.45 baud Baudot (ITA2, US figures), 170 Hz shift, as AFSK on USB. The marker
 * frequency is the centre; mark is the higher tone (centre + 85 Hz), which on USB puts
 * mark on the higher RF frequency, the amateur convention, so no "reverse" is needed.
 *
 * Transmit: one start bit (space), five data bits LSB first, 1.5 stop bits (mark),
 * continuous phase, with the tone changes smoothed over 6 ms to keep the signal narrow.
 * Shifts follow "unshift on space": after a space the receiver is assumed back in
 * LETTERS, so a figure after a space re-sends FIGS.
 *
 * Receive (after fldigi's rtty.cxx): mark and space each mixed to baseband and averaged
 * over one bit, envelopes and noise floors tracked with asymmetric averages, the bit
 * decided by fldigi's "optimal ATC", then a UART that finds the start bit's edge and
 * samples each bit in its middle.
 */
import { Baseband, ChannelSet, decay, RATE, SignalScanner, TextStream, type KeyLine, type KeyReceiver } from "./common.ts";

export const BAUD = 45.45;
export const SHIFT = 170;

// fldigi's tables (cw_rtty/rtty.cxx). 0 is NUL, 2 LF, 8 CR, 27 FIGS, 31 LTRS.
const LETTERS = ["\0", "E", "\n", "A", " ", "S", "I", "U", "\r", "D", "R", "J", "N", "F", "C", "K", "T", "Z", "L", "W", "H", "Y", "P", "Q", "O", "B", "G", " ", "M", "X", "V", " "];
const FIGURES = ["\0", "3", "\n", "-", " ", "\x07", "8", "7", "\r", "$", "4", "'", ",", "!", ":", "(", "5", '"', ")", "2", "#", "6", "0", "1", "9", "?", "&", " ", ".", "/", ";", " "];
const CODE_FIGS = 27;
const CODE_LTRS = 31;
const CODE_SPACE = 4;
const CODE_CR = 8;
const CODE_LF = 2;

/** Text → Baudot codes, with the shifts it needs. Characters Baudot has no code for are dropped. */
export function toBaudot(text: string): number[] {
  const out: number[] = [];
  let figs = false;
  for (const raw of text.toUpperCase()) {
    if (raw === " ") {
      out.push(CODE_SPACE);
      figs = false; // unshift on space
      continue;
    }
    if (raw === "\n") {
      out.push(CODE_CR, CODE_LF);
      continue;
    }
    if (raw === "\r") continue;
    let code = LETTERS.indexOf(raw);
    if (code > 0 && code !== CODE_FIGS && code !== CODE_LTRS) {
      if (figs) {
        out.push(CODE_LTRS);
        figs = false;
      }
      out.push(code);
      continue;
    }
    code = FIGURES.indexOf(raw);
    if (code > 0 && code !== CODE_FIGS && code !== CODE_LTRS) {
      if (!figs) {
        out.push(CODE_FIGS);
        figs = true;
      }
      out.push(code);
    }
  }
  return out;
}

/** What RTTY can carry of some text: uppercase, Baudot's characters only. */
export function rttyText(text: string): string {
  let s = "";
  let figs = false;
  for (const c of toBaudot(text)) {
    if (c === CODE_FIGS) figs = true;
    else if (c === CODE_LTRS) figs = false;
    else if (c === CODE_CR) continue;
    else s += (figs ? FIGURES : LETTERS)[c];
    if (c === CODE_SPACE) figs = false;
  }
  return s;
}

/**
 * The transmit waveform for some text at a centre frequency. It starts and ends with a
 * moment of mark and a LTRS, and the text sits between CR LF pairs, as RTTY operators
 * expect.
 */
export function rttyWaveform(text: string, centerHz: number, sampleRate: number): Float32Array {
  const codes = [CODE_LTRS, CODE_LTRS, CODE_CR, CODE_LF, ...toBaudot(text), CODE_CR, CODE_LF, CODE_LTRS];
  const bit = sampleRate / BAUD;
  // Levels per sample: +1 mark, -1 space.
  const levels: number[] = [];
  const hold = (v: number, bits: number) => {
    const n = Math.round(bits * bit);
    for (let i = 0; i < n; i++) levels.push(v);
  };
  hold(1, 8); // idle mark before the first character
  for (const c of codes) {
    hold(-1, 1);
    for (let b = 0; b < 5; b++) hold((c >> b) & 1 ? 1 : -1, 1);
    hold(1, 1.5);
  }
  hold(1, 4);
  // Smooth the tone changes: a raised-cosine average over 6 ms.
  const w = Math.max(3, Math.round(0.006 * sampleRate)) | 1;
  const kern = Array.from({ length: w }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 1)) / (w + 1)));
  const ks = kern.reduce((a, b) => a + b, 0);
  const out = new Float32Array(levels.length);
  let phi = 0;
  const half = (w - 1) / 2;
  const edge = Math.round(0.005 * sampleRate);
  for (let i = 0; i < levels.length; i++) {
    let v = 0;
    for (let j = 0; j < w; j++) v += (levels[Math.min(levels.length - 1, Math.max(0, i + j - half))]! * kern[j]!) / ks;
    const f = centerHz + (v * SHIFT) / 2;
    phi += (2 * Math.PI * f) / sampleRate;
    if (phi > 2 * Math.PI) phi -= 2 * Math.PI;
    const a = i < edge ? (1 - Math.cos((Math.PI * i) / edge)) / 2 : i > levels.length - edge ? (1 - Math.cos((Math.PI * (levels.length - i)) / edge)) / 2 : 1;
    out[i] = Math.sin(phi) * a;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Receive
// ---------------------------------------------------------------------------

const DECIM = 8; // 12 kHz → 1500 Hz
const SYMLEN = Math.round(RATE / DECIM / BAUD); // 33 samples per bit
const BOX = Math.round(RATE / BAUD); // one bit at 12 kHz
/**
 * Squelch: the contrast between the stronger and weaker filter, averaged over about two
 * characters. Noise in both filters gives about 4.8 dB (two Rayleigh variables); a
 * decodable signal is well above it.
 */
const SQUELCH_DB = 7;
/**
 * Framing gate: characters print only while nearly every recent one ended with a good
 * stop bit. Real RTTY almost always frames; noise, and FT4/FT8 tones stepping across the
 * mark and space filters, fail about half the time, so they get no further than here.
 * Characters seen before the gate opens are held and printed when it does.
 */
/** How far each tone must stand above its shoulders for the scanner to take it as RTTY. */
const NARROW_DB = 9;
const FRAME_WINDOW = 10;
const FRAME_MIN = 6;
const FRAME_OK = 0.85;

const enum Rx {
  Idle,
  Start,
  Data,
  Stop,
}

/** One RTTY signal: mark and space filters, ATC, and the UART. */
export class RttyDemod {
  private readonly mark: Baseband;
  private readonly space: Baseband;
  private markEnv = 0;
  private markNoise = 0;
  private spaceEnv = 0;
  private spaceNoise = 0;
  private bits: boolean[] = new Array(SYMLEN).fill(true);
  private state = Rx.Idle;
  private counter = 0;
  private nbit = 0;
  private data = 0;
  private figs = false;
  snrDb = -99;
  private hiPow = 0;
  private loPow = 0;
  private frames: number[] = [];
  private held: { c: string; atMs: number; snr: number }[] = [];

  constructor(
    public freqHz: number,
    private readonly out: (ch: string, atMs: number, snrDb: number) => void,
  ) {
    this.mark = new Baseband(freqHz + SHIFT / 2, DECIM, BOX);
    this.space = new Baseband(freqHz - SHIFT / 2, DECIM, BOX);
  }

  feed(x: Float32Array, firstMs: number): void {
    const m: number[] = [];
    this.mark.push(x, (re, im) => m.push(Math.hypot(re, im)));
    let i = 0;
    this.space.push(x, (re, im) => {
      this.sample(m[i++] ?? 0, Math.hypot(re, im), firstMs + ((i * DECIM) / RATE) * 1000);
    });
  }

  private sample(mm: number, sm: number, atMs: number): void {
    const L = SYMLEN;
    this.markEnv = decay(this.markEnv, mm, mm > this.markEnv ? L / 4 : L * 16);
    this.markNoise = decay(this.markNoise, mm, mm < this.markNoise ? L / 4 : L * 48);
    this.spaceEnv = decay(this.spaceEnv, sm, sm > this.spaceEnv ? L / 4 : L * 16);
    this.spaceNoise = decay(this.spaceNoise, sm, sm < this.spaceNoise ? L / 4 : L * 48);
    const nf = Math.min(this.markNoise, this.spaceNoise);
    let mc = Math.min(mm, this.markEnv);
    let sc = Math.min(sm, this.spaceEnv);
    if (mc < nf) mc = nf;
    if (sc < nf) sc = nf;
    // fldigi's "optimal ATC".
    const v = (mc - nf) * (this.markEnv - nf) - (sc - nf) * (this.spaceEnv - nf) - 0.25 * ((this.markEnv - nf) ** 2 - (this.spaceEnv - nf) ** 2);
    const hi = Math.max(mm, sm);
    const lo = Math.min(mm, sm);
    this.hiPow = decay(this.hiPow, hi * hi, L * 12);
    this.loPow = decay(this.loPow, lo * lo, L * 12);
    this.snrDb = this.loPow > 0 ? 10 * Math.log10(this.hiPow / this.loPow) : -99;
    this.uart(v > 0, atMs);
  }

  private uart(bit: boolean, atMs: number): void {
    const b = this.bits;
    b.shift();
    b.push(bit);
    const isMark = () => b[SYMLEN >> 1]!;
    switch (this.state) {
      case Rx.Idle:
        // A mark-to-space edge with the buffer straddling it about evenly.
        if (b[0] && !b[SYMLEN - 1]) {
          let marks = 0;
          for (const x of b) if (x) marks++;
          if (Math.abs((SYMLEN >> 1) - marks) < 6) {
            this.state = Rx.Start;
            this.counter = marks;
          }
        }
        break;
      case Rx.Start:
        if (--this.counter === 0) {
          if (!isMark()) {
            this.state = Rx.Data;
            this.counter = SYMLEN;
            this.nbit = 0;
            this.data = 0;
          } else this.state = Rx.Idle;
        }
        break;
      case Rx.Data:
        if (--this.counter === 0) {
          this.data |= (isMark() ? 1 : 0) << this.nbit++;
          this.counter = SYMLEN;
        }
        if (this.nbit === 5) this.state = Rx.Stop;
        break;
      case Rx.Stop:
        if (--this.counter === 0) {
          const ok = isMark();
          this.frames.push(ok ? 1 : 0);
          if (this.frames.length > FRAME_WINDOW) this.frames.shift();
          if (ok) this.char(this.data, atMs);
          else if (!this.framed()) this.held = [];
          this.state = Rx.Idle;
        }
        break;
    }
  }

  private char(code: number, atMs: number): void {
    if (code === CODE_LTRS) {
      this.figs = false;
      return;
    }
    if (code === CODE_FIGS) {
      this.figs = true;
      return;
    }
    if (code === CODE_SPACE) this.figs = false; // unshift on space
    if (this.snrDb < SQUELCH_DB) return;
    const c = (this.figs ? FIGURES : LETTERS)[code]!;
    if (c === "\0" || c === "\x07") return;
    const snr = Math.round(this.snrDb);
    if (!this.framed()) {
      this.held.push({ c, atMs, snr });
      if (this.held.length > FRAME_WINDOW) this.held.shift();
      return;
    }
    for (const h of this.held.splice(0)) this.out(h.c, h.atMs, h.snr);
    this.out(c, atMs, snr);
  }

  private framed(): boolean {
    const f = this.frames;
    if (f.length < FRAME_MIN) return false;
    let ok = 0;
    for (const x of f) ok += x;
    return ok / f.length >= FRAME_OK;
  }

  close(): void {}
}

/**
 * RTTY across the passband: the operator's frequency, plus every RTTY signal the scanner
 * finds (two tones 170 Hz apart), each into its own text stream.
 */
export class RttyReceiver implements KeyReceiver {
  private _rxHz = 1500;
  muted = false;
  private chans: ChannelSet<RttyDemod & { stream: TextStream }>;
  private readonly scanner: SignalScanner;
  private gen = 0;
  private nowMs = 0;

  constructor(private readonly onLine: (l: KeyLine) => void) {
    this.chans = this.makeSet();
    this.scanner = new SignalScanner({ widthHz: 30, pairHz: SHIFT, minSnrDb: 8, minHz: 300, maxHz: 2900, narrowDb: NARROW_DB }, (found) => this.chans.found(found, this.nowMs));
    this.chans.setRx(this._rxHz);
  }

  private makeSet() {
    return new ChannelSet<RttyDemod & { stream: TextStream }>(
      (hz, isRx) => {
        const stream = new TextStream(`rtty-${this.gen}-${Math.round(hz)}-${isRx ? "rx" : "b"}`, this.onLine);
        const d = new RttyDemod(hz, (ch, at, snr) => stream.put(ch, at, d.freqHz, snr, isRx)) as RttyDemod & { stream: TextStream };
        d.stream = stream;
        const close = d.close.bind(d);
        d.close = () => {
          stream.close();
          close();
        };
        return d;
      },
      40,
    );
  }

  get rxHz(): number {
    return this._rxHz;
  }

  set rxHz(hz: number) {
    this._rxHz = hz;
    this.chans.setRx(hz);
  }

  push(samples: Float32Array, firstSampleMs: number): void {
    this.nowMs = firstSampleMs;
    const x = this.muted ? new Float32Array(samples.length) : samples;
    this.scanner.push(x);
    this.chans.feed(x, firstSampleMs);
  }

  reset(): void {
    this.chans.clear();
    this.gen++;
    this.chans = this.makeSet();
    this.chans.setRx(this._rxHz);
  }
}
