/**
 * CW (Morse). Transmit is a keyed audio tone on USB-D at the marker frequency, shaped
 * with 5 ms raised-cosine edges so it is free of key clicks; on the air that is an
 * ordinary CW signal at dial + tone. Timing is PARIS: a dit is 1.2/WPM seconds, dah
 * three dits, one dit between elements, three between characters, seven between words.
 *
 * Receive: the signal mixed to baseband and averaged over 16 ms, its envelope sampled at
 * 200 Hz, a threshold halfway between the average envelope above it and below it (a
 * running two-level split, with hysteresis), and mark and space lengths read against a dit length the decoder keeps
 * re-estimating, so it follows the sender's speed from 5 to 50 WPM. This copies
 * machine-sent CW well and steady hand-sent CW fairly; a sloppy fist defeats it, as it
 * does most decoders.
 */
import { Baseband, ChannelSet, decay, RATE, SignalScanner, TextStream, type KeyLine, type KeyReceiver } from "./common.ts";

export const MORSE: Record<string, string> = {
  A: ".-", B: "-...", C: "-.-.", D: "-..", E: ".", F: "..-.", G: "--.", H: "....", I: "..", J: ".---", K: "-.-", L: ".-..", M: "--",
  N: "-.", O: "---", P: ".--.", Q: "--.-", R: ".-.", S: "...", T: "-", U: "..-", V: "...-", W: ".--", X: "-..-", Y: "-.--", Z: "--..",
  "0": "-----", "1": ".----", "2": "..---", "3": "...--", "4": "....-", "5": ".....", "6": "-....", "7": "--...", "8": "---..", "9": "----.",
  ".": ".-.-.-", ",": "--..--", "?": "..--..", "/": "-..-.", "=": "-...-", "+": ".-.-.", "-": "-....-", "'": ".----.", "(": "-.--.", ")": "-.--.-",
  ":": "---...", ";": "-.-.-.", '"': ".-..-.", "@": ".--.-.", "!": "-.-.--",
  // Prosigns, written <AR> and so on.
  "<AR>": ".-.-.", "<SK>": "...-.-", "<BT>": "-...-", "<KN>": "-.--.", "<AS>": ".-...", "<BK>": "-...-.-",
};
// Codes that are both a character and a prosign decode as the character, except these.
const DECODE = new Map<string, string>();
for (const [k, v] of Object.entries(MORSE)) if (!DECODE.has(v) || k === "<SK>" || k === "<KN>" || k === "<AS>" || k === "<BK>") DECODE.set(v, k);
DECODE.set("-...-", "=");
DECODE.set(".-.-.", "+");

/** Characters and prosigns of some text, as CW will send them. */
export function cwTokens(text: string): string[] {
  const out: string[] = [];
  const t = text.toUpperCase();
  for (let i = 0; i < t.length; i++) {
    const c = t[i]!;
    if (c === "<") {
      const j = t.indexOf(">", i);
      const tok = j > 0 ? t.slice(i, j + 1) : "";
      if (MORSE[tok]) {
        out.push(tok);
        i = j;
        continue;
      }
    }
    if (c === " " || c === "\n") {
      if (out.length && out.at(-1) !== " ") out.push(" ");
      continue;
    }
    if (MORSE[c]) out.push(c);
  }
  while (out.at(-1) === " ") out.pop();
  return out;
}

export function cwText(text: string): string {
  return cwTokens(text).join("");
}

export function cwWaveform(text: string, freqHz: number, sampleRate: number, wpm: number): Float32Array {
  const dit = (1.2 / wpm) * sampleRate;
  const edge = Math.round(0.005 * sampleRate);
  // On/off runs in dits.
  const runs: [boolean, number][] = [[false, 2]];
  const toks = cwTokens(text);
  toks.forEach((tok, ti) => {
    if (tok === " ") {
      runs.push([false, 4]); // 3 after the last character + 4 = 7
      return;
    }
    const code = MORSE[tok]!;
    [...code].forEach((el, i) => {
      runs.push([true, el === "." ? 1 : 3]);
      if (i < code.length - 1) runs.push([false, 1]);
    });
    if (ti < toks.length - 1) runs.push([false, 3]);
  });
  runs.push([false, 2]);
  const total = Math.round(runs.reduce((a, [, d]) => a + d, 0) * dit);
  const out = new Float32Array(total);
  const w = (2 * Math.PI * freqHz) / sampleRate;
  let pos = 0;
  for (const [on, d] of runs) {
    const n = Math.round(d * dit);
    if (on) {
      for (let i = 0; i < n && pos + i < total; i++) {
        const a = i < edge ? (1 - Math.cos((Math.PI * i) / edge)) / 2 : i > n - edge ? (1 - Math.cos((Math.PI * (n - i)) / edge)) / 2 : 1;
        out[pos + i] = a * Math.sin(w * (pos + i));
      }
    }
    pos += n;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Receive
// ---------------------------------------------------------------------------

const DECIM = 60; // 12 kHz → 200 Hz, 5 ms a sample
const STEP_MS = (DECIM / RATE) * 1000;
const BOX = Math.round(0.016 * RATE); // about 60 Hz wide
/** Mark level over the noise floor near the channel (from the band spectrum), dB. */
const SQUELCH_DB = 6;
export const CW_BOX = BOX;

/** Averaging before detection, matched to the element length: 0.6 of a dit, 10 to 60 ms. */
const boxFor = (ditMs: number) => Math.round((Math.max(10, Math.min(60, ditMs * 0.6)) / 1000) * RATE);

export class CwDemod {
  private bb: Baseband;
  private box = BOX;
  /** Mark level and space level: the two halves of a running split of the envelope. */
  private sig = 0;
  private space = 0;
  /** Noise power of a baseband sample near this channel, from the band spectrum. */
  noisePow: number | null = null;
  snrDb = -99;
  private dit = 60; // ms, 20 WPM to start
  private hist: number[] = [];
  private warm = 0;
  private t = 0; // ms since the demodulator started
  // Keying, after debouncing and glitch filtering.
  private raw = false;
  private pendingFlip = 0;
  private markStart: number | null = null;
  private spaceStart = 0;
  private endingMark: { start: number; end: number } | null = null;
  private marks: number[] = [];
  private code = "";
  private charDone = true;
  private wordDone = true;
  /** When the last character ended, and a lone E or T held back after a long silence. */
  private lastCharT = -1e9;
  private held: { c: string; at: number } | null = null;

  constructor(
    public freqHz: number,
    private readonly out: (ch: string, atMs: number, snrDb: number) => void,
  ) {
    this.bb = new Baseband(freqHz, DECIM, BOX);
  }

  /** The noise power this channel's filter sees, given the band noise for a BOX-long average. */
  private get noiseHere(): number | null {
    return this.noisePow === null ? null : (this.noisePow * BOX) / this.box;
  }

  get wpm(): number {
    return Math.round(1200 / this.dit);
  }

  feed(x: Float32Array, firstMs: number): void {
    let i = 0;
    this.bb.push(x, (re, im) => {
      i++;
      this.sample(Math.hypot(re, im), firstMs + i * STEP_MS);
    });
  }

  private sample(env: number, atMs: number): void {
    this.t += STEP_MS;
    // Average the envelope over half a dit at the sender's speed: as much smoothing as
    // the keying allows.
    this.hist.push(env);
    const n = Math.max(2, Math.min(8, Math.round(this.dit / 2 / STEP_MS)));
    while (this.hist.length > n) this.hist.shift();
    let m = 0;
    for (const v of this.hist) m += v;
    m /= this.hist.length;
    if (this.warm < 60) {
      // The first 300 ms only set the levels.
      this.warm++;
      this.sig = Math.max(this.sig, m);
      this.space = this.space ? Math.min(this.space, m) : m;
      if (this.warm === 60) this.sig = Math.max(this.sig, this.space * 1.5);
      return;
    }
    // Two-level split: samples above the middle feed the mark level, below it the space
    // level. Marks are short, so the mark level adapts faster.
    const mid0 = (this.sig + this.space) / 2;
    if (m > mid0) this.sig = decay(this.sig, m, 20);
    else this.space = decay(this.space, m, 60);
    // With nothing keyed the mark level sinks slowly, so the squelch closes after a signal ends.
    this.sig = decay(this.sig, this.space, 600);
    const np = this.noiseHere;
    this.snrDb = np ? 10 * Math.log10((this.sig * this.sig) / np) : -99;
    const mid = (this.sig + this.space) / 2;
    const hyst = (this.sig - this.space) * 0.1;
    let keyed = this.snrDb >= SQUELCH_DB && (this.raw ? m > mid - hyst : m > mid + hyst);
    // Debounce: the key changes only when two samples in a row agree.
    if (keyed === this.raw) this.pendingFlip = 0;
    else if (++this.pendingFlip < 2) keyed = this.raw;
    else this.pendingFlip = 0;
    if (keyed !== this.raw) {
      this.raw = keyed;
      if (keyed) this.keyDown();
      else this.keyUp();
    }
    if (!this.raw) this.inSpace(atMs);
  }

  /** Shortest gap that ends a mark, and shortest mark that counts. */
  private get minGap(): number {
    return Math.max(10, this.dit * 0.4);
  }

  private keyDown(): void {
    // A gap too short to be a real space: the mark carries on.
    if (this.endingMark && this.t - this.spaceStart < this.minGap) {
      this.markStart = this.endingMark.start;
      this.endingMark = null;
      return;
    }
    this.markStart = this.t;
  }

  private keyUp(): void {
    if (this.markStart === null) return;
    this.endingMark = { start: this.markStart, end: this.t };
    this.markStart = null;
    this.spaceStart = this.t;
  }

  private inSpace(atMs: number): void {
    const gap = this.t - this.spaceStart;
    if (this.endingMark && gap >= this.minGap) {
      const len = this.endingMark.end - this.endingMark.start;
      this.endingMark = null;
      if (len >= Math.max(10, this.dit * 0.35)) this.markEnded(len);
    }
    if (this.endingMark) return;
    if (!this.charDone && gap > this.dit * 2) {
      this.charDone = true;
      const code = this.code;
      const c = DECODE.get(code);
      this.code = "";
      if (c !== undefined) this.char(c, code.length, atMs);
    }
    if (!this.wordDone && this.charDone && gap > this.dit * 5) {
      this.wordDone = true;
      if (!this.held) this.out(" ", atMs, Math.round(this.snrDb));
    }
    // A held E or T with nothing after it was noise.
    if (this.held && gap > this.dit * 10) this.held = null;
  }

  /**
   * A single dit or dah after a long silence is more often noise at the end of a signal
   * than an E or a T: hold it until something follows.
   */
  private char(c: string, elements: number, atMs: number): void {
    const snr = Math.round(this.snrDb);
    const quietBefore = this.t - this.lastCharT > this.dit * 14;
    this.lastCharT = this.t;
    if (elements === 1 && quietBefore) {
      this.held = { c, at: atMs };
      return;
    }
    if (this.held) {
      this.out(this.held.c, this.held.at, snr);
      this.held = null;
    }
    this.out(c, atMs, snr);
  }

  private markEnded(ms: number): void {
    // Follow the sender's speed. Recent marks fall in two clusters, dits and dahs; with both
    // present the dit is the short cluster's mean. Otherwise each mark nudges the estimate.
    this.marks.push(ms);
    if (this.marks.length > 16) this.marks.shift();
    const sorted = [...this.marks].sort((a, b) => a - b);
    const lo = sorted[0]!;
    const hi = sorted.at(-1)!;
    if (sorted.length >= 4 && hi > lo * 2.2) {
      const split = Math.sqrt(lo * hi);
      const short = sorted.filter((x) => x < split);
      const est = short.reduce((a, b) => a + b, 0) / short.length;
      this.dit = Math.max(24, Math.min(240, decay(this.dit, est, 2)));
    } else {
      const unit = ms > this.dit * 2 ? ms / 3 : ms;
      this.dit = Math.max(24, Math.min(240, decay(this.dit, unit, 6)));
    }
    // Narrow or widen the filter when the speed has moved a fair way from what it was set for.
    const want = boxFor(this.dit);
    if (Math.abs(want - this.box) > this.box * 0.25) {
      this.box = want;
      this.bb = new Baseband(this.freqHz, DECIM, want);
    }
    this.code += ms > this.dit * 2 ? "-" : ".";
    if (this.code.length > 8) this.code = "";
    this.charDone = false;
    this.wordDone = false;
  }

  retune(hz: number): void {
    this.freqHz = hz;
    this.bb.setFreq(hz);
  }

  close(): void {}
}


export class CwReceiver implements KeyReceiver {
  private _rxHz = 700;
  muted = false;
  private chans: ChannelSet<CwDemod>;
  private readonly scanner: SignalScanner;
  private gen = 0;
  private nowMs = 0;

  constructor(private readonly onLine: (l: KeyLine) => void) {
    this.chans = this.makeSet();
    this.scanner = new SignalScanner({ widthHz: 8, minSnrDb: 8, minHz: 200, maxHz: 2900, minSepHz: 70 }, (found) => {
      this.chans.found(found, this.nowMs);
      this.chans.each((d) => (d.noisePow = this.scanner.noiseAt(d.freqHz, BOX)));
    });
    this.chans.setRx(this._rxHz);
  }

  private makeSet() {
    return new ChannelSet<CwDemod>(
      (hz, isRx) => {
        const stream = new TextStream(`cw-${this.gen}-${Math.round(hz)}-${isRx ? "rx" : "b"}`, this.onLine, 6_000);
        const d = new CwDemod(hz, (ch, at, snr) => stream.put(ch, at, d.freqHz, snr, isRx));
        d.close = () => stream.close();
        return d;
      },
      50,
      20_000,
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
