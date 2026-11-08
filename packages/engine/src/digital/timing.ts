/**
 * FT8/FT4 timing. Windows are numbered from the Unix epoch: index = floor(t / period).
 * Parity is index & 1. TX audio starts 0.5 s into a window (WSJT-X convention).
 *
 *            period  on-air   cut (decode starts)
 *   FT8      15.0 s  12.64 s  14.0 s   → positive DT room ≈ 0.86 s
 *   FT4       7.5 s   5.04 s   6.3 s   → positive DT room ≈ 0.76 s
 *   FT2      3.75 s   2.52 s  3.15 s   → FT4 at twice the symbol rate (Decodium, IU8LMC);
 *                                        TX starts 0.25 s in, the middle of what Decodium
 *                                        does (0 s on Linux, 0.3 s elsewhere)
 *
 * Late-start tolerance: how late a transmission may begin and still be decoded by the
 * other side. Measured on the previous install: FT8 decodes ~2 s late, FT4 dies past
 * ~0.9 s; tolerance is kept well inside those.
 *
 * A first call the operator clicks gets more room (manualLateMs), because decodes appear
 * about a second into the next window and a person needs a moment to click. A late start
 * skips the part of the message already missed; measured with ft8ts at a couple of dB
 * above the decode threshold, every message still decoded with FT8 2 s, FT4 0.6 s and
 * FT2 0.3 s cut from the front (scratch/late-start.ts).
 */
export type DigitalMode = "FT8" | "FT4" | "FT2";
export const DIGITAL_MODES: readonly DigitalMode[] = ["FT8", "FT4", "FT2"];
export const isDigitalMode = (m: string): m is DigitalMode => (DIGITAL_MODES as readonly string[]).includes(m);
/** Everything the Operate page can select: the slotted modes plus the keyboard modes, which are untimed. */
export type OperatingMode = DigitalMode | "JTTY" | "RTTY" | "PSK31" | "CW" | "HELL" | "SSTV" | "WSPR" | "JS8";
export const OPERATING_MODES: readonly OperatingMode[] = ["FT8", "FT4", "FT2", "JTTY", "RTTY", "PSK31", "CW", "HELL", "SSTV", "WSPR", "JS8"];
/** Modes a dial frequency identifies by itself (channelised). RTTY, PSK31 and CW are tuned freely. */
const DIAL_MODES: readonly OperatingMode[] = ["FT8", "FT4", "FT2", "JTTY", "WSPR", "JS8"];
/** Modes the operator tunes around in; retuning keeps them. */
export const FREE_TUNING: readonly OperatingMode[] = ["RTTY", "PSK31", "CW", "HELL", "SSTV"];

export interface ModeTiming {
  periodMs: number;
  txStartMs: number;
  txLenMs: number;
  cutMs: number;
  lateLimitMs: number;
  manualLateMs: number;
}

export const TIMING: Record<DigitalMode, ModeTiming> = {
  FT8: { periodMs: 15_000, txStartMs: 500, txLenMs: 12_640, cutMs: 14_000, lateLimitMs: 1_200, manualLateMs: 2_000 },
  FT4: { periodMs: 7_500, txStartMs: 500, txLenMs: 5_040, cutMs: 6_300, lateLimitMs: 700, manualLateMs: 600 },
  FT2: { periodMs: 3_750, txStartMs: 250, txLenMs: 2_520, cutMs: 3_150, lateLimitMs: 300, manualLateMs: 300 },
};

export function windowIndex(t: number, mode: DigitalMode): number {
  return Math.floor(t / TIMING[mode].periodMs);
}

export function windowStart(index: number, mode: DigitalMode): number {
  return index * TIMING[mode].periodMs;
}

export function txStartAt(index: number, mode: DigitalMode): number {
  return windowStart(index, mode) + TIMING[mode].txStartMs;
}

export const parity = (index: number): 0 | 1 => (index & 1) as 0 | 1;

/** "even" windows start at :00 and :30 in FT8 (WSJT-X's "Tx even/1st"). */
export const parityName = (p: 0 | 1): "even" | "odd" => (p === 0 ? "even" : "odd");

/** The next window with the given parity whose TX can still start in time. */
export function nextTxWindow(now: number, mode: DigitalMode, ourParity: 0 | 1, lateMs = TIMING[mode].lateLimitMs): number {
  let i = windowIndex(now, mode);
  for (;;) {
    if (parity(i) === ourParity && now <= txStartAt(i, mode) + lateMs - 150) return i;
    i++;
  }
}

/** Dial frequencies (USB), Hz, for the US plan. The plan in use is CALLING_FREQS. */
const BASE_FREQS: Record<OperatingMode, Record<string, number>> = {
  FT8: {
    "160M": 1_840_000,
    "80M": 3_573_000,
    "60M": 5_357_000,
    "40M": 7_074_000,
    "30M": 10_136_000,
    "20M": 14_074_000,
    "17M": 18_100_000,
    "15M": 21_074_000,
    "12M": 24_915_000,
    "10M": 28_074_000,
    "6M": 50_313_000,
    "2M": 144_174_000,
  },
  FT4: {
    "80M": 3_575_000,
    "40M": 7_047_500,
    "30M": 10_140_000,
    "20M": 14_080_000,
    "17M": 18_104_000,
    "15M": 21_140_000,
    "12M": 24_919_000,
    "10M": 28_180_000,
    "6M": 50_318_000,
    "2M": 144_170_000,
  },
  // Decodium's defaults (models/FrequencyList.cpp).
  FT2: {
    "160M": 1_843_000,
    "80M": 3_568_000,
    "60M": 5_360_000,
    "40M": 7_062_000,
    "30M": 10_144_000,
    "20M": 14_084_000,
    "17M": 18_108_000,
    "15M": 21_144_000,
    "12M": 24_923_000,
    "10M": 28_184_000,
    "6M": 50_316_000,
    "2M": 144_177_000,
  },
  // WSJT-X 3.3's defaults (models/FrequencyList.cpp). 30 m and 17 m share FT4's.
  JTTY: {
    "160M": 1_839_000,
    "80M": 3_572_000,
    "40M": 7_078_000,
    "30M": 10_140_000,
    "20M": 14_090_000,
    "17M": 18_104_000,
    "15M": 21_090_000,
    "12M": 24_920_000,
    "10M": 28_090_000,
    "6M": 50_160_000,
    "2M": 144_160_000,
  },
  // Where each band's activity is, as a USB dial with the signals between 300 and 2700 Hz.
  RTTY: {
    "80M": 3_580_000,
    "40M": 7_080_000,
    "20M": 14_080_000,
    "17M": 18_100_000,
    "15M": 21_080_000,
    "12M": 24_920_000,
    "10M": 28_080_000,
  },
  PSK31: {
    "160M": 1_838_000,
    "80M": 3_580_000,
    "40M": 7_070_000,
    "30M": 10_142_000,
    "20M": 14_070_000,
    "17M": 18_100_000,
    "15M": 21_070_000,
    "12M": 24_920_000,
    "10M": 28_120_000,
    "6M": 50_290_000,
  },
  // JS8Call's default dial frequencies. 40 m shares JTTY's, 17 m FT4's and 6 m FT4's.
  JS8: {
    "160M": 1_842_000,
    "80M": 3_578_000,
    "60M": 5_357_000,
    "40M": 7_078_000,
    "30M": 10_130_000,
    "20M": 14_078_000,
    "17M": 18_104_000,
    "15M": 21_078_000,
    "12M": 24_922_000,
    "10M": 28_078_000,
    "6M": 50_318_000,
    "2M": 144_178_000,
  },
  // WSPR dial frequencies (WSJT-X's defaults); the signals are 1400-1600 Hz above.
  WSPR: {
    "160M": 1_836_600,
    "80M": 3_568_600,
    "60M": 5_364_700,
    "40M": 7_038_600,
    "30M": 10_138_700,
    "20M": 14_095_600,
    "17M": 18_104_600,
    "15M": 21_094_600,
    "12M": 24_924_600,
    "10M": 28_124_600,
    "6M": 50_293_000,
    "2M": 144_489_000,
  },
  // Hell: the Feld Hell Club's frequency list (sites.google.com/site/feldhellclub,
  // checked November 2026), as the club writes them: the signal on the waterfall, which
  // is the dial plus a 1500 Hz tone. So each dial here is the club's frequency less
  // 1.5 kHz; with the marker at 1500 Hz the signal lands on it. Ranges are given at their
  // low end plus 2 kHz, clear of FT8 below them (80 m 3.578-3.586, 40 m 7.080-7.090, 30 m
  // 10.137-10.143, 17 m 18.098-18.105); the others are the club's spot frequencies.
  HELL: {
    "160M": 1_841_500,
    "80M": 3_578_500,
    "40M": 7_080_500,
    "30M": 10_137_500,
    "20M": 14_061_500,
    "17M": 18_098_500,
    "15M": 21_061_500,
    "12M": 24_922_500,
    "10M": 28_061_500,
    "6M": 50_284_500,
  },
  // SSTV calling frequencies (USB; the picture is 1200-2300 Hz audio, no offset).
  SSTV: {
    "80M": 3_845_000,
    "40M": 7_171_000,
    "20M": 14_230_000,
    "15M": 21_340_000,
    "10M": 28_680_000,
    "6M": 50_680_000,
  },
  // The CW end of each band; the tone is the offset, so 14.030 + 700 Hz is 14.0307 on the air.
  CW: {
    "160M": 1_810_000,
    "80M": 3_530_000,
    "60M": 5_351_500,
    "40M": 7_030_000,
    "30M": 10_110_000,
    "20M": 14_030_000,
    "17M": 18_080_000,
    "15M": 21_030_000,
    "12M": 24_900_000,
    "10M": 28_030_000,
    "6M": 50_090_000,
  },
};

export const BAND_PLANS = ["us", "r1", "r2", "r3"] as const;
export type BandPlan = (typeof BAND_PLANS)[number];

/**
 * Where a band plan differs from the base table (null: no frequency there).
 *
 * 60 m no longer differs: since FCC 25-60 (2026) the US has the WRC-15 segment,
 * 5351.5-5366.5 kHz, as the regions do, so FT8 and JS8 at 5.357, FT2 at 5.360, WSPR at
 * 5.3647 and CW at the bottom of the segment suit every plan. (WSPR's other 60 m
 * frequency, 5.2872, is a UK allocation.) The regions follow WSJT-X's list: FT4 at
 * 3.568 MHz in Region 3, and 4 m in Region 1.
 */
const PLAN_CHANGES: Record<BandPlan, Partial<Record<OperatingMode, Record<string, number | null>>>> = {
  us: {},
  r1: { WSPR: { "4M": 70_091_000 }, FT8: { "4M": 70_154_000 } },
  r2: {},
  r3: { FT4: { "80M": 3_568_000 } },
};

const BAND_ORDER = ["2200M", "630M", "160M", "80M", "60M", "40M", "30M", "20M", "17M", "15M", "12M", "10M", "6M", "4M", "2M", "1.25M", "70CM", "23CM"];

function planFreqs(plan: BandPlan): Record<OperatingMode, Record<string, number>> {
  const out = {} as Record<OperatingMode, Record<string, number>>;
  for (const mode of OPERATING_MODES) {
    const merged: Record<string, number | null> = { ...BASE_FREQS[mode], ...(PLAN_CHANGES[plan][mode] ?? {}) };
    const entries = Object.entries(merged).filter((e): e is [string, number] => e[1] !== null);
    entries.sort((a, b) => BAND_ORDER.indexOf(a[0]) - BAND_ORDER.indexOf(b[0]));
    out[mode] = Object.fromEntries(entries);
  }
  return out;
}

/** Dial frequencies (USB), Hz, by mode and band, for the band plan in use. */
export const CALLING_FREQS: Record<OperatingMode, Record<string, number>> = planFreqs("us");
let currentPlan: BandPlan = "us";

/** Switch the tables to a band plan (the station's "radio.bandPlan" setting). */
export function setBandPlan(value: string): void {
  const plan: BandPlan = (BAND_PLANS as readonly string[]).includes(value) ? (value as BandPlan) : "us";
  if (plan === currentPlan) return;
  currentPlan = plan;
  const next = planFreqs(plan);
  for (const mode of OPERATING_MODES) CALLING_FREQS[mode] = next[mode];
}

export const bandPlan = (): BandPlan => currentPlan;

/** The bands a mode has a frequency on, low to high. */
export const bandsFor = (mode: OperatingMode): string[] => Object.keys(CALLING_FREQS[mode]);

/**
 * Which mode a dial frequency is the calling frequency for: the closest within 3 kHz.
 * On a tie (JTTY shares FT4's frequency on 30 m and 17 m) the mode in use wins.
 */
export function modeForDial(hz: number, prefer?: OperatingMode): OperatingMode | null {
  let best: { mode: OperatingMode; d: number } | null = null;
  for (const mode of DIAL_MODES) {
    for (const f of Object.values(CALLING_FREQS[mode])) {
      const d = Math.abs(hz - f);
      if (d <= 3000 && (!best || d < best.d || (d === best.d && mode === prefer))) best = { mode, d };
    }
  }
  return best?.mode ?? null;
}

/** The slotted mode for a dial frequency, ignoring JTTY. */
export function slottedModeForDial(hz: number, prefer?: DigitalMode): DigitalMode | null {
  let best: { mode: DigitalMode; d: number } | null = null;
  for (const mode of DIGITAL_MODES) {
    for (const f of Object.values(CALLING_FREQS[mode])) {
      const d = Math.abs(hz - f);
      if (d <= 3000 && (!best || d < best.d || (d === best.d && mode === prefer))) best = { mode, d };
    }
  }
  return best?.mode ?? null;
}
