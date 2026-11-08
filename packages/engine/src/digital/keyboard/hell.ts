/**
 * Hellschreiber (Feld Hell and its faster and slower cousins). Hell is not decoded to
 * text: the sender "prints" each character as a 7-column grid of on/off pixels, every
 * column sent bottom to top, and the receiver prints what it hears the same way. The
 * eye does the reading, so a weak or drifting signal still copies where a decoder would
 * give up.
 *
 * Feld Hell: 14 pixels a column, 7 columns a character, 2.5 characters a second (245
 * pixels a second, "122.5 baud"), on/off keyed carrier with shaped edges. Slow Hell is an
 * eighth of that speed, Hell x5 and x9 five and nine times it (ADIF SLOWHELL, HELLX5,
 * HELLX9; Feld Hell itself is plain HELL). Rates are fldigi's (feld.cxx column rates
 * 17.5, 2.1875, 87.5, 157.5).
 *
 * Hell 80 is FSK too, at twice Feld Hell's speed with the tones 300 Hz apart (fldigi's
 * HELL80; ADIF MODE HELL, SUBMODE HELL80).
 *
 * FSK Hell (FSKH105, FSKH245) prints at Feld Hell's rate but never keys off: ink is a
 * tone half the shift below the marker, paper a tone half the shift above (fldigi's
 * send_symbol), 55 Hz apart in FSKH105 and 122.5 Hz in FSKH245. The carrier never drops,
 * so it suits a busy band and a weak path; the Feld Hell Club's North American nets run
 * FSKH105. Logged as MODE HELL, SUBMODE FSKHELL.
 *
 * The font is our own 5×7 dot matrix, each dot row sent as two pixels so a character
 * fills the 14-pixel column, with a blank column either side.
 */
import { Baseband, decay, RATE, type KeyReceiver } from "./common.ts";

export type HellSpeed = "feld" | "slow" | "x5" | "x9" | "fsk105" | "fsk245" | "hell80";
export const HELL_SPEEDS: Record<HellSpeed, { label: string; pxPerSec: number; submode: string | null; /** FSK Hell: Hz between the ink and paper tones. */ shiftHz?: number }> = {
  feld: { label: "Feld Hell", pxPerSec: 245, submode: null },
  slow: { label: "Slow Hell", pxPerSec: 30.625, submode: "SLOWHELL" },
  x5: { label: "Hell x5", pxPerSec: 1225, submode: "HELLX5" },
  x9: { label: "Hell x9", pxPerSec: 2205, submode: "HELLX9" },
  fsk105: { label: "FSK Hell 105", pxPerSec: 245, submode: "FSKHELL", shiftHz: 55 },
  fsk245: { label: "FSK Hell 245", pxPerSec: 245, submode: "FSKHELL", shiftHz: 122.5 },
  hell80: { label: "Hell 80", pxPerSec: 490, submode: "HELL80", shiftHz: 300 },
};
export const isHellSpeed = (s: unknown): s is HellSpeed => typeof s === "string" && s in HELL_SPEEDS;

/** Pixels in a column. */
export const HELL_ROWS = 14;
/** Columns in a character cell. */
export const HELL_COLS = 7;
/** The longest one message may key, so a slow speed cannot hold the radio for many minutes. */
export const HELL_MAX_MS = 180_000;

// 5×7 glyphs, top row first, "#" for ink.
const GLYPHS: Record<string, string> = {
  A: ".###. #...# #...# ##### #...# #...# #...#",
  B: "####. #...# #...# ####. #...# #...# ####.",
  C: ".###. #...# #.... #.... #.... #...# .###.",
  D: "####. #...# #...# #...# #...# #...# ####.",
  E: "##### #.... #.... ####. #.... #.... #####",
  F: "##### #.... #.... ####. #.... #.... #....",
  G: ".###. #...# #.... #.### #...# #...# .####",
  H: "#...# #...# #...# ##### #...# #...# #...#",
  I: ".###. ..#.. ..#.. ..#.. ..#.. ..#.. .###.",
  J: "..### ...#. ...#. ...#. ...#. #..#. .##..",
  K: "#...# #..#. #.#.. ##... #.#.. #..#. #...#",
  L: "#.... #.... #.... #.... #.... #.... #####",
  M: "#...# ##.## #.#.# #.#.# #...# #...# #...#",
  N: "#...# #...# ##..# #.#.# #..## #...# #...#",
  O: ".###. #...# #...# #...# #...# #...# .###.",
  P: "####. #...# #...# ####. #.... #.... #....",
  Q: ".###. #...# #...# #...# #.#.# #..#. .##.#",
  R: "####. #...# #...# ####. #.#.. #..#. #...#",
  S: ".#### #.... #.... .###. ....# ....# ####.",
  T: "##### ..#.. ..#.. ..#.. ..#.. ..#.. ..#..",
  U: "#...# #...# #...# #...# #...# #...# .###.",
  V: "#...# #...# #...# #...# #...# .#.#. ..#..",
  W: "#...# #...# #...# #.#.# #.#.# #.#.# .#.#.",
  X: "#...# #...# .#.#. ..#.. .#.#. #...# #...#",
  Y: "#...# #...# .#.#. ..#.. ..#.. ..#.. ..#..",
  Z: "##### ....# ...#. ..#.. .#... #.... #####",
  "0": ".###. #...# #..## #.#.# ##..# #...# .###.",
  "1": "..#.. .##.. ..#.. ..#.. ..#.. ..#.. .###.",
  "2": ".###. #...# ....# ...#. ..#.. .#... #####",
  "3": "##### ...#. ..#.. ...#. ....# #...# .###.",
  "4": "...#. ..##. .#.#. #..#. ##### ...#. ...#.",
  "5": "##### #.... ####. ....# ....# #...# .###.",
  "6": "..##. .#... #.... ####. #...# #...# .###.",
  "7": "##### ....# ...#. ..#.. .#... .#... .#...",
  "8": ".###. #...# #...# .###. #...# #...# .###.",
  "9": ".###. #...# #...# .#### ....# ...#. .##..",
  ".": "..... ..... ..... ..... ..... .##.. .##..",
  ",": "..... ..... ..... ..... .##.. ..#.. .#...",
  "?": ".###. #...# ....# ...#. ..#.. ..... ..#..",
  "!": "..#.. ..#.. ..#.. ..#.. ..#.. ..... ..#..",
  "/": "..... ....# ...#. ..#.. .#... #.... .....",
  "-": "..... ..... ..... ##### ..... ..... .....",
  "+": "..... ..#.. ..#.. ##### ..#.. ..#.. .....",
  "=": "..... ..... ##### ..... ##### ..... .....",
  ":": "..... .##.. .##.. ..... .##.. .##.. .....",
  ";": "..... .##.. .##.. ..... .##.. ..#.. .#...",
  "'": "..#.. ..#.. .#... ..... ..... ..... .....",
  '"': ".#.#. .#.#. ..... ..... ..... ..... .....",
  "(": "...#. ..#.. .#... .#... .#... ..#.. ...#.",
  ")": ".#... ..#.. ...#. ...#. ...#. ..#.. .#...",
  "@": ".###. #...# ....# .##.# #.#.# #.#.# .###.",
  "#": ".#.#. .#.#. ##### .#.#. ##### .#.#. .#.#.",
  "&": ".##.. #..#. #.#.. .#... #.#.# #..#. .##.#",
  "*": "..... ..#.. #.#.# .###. #.#.# ..#.. .....",
  "<": "...#. ..#.. .#... #.... .#... ..#.. ...#.",
  ">": ".#... ..#.. ...#. ....# ...#. ..#.. .#...",
  " ": "..... ..... ..... ..... ..... ..... .....",
};

/**
 * Pixels each dot row takes, bottom row first: seven rows into twelve pixels, with one pixel
 * of paper above and below so the two printed copies of a line do not touch, and so a
 * receiver can find the gap between them to line a column up on (fldigi's fonts
 * leave the same gap). The outer rows and the middle get two pixels, the two rows
 * between them one each.
 */
const ROW_PIXELS = [2, 2, 1, 2, 1, 2, 2];

/** Each character's 7 columns, as 14-bit masks with bit 0 the bottom pixel (sent first). */
const CELLS = new Map<string, number[]>();
for (const [ch, art] of Object.entries(GLYPHS)) {
  const rows = art.split(" ");
  if (rows.length !== 7 || rows.some((r) => r.length !== 5)) throw new Error(`Hell glyph ${ch} is not 5×7`);
  const cols = [0];
  for (let c = 0; c < 5; c++) {
    let m = 0;
    let p = 1; // pixel 0 is paper
    for (let r = 6; r >= 0; r--) {
      // dot row r (top 0), bottom row first
      for (let k = 0; k < ROW_PIXELS[6 - r]!; k++, p++) if (rows[r]![c] === "#") m |= 1 << p;
    }
    cols.push(m);
  }
  cols.push(0);
  CELLS.set(ch, cols);
}

/** Text as Hell can print it: capitals and the characters the font has. */
export function hellText(text: string): string {
  return [...text.toUpperCase().replace(/\s+/g, " ")].filter((c) => CELLS.has(c)).join("").replace(/ {2,}/g, " ").trim();
}

/** The columns of some text, each a 14-bit mask (bit 0 the bottom pixel). */
export function hellColumns(text: string): number[] {
  const out: number[] = [];
  for (const c of hellText(text)) out.push(...CELLS.get(c)!);
  return out;
}

/** How long a message keys at a speed, ms (with the blank lead-in and tail). */
export function hellDurationMs(text: string, speed: HellSpeed): number {
  const cols = hellColumns(text).length + 2 * HELL_COLS * 2;
  return ((cols * HELL_ROWS) / HELL_SPEEDS[speed].pxPerSec) * 1000;
}

/**
 * Audio for a message: a carrier at `freqHz` keyed pixel by pixel (FSK Hell: moved
 * between its two tones, phase-continuous, `reverse` swapping them). The keying is
 * smoothed by two passes of a running average, about 0.6 of a pixel in all, a near
 * raised-cosine edge that keeps Feld Hell about 350 Hz wide.
 */
export function hellWaveform(text: string, freqHz: number, sampleRate: number, speed: HellSpeed, reverse = false): Float32Array {
  const lead = new Array<number>(HELL_COLS * 2).fill(0);
  const cols = [...lead, ...hellColumns(text), ...lead];
  const pxRate = HELL_SPEEDS[speed].pxPerSec;
  const perPx = sampleRate / pxRate;
  const n = Math.round(cols.length * HELL_ROWS * perPx);
  const env = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const px = Math.floor(i / perPx);
    const col = cols[Math.floor(px / HELL_ROWS)] ?? 0;
    env[i] = (col >> px % HELL_ROWS) & 1;
  }
  const half = Math.max(1, Math.round(perPx * 0.3));
  const smooth = (x: Float32Array) => {
    const y = new Float32Array(x.length);
    let s = 0;
    for (let i = 0; i < x.length; i++) {
      s += x[i]!;
      if (i >= half) s -= x[i - half]!;
      y[Math.max(0, i - (half >> 1))] = s / half;
    }
    return y;
  };
  const shaped = smooth(smooth(env));
  const out = new Float32Array(n);
  const shift = HELL_SPEEDS[speed].shiftHz;
  if (shift) {
    // Ink low, paper high; 10 ms ramps at the ends so the carrier starts and stops cleanly.
    const ramp = Math.round(0.01 * sampleRate);
    const sign = reverse ? -1 : 1;
    let ph = 0;
    for (let i = 0; i < n; i++) {
      const f = freqHz + sign * (shift / 2) * (1 - 2 * shaped[i]!);
      ph += (2 * Math.PI * f) / sampleRate;
      const a = Math.min(1, i / ramp, (n - 1 - i) / ramp);
      out[i] = 0.9 * a * Math.sin(ph);
    }
    return out;
  }
  const w = (2 * Math.PI * freqHz) / sampleRate;
  for (let i = 0; i < n; i++) out[i] = 0.9 * shaped[i]! * Math.sin(w * i);
  return out;
}

// ---------------------------------------------------------------------------
// Receive
// ---------------------------------------------------------------------------

/** Columns heard: `px` holds HELL_ROWS bytes a column (bottom pixel first), 0 blank to 255 full ink. */
export interface HellChunk {
  at: number;
  freqHz: number;
  tx: boolean;
  px: Uint8Array;
}

/**
 * Prints what it hears at the operator's frequency. The signal is mixed to baseband and
 * averaged over one pixel (a filter matched to the pixel, 245 Hz wide at Feld Hell), and
 * its strength over each pixel time becomes that pixel's ink. Black is the noise floor
 * (followed down quickly and up slowly), full ink the recent peak, so the print keeps its
 * contrast as the signal fades; the peak never falls within 12 dB of the floor, so noise
 * alone prints as faint speckle rather than as a black page.
 *
 * FSK Hell: the ink is where the signal's frequency sits between its two tones (low is
 * ink), measured sample to sample and averaged over the pixel. The centre between the
 * tones is followed, so a marker a little off still prints evenly; and the ink is scaled
 * by how far the signal stands above the noise either side of it (300 Hz away, more for
 * Hell 80), so an
 * empty channel prints as paper rather than as the random frequency of noise.
 */
export class HellReceiver implements KeyReceiver {
  private bb: Baseband;
  private readonly pxPerSample: number;
  private pos = 0;
  private acc = 0;
  private accN = 0;
  private col = new Uint8Array(HELL_ROWS);
  private row = 0;
  private out: number[] = [];
  private floor = 0;
  private peak = 0;
  private readonly floorUp: number;
  private readonly peakDown: number;
  /** Columns to gather before passing them on: about a fifth of a second of print. */
  private readonly batch: number;
  private _rxHz = 1000;
  muted = false;
  // FSK Hell
  private readonly shift: number;
  private readonly magRate: number;
  private prevRe = 0;
  private prevIm = 0;
  private hi: number;
  private lo: number;
  private noiseBb: Baseband[] = [];
  private readonly noiseOff: number;
  private noise = [0, 0];
  private noiseAvg = [0, 0];
  private cross = 0;
  private dot = 0;

  constructor(
    private readonly emit: (c: HellChunk) => void,
    readonly speed: HellSpeed = "feld",
    readonly reverse = false,
  ) {
    const pxRate = HELL_SPEEDS[speed].pxPerSec;
    // About four magnitude samples a pixel.
    const decim = Math.max(1, Math.round(RATE / (pxRate * 4)));
    const box = Math.max(2, Math.round(RATE / pxRate));
    this.bb = new Baseband(this._rxHz, decim, box);
    this.shift = HELL_SPEEDS[speed].shiftHz ?? 0;
    this.magRate = RATE / decim;
    this.hi = this.shift / 2;
    this.lo = -this.shift / 2;
    // The noise references sit clear of both tones and the pixel filter's width: 300 Hz
    // out for the narrow modes, further for Hell 80.
    this.noiseOff = Math.max(300, this.shift / 2 + pxRate);
    if (this.shift) this.noiseBb = [new Baseband(this._rxHz - this.noiseOff, decim, box), new Baseband(this._rxHz + this.noiseOff, decim, box)];
    this.pxPerSample = (pxRate * decim) / RATE;
    const magRate = RATE / decim;
    this.floorUp = magRate * 4; // the floor climbs back over about 4 s
    this.peakDown = magRate * 3; // the peak lets go over about 3 s
    this.batch = HELL_ROWS * Math.max(1, Math.round((pxRate / HELL_ROWS) * 0.2));
  }

  get rxHz(): number {
    return this._rxHz;
  }

  set rxHz(hz: number) {
    this._rxHz = hz;
    this.bb.setFreq(hz);
    this.noiseBb[0]?.setFreq(hz - this.noiseOff);
    this.noiseBb[1]?.setFreq(hz + this.noiseOff);
    this.hi = this.shift / 2;
    this.lo = -this.shift / 2;
  }

  reset(): void {
    this.pos = 0;
    this.acc = 0;
    this.accN = 0;
    this.row = 0;
    this.out = [];
  }

  push(samples: Float32Array, firstSampleMs: number): void {
    if (this.muted) return;
    if (this.shift) this.pushFsk(samples);
    else this.bb.push(samples, (re, im) => {
      const m = Math.hypot(re, im);
      this.floor = m < this.floor || this.floor === 0 ? decay(this.floor, m, 8) : decay(this.floor, m, this.floorUp);
      this.peak = m > this.peak ? decay(this.peak, m, 2) : decay(this.peak, m, this.peakDown);
      this.acc += m;
      this.accN++;
      this.pos += this.pxPerSample;
      if (this.pos < 1) return;
      this.pos -= 1;
      const v = this.acc / this.accN;
      this.acc = 0;
      this.accN = 0;
      const top = Math.max(this.peak, this.floor * 4);
      this.pixel((v - this.floor) / Math.max(1e-12, top - this.floor));
    });
    this.flush(firstSampleMs);
  }

  private pixel(ink: number): void {
    this.col[this.row++] = Math.round(Math.max(0, Math.min(1, ink)) * 255);
    if (this.row === HELL_ROWS) {
      this.row = 0;
      for (const b of this.col) this.out.push(b);
    }
  }

  private pushFsk(samples: Float32Array): void {
    // Noise either side: each smoothed over about 50 ms, then its quiet level kept (it
    // falls in about 0.2 s and climbs back over about 10), so a signal passing through a
    // reference channel (FT8 next door) does not count as noise.
    this.noiseBb.forEach((nb, k) =>
      nb.push(samples, (re, im) => {
        const m = Math.hypot(re, im);
        const avg = (this.noiseAvg[k] = this.noiseAvg[k] ? decay(this.noiseAvg[k]!, m, this.magRate * 0.05) : m);
        const q = this.noise[k]!;
        this.noise[k] = !q ? avg : avg < q ? decay(q, avg, this.magRate * 0.2) : decay(q, avg, this.magRate * 10);
      }),
    );
    const half = this.shift / 2;
    // The tones' centre is followed over about 30 pixels of signal.
    const follow = 30;
    this.bb.push(samples, (re, im) => {
      // Phase step from the last sample, as a vector: summed over the pixel, louder
      // samples count for more and noise spikes cannot wrap, a steadier estimate of the
      // frequency than averaging the steps' angles.
      this.cross += im * this.prevRe - re * this.prevIm;
      this.dot += re * this.prevRe + im * this.prevIm;
      this.prevRe = re;
      this.prevIm = im;
      this.acc += Math.hypot(re, im);
      this.accN++;
      this.pos += this.pxPerSample;
      if (this.pos < 1) return;
      this.pos -= 1;
      const hz = (Math.atan2(this.cross, this.dot) * this.magRate) / (2 * Math.PI);
      const m = this.acc / this.accN;
      this.cross = 0;
      this.dot = 0;
      this.acc = 0;
      this.accN = 0;
      const n = Math.min(this.noise[0]!, this.noise[1]!) || m;
      const sure = Math.max(0, Math.min(1, (m / n - 1.6) / 1.4));
      // Follow the two tones (only while there is a signal), within a shift of the marker.
      if (sure > 0.5 && Math.abs(hz) < this.shift * 1.5) {
        if (hz > (this.hi + this.lo) / 2) this.hi = decay(this.hi, hz, follow);
        else this.lo = decay(this.lo, hz, follow);
        const c = Math.max(-this.shift, Math.min(this.shift, (this.hi + this.lo) / 2));
        this.hi = Math.max(this.hi, c + half / 2);
        this.lo = Math.min(this.lo, c - half / 2);
      }
      const dev = (hz - (this.hi + this.lo) / 2) / half;
      const ink = 0.5 - (this.reverse ? -0.5 : 0.5) * Math.max(-1, Math.min(1, dev));
      this.pixel(ink * sure);
    });
  }

  private flush(firstSampleMs: number): void {
    // Audio arrives in packets of a few milliseconds; send the print on in readable pieces.
    if (this.out.length >= this.batch) {
      this.emit({ at: firstSampleMs, freqHz: this._rxHz, tx: false, px: Uint8Array.from(this.out) });
      this.out = [];
    }
  }
}

/** What we sent, as printed columns (for showing our own transmission on the tape). */
export function hellPrint(text: string): Uint8Array {
  const cols = hellColumns(text);
  const px = new Uint8Array(cols.length * HELL_ROWS);
  cols.forEach((m, c) => {
    for (let r = 0; r < HELL_ROWS; r++) px[c * HELL_ROWS + r] = (m >> r) & 1 ? 255 : 0;
  });
  return px;
}
