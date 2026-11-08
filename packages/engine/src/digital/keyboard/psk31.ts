/**
 * PSK31 (G3PLX): binary phase shift keying at 31.25 baud. A 0 is a phase reversal, made
 * through zero amplitude with a cosine envelope so the signal stays about 60 Hz wide; a 1
 * keeps the phase. Characters are varicode (frequent letters are short) separated by 00,
 * and idle is continuous reversals.
 *
 * Receive: the signal mixed to baseband and averaged over a symbol, sampled at 16 points
 * a symbol; symbol timing from where the envelope peaks; each symbol's phase compared with
 * the last (differential detection, so no carrier lock is needed); AFC from the residual
 * phase rotation; squelch from how close those phase changes are to 0 or 180 degrees.
 */
import { Baseband, ChannelSet, decay, RATE, SignalScanner, TextStream, type KeyLine, type KeyReceiver } from "./common.ts";

export const BAUD = 31.25;

// fldigi psk/pskvaricode.cxx varicodetab1, ASCII 0-127 (G3PLX's varicode).
export const VARICODE: readonly string[] = [
  "1010101011", "1011011011", "1011101101", "1101110111", "1011101011", "1101011111", "1011101111", "1011111101",
  "1011111111", "11101111", "11101", "1101101111", "1011011101", "11111", "1101110101", "1110101011",
  "1011110111", "1011110101", "1110101101", "1110101111", "1101011011", "1101101011", "1101101101", "1101010111",
  "1101111011", "1101111101", "1110110111", "1101010101", "1101011101", "1110111011", "1011111011", "1101111111",
  "1", "111111111", "101011111", "111110101", "111011011", "1011010101", "1010111011", "101111111",
  "11111011", "11110111", "101101111", "111011111", "1110101", "110101", "1010111", "110101111",
  "10110111", "10111101", "11101101", "11111111", "101110111", "101011011", "101101011", "110101101",
  "110101011", "110110111", "11110101", "110111101", "111101101", "1010101", "111010111", "1010101111",
  "1010111101", "1111101", "11101011", "10101101", "10110101", "1110111", "11011011", "11111101",
  "101010101", "1111111", "111111101", "101111101", "11010111", "10111011", "11011101", "10101011",
  "11010101", "111011101", "10101111", "1101111", "1101101", "101010111", "110110101", "101011101",
  "101110101", "101111011", "1010101101", "111110111", "111101111", "111111011", "1010111111", "101101101",
  "1011011111", "1011", "1011111", "101111", "101101", "11", "111101", "1011011",
  "101011", "1101", "111101011", "10111111", "11011", "111011", "1111", "111",
  "111111", "110111111", "10101", "10111", "101", "110111", "1111011", "1101011",
  "11011111", "1011101", "111010101", "1010110111", "110111011", "1010110101", "1011010111", "1110110101",
];

const DECODE = new Map<string, string>(VARICODE.map((c, i) => [c, String.fromCharCode(i)]));

/** What PSK31 will send of some text: printable ASCII and newlines. */
export function pskText(text: string): string {
  return [...text].filter((c) => c === "\n" || (c.charCodeAt(0) >= 32 && c.charCodeAt(0) < 127)).join("");
}

/** Bits for some text: a preamble of reversals, each character's varicode and 00, a tail. */
export function pskBits(text: string): number[] {
  const bits: number[] = new Array(32).fill(0);
  for (const c of "\n" + pskText(text) + "\n") {
    const code = c === "\n" ? VARICODE[13]! + "00" + VARICODE[10]! : VARICODE[c.charCodeAt(0)]!;
    for (const b of code) bits.push(b === "1" ? 1 : 0);
    bits.push(0, 0);
  }
  for (let i = 0; i < 16; i++) bits.push(0);
  for (let i = 0; i < 16; i++) bits.push(1); // a moment of plain carrier before it fades
  return bits;
}

export function pskWaveform(text: string, freqHz: number, sampleRate: number): Float32Array {
  const bits = pskBits(text);
  const ns = Math.round(sampleRate / BAUD);
  const out = new Float32Array(bits.length * ns);
  let sign = 1;
  const w = (2 * Math.PI * freqHz) / sampleRate;
  for (let k = 0; k < bits.length; k++) {
    const rev = bits[k] === 0;
    for (let i = 0; i < ns; i++) {
      const n = k * ns + i;
      // Through zero mid-symbol on a reversal; steady otherwise.
      const a = rev ? sign * Math.cos((Math.PI * i) / ns) : sign;
      out[n] = a * Math.cos(w * n);
    }
    if (rev) sign = -sign;
  }
  // Fade out over the last symbol.
  for (let i = 0; i < ns; i++) out[out.length - 1 - i]! *= i / ns;
  return out;
}

// ---------------------------------------------------------------------------
// Receive
// ---------------------------------------------------------------------------

const DECIM = 24; // 12 kHz → 500 Hz
const PER_SYM = 16;
const BOX = Math.round(RATE / BAUD); // one symbol
const SQUELCH = 0.55; // mean cos(2·Δφ): 1 for a clean signal, 0 for noise

export class PskDemod {
  private readonly bb: Baseband;
  private phase = 0;
  private readonly energy = new Float64Array(PER_SYM);
  private prevRe = 0;
  private prevIm = 0;
  private quality = 0;
  private bitsBuf = "";
  private prevBit = 1;
  snrDb = -99;

  constructor(
    public freqHz: number,
    private readonly out: (ch: string, atMs: number, snrDb: number) => void,
    private readonly afc = true,
  ) {
    this.bb = new Baseband(freqHz, DECIM, BOX);
    this.home = freqHz;
  }

  private home: number;
  private d2r = 0;
  private d2i = 0;

  feed(x: Float32Array, firstMs: number): void {
    let i = 0;
    this.bb.push(x, (re, im) => {
      i++;
      this.sample(re, im, firstMs + ((i * DECIM) / RATE) * 1000);
    });
  }

  private best = 0;

  private sample(re: number, im: number, atMs: number): void {
    const p = this.phase;
    const e = re * re + im * im;
    this.energy[p] = this.energy[p]! * 0.98 + e * 0.02;
    if (++this.phase === PER_SYM) {
      this.phase = 0;
      // Re-pick the sampling phase once a symbol: where the envelope peaks.
      let bi = 0;
      for (let k = 1; k < PER_SYM; k++) if (this.energy[k]! > this.energy[bi]!) bi = k;
      this.best = bi;
    }
    if (p !== this.best) return;
    // Differential detection.
    const dr = re * this.prevRe + im * this.prevIm;
    const di = im * this.prevRe - re * this.prevIm;
    this.prevRe = re;
    this.prevIm = im;
    const ang = Math.atan2(di, dr);
    const bit = dr > 0 ? 1 : 0;
    this.quality = decay(this.quality, Math.cos(2 * ang), 12);
    this.snrDb = this.quality > 0 ? Math.round(10 * Math.log10(Math.max(1e-6, this.quality / Math.max(1e-6, 1 - this.quality)))) : -99;
    if (this.afc) {
      // Residual rotation per symbol with the modulation removed (the angle doubled, then
      // halved), so it holds for any bit and any offset under a quarter of the baud rate.
      // Averaged as a vector over about eight symbols, so strong symbols count most and
      // noise averages out.
      this.d2r = decay(this.d2r, dr * dr - di * di, 8);
      this.d2i = decay(this.d2i, 2 * dr * di, 8);
      let r = Math.atan2(this.d2i, this.d2r) / 2;
      let gain = 0.05;
      if (this.quality > 0.5) {
        // Locked: the decided bit tells which way the phase went, which is more accurate.
        r = bit ? ang : ang - Math.PI;
        if (r > Math.PI) r -= 2 * Math.PI;
        if (r < -Math.PI) r += 2 * Math.PI;
        gain = 0.1;
      }
      const errHz = (r / (2 * Math.PI)) * BAUD;
      const f = this.freqHz + Math.max(-1, Math.min(1, errHz * gain));
      this.freqHz = Math.max(this.home - 25, Math.min(this.home + 25, f));
      this.bb.setFreq(this.freqHz);
    }
    this.bit(bit, atMs);
  }

  private bit(b: number, atMs: number): void {
    if (b === 0 && this.prevBit === 0) {
      const code = this.bitsBuf.slice(0, -1);
      this.bitsBuf = "";
      if (code) {
        const c = DECODE.get(code);
        if (c !== undefined && this.quality > SQUELCH) {
          const ch = c === "\r" ? "\n" : c;
          if (ch === "\n" || (ch >= " " && ch < "\x7f")) this.out(ch, atMs, this.snrDb);
        }
      }
    } else {
      this.bitsBuf += b;
      if (this.bitsBuf.length > 14) this.bitsBuf = "";
    }
    this.prevBit = b;
  }

  retune(hz: number): void {
    this.freqHz = hz;
    this.home = hz;
    this.bb.setFreq(hz);
  }

  close(): void {}
}

export class PskReceiver implements KeyReceiver {
  private _rxHz = 1500;
  muted = false;
  private chans: ChannelSet<PskDemod & { stream: TextStream }>;
  private readonly scanner: SignalScanner;
  private gen = 0;
  private nowMs = 0;

  constructor(private readonly onLine: (l: KeyLine) => void) {
    this.chans = this.makeSet();
    this.scanner = new SignalScanner({ widthHz: 44, minSnrDb: 6, minHz: 200, maxHz: 2900, minSepHz: 70 }, (found) => this.chans.found(found, this.nowMs));
    this.chans.setRx(this._rxHz);
  }

  private makeSet() {
    return new ChannelSet<PskDemod & { stream: TextStream }>(
      (hz, isRx) => {
        const stream = new TextStream(`psk-${this.gen}-${Math.round(hz)}-${isRx ? "rx" : "b"}`, this.onLine);
        const d = new PskDemod(hz, (ch, at, snr) => stream.put(ch, at, d.freqHz, snr, isRx)) as PskDemod & { stream: TextStream };
        d.stream = stream;
        d.close = () => stream.close();
        return d;
      },
      30,
      20_000,
      30,
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
