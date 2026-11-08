/**
 * JS8 submode parameters (JS8Call-improved JS8_Include/commons.h, JS8_Mode/JS8Submode.cpp,
 * JS8_Mode/JS8.h and the per-mode decoder constants at the top of JS8_Mode/JS8.cpp).
 *
 * Every JS8 frame is 79 8-FSK symbols: three 7-symbol Costas arrays at symbols 0, 36 and 72
 * bracketing 58 data symbols. The submodes differ only in symbol length (and therefore tone
 * spacing and bandwidth), period, start delay and which Costas arrays they use. Normal keeps
 * the FT8 array three times over; the other submodes use three different arrays so that a
 * Normal decoder can't lock onto them by accident.
 */

export type Js8Submode = "normal" | "fast" | "turbo" | "slow";

/** 3 × 7 Costas tone patterns, one per sync block (start, middle, end). */
export type CostasArrays = readonly [readonly number[], readonly number[], readonly number[]];

export const COSTAS_ORIGINAL: CostasArrays = [
  [4, 2, 5, 6, 1, 3, 0],
  [4, 2, 5, 6, 1, 3, 0],
  [4, 2, 5, 6, 1, 3, 0],
];

export const COSTAS_MODIFIED: CostasArrays = [
  [0, 6, 2, 3, 5, 4, 1],
  [1, 5, 0, 2, 3, 6, 4],
  [2, 5, 0, 6, 4, 1, 3],
];

export const NUM_SYMBOLS = 79;
export const NUM_DATA_SYMBOLS = 58;
export const SYNC_POSITIONS = [0, 36, 72] as const;
export const RX_SAMPLE_RATE = 12000;

/**
 * Varicode's 72-bit frame alphabet. A frame is 12 six-bit words, so only the first 64
 * characters can actually appear in a frame (JS8.cpp's encoder uses exactly those 64);
 * the trailing "/?." exist in Varicode.cpp's string but never index a 6-bit word.
 */
export const ALPHABET72 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-+/?.";
export const FRAME_ALPHABET = ALPHABET72.slice(0, 64);

export interface Js8SubmodeParams {
  readonly name: Js8Submode;
  /** JS8Call's single-letter decoder name (A, B, C, E) and its submode id bit. */
  readonly letter: "A" | "B" | "C" | "E";
  readonly submodeId: number;
  /** Samples per symbol at 12 kHz. */
  readonly nsps: number;
  readonly periodSec: number;
  readonly startDelayMs: number;
  readonly costas: CostasArrays;
  readonly toneSpacingHz: number;
  readonly bandwidthHz: number;
  /** 79 symbols' worth of audio, in seconds. */
  readonly dataDurationSec: number;
  /** Start delay plus data duration: when the transmission ends, relative to the period start. */
  readonly txDurationSec: number;
  /** JS8Submode.cpp samplesNeeded(): symbols plus start delay plus half a second of slack. */
  readonly samplesNeeded: number;
  /** JS8Call's display threshold for "weak" decodes, kept for callers. */
  readonly rxSnrThreshold: number;

  // Decoder tuning constants from JS8.cpp's Mode structs.
  /** Samples per symbol after downsampling to baseband. */
  readonly ndownsps: number;
  /** Length of the raised-cosine taper on the downsampler's band edges, in FFT bins. */
  readonly ndd: number;
  /** Coarse sync search range in quarter-symbol steps either side of the nominal start. */
  readonly jz: number;
  /** Nominal start of the signal within the decode window, in seconds (= start delay). */
  readonly astart: number;
  /** dB offset subtracted from the noise baseline before the SNR estimate. */
  readonly basesub: number;
  /** Candidates closer than this many Hz to a stronger one are dropped as duplicates. */
  readonly azHz: number;
}

function make(
  name: Js8Submode,
  letter: Js8SubmodeParams["letter"],
  submodeId: number,
  nsps: number,
  periodSec: number,
  startDelayMs: number,
  costas: CostasArrays,
  rxSnrThreshold: number,
  dec: { ndownsps: number; ndd: number; jz: number; basesub: number; azFactor: number },
): Js8SubmodeParams {
  const samplesForSymbols = NUM_SYMBOLS * nsps;
  const dataDurationSec = samplesForSymbols / RX_SAMPLE_RATE;
  return {
    name,
    letter,
    submodeId,
    nsps,
    periodSec,
    startDelayMs,
    costas,
    toneSpacingHz: RX_SAMPLE_RATE / nsps,
    bandwidthHz: Math.floor((8 * RX_SAMPLE_RATE) / nsps),
    dataDurationSec,
    txDurationSec: dataDurationSec + startDelayMs / 1000,
    samplesNeeded: Math.floor(samplesForSymbols + (0.5 + startDelayMs / 1000) * RX_SAMPLE_RATE),
    rxSnrThreshold,
    ndownsps: dec.ndownsps,
    ndd: dec.ndd,
    jz: dec.jz,
    astart: startDelayMs / 1000,
    basesub: dec.basesub,
    azHz: (RX_SAMPLE_RATE / nsps) * dec.azFactor,
  };
}

export const JS8_SUBMODES: Readonly<Record<Js8Submode, Js8SubmodeParams>> = {
  normal: make("normal", "A", 0, 1920, 15, 500, COSTAS_ORIGINAL, -24, { ndownsps: 32, ndd: 100, jz: 62, basesub: 40, azFactor: 0.64 }),
  fast: make("fast", "B", 1, 1200, 10, 200, COSTAS_MODIFIED, -22, { ndownsps: 20, ndd: 100, jz: 144, basesub: 39, azFactor: 0.8 }),
  turbo: make("turbo", "C", 2, 600, 6, 100, COSTAS_MODIFIED, -20, { ndownsps: 12, ndd: 120, jz: 172, basesub: 38, azFactor: 0.6 }),
  // JS8.cpp notes the Fortran used NDD=90 and a 28 s period for Slow; the C++ uses 94 and 30.
  slow: make("slow", "E", 4, 3840, 30, 500, COSTAS_MODIFIED, -28, { ndownsps: 32, ndd: 94, jz: 32, basesub: 42, azFactor: 0.64 }),
};

export function js8Params(submode: Js8Submode | Js8SubmodeParams): Js8SubmodeParams {
  return typeof submode === "string" ? JS8_SUBMODES[submode] : submode;
}
