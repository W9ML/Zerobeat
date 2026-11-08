/**
 * Amateur bands as ADIF names them, with the frequency ranges ADIF 3.1.4 assigns.
 * Ranges are the ADIF table (worldwide envelope), not a region's allocation.
 */
export interface Band {
  name: string;
  lowHz: number;
  highHz: number;
}

export const BANDS: readonly Band[] = [
  { name: "2190M", lowHz: 135_700, highHz: 137_800 },
  { name: "630M", lowHz: 472_000, highHz: 479_000 },
  { name: "560M", lowHz: 501_000, highHz: 504_000 },
  { name: "160M", lowHz: 1_800_000, highHz: 2_000_000 },
  { name: "80M", lowHz: 3_500_000, highHz: 4_000_000 },
  { name: "60M", lowHz: 5_060_000, highHz: 5_450_000 },
  { name: "40M", lowHz: 7_000_000, highHz: 7_300_000 },
  { name: "30M", lowHz: 10_100_000, highHz: 10_150_000 },
  { name: "20M", lowHz: 14_000_000, highHz: 14_350_000 },
  { name: "17M", lowHz: 18_068_000, highHz: 18_168_000 },
  { name: "15M", lowHz: 21_000_000, highHz: 21_450_000 },
  { name: "12M", lowHz: 24_890_000, highHz: 24_990_000 },
  { name: "10M", lowHz: 28_000_000, highHz: 29_700_000 },
  { name: "8M", lowHz: 40_000_000, highHz: 45_000_000 },
  { name: "6M", lowHz: 50_000_000, highHz: 54_000_000 },
  { name: "5M", lowHz: 54_000_001, highHz: 69_900_000 },
  { name: "4M", lowHz: 70_000_000, highHz: 71_000_000 },
  { name: "2M", lowHz: 144_000_000, highHz: 148_000_000 },
  { name: "1.25M", lowHz: 222_000_000, highHz: 225_000_000 },
  { name: "70CM", lowHz: 420_000_000, highHz: 450_000_000 },
  { name: "33CM", lowHz: 902_000_000, highHz: 928_000_000 },
  { name: "23CM", lowHz: 1_240_000_000, highHz: 1_300_000_000 },
  { name: "13CM", lowHz: 2_300_000_000, highHz: 2_450_000_000 },
  { name: "9CM", lowHz: 3_300_000_000, highHz: 3_500_000_000 },
  { name: "6CM", lowHz: 5_650_000_000, highHz: 5_925_000_000 },
  { name: "3CM", lowHz: 10_000_000_000, highHz: 10_500_000_000 },
  { name: "1.25CM", lowHz: 24_000_000_000, highHz: 24_250_000_000 },
  { name: "6MM", lowHz: 47_000_000_000, highHz: 47_200_000_000 },
  { name: "4MM", lowHz: 75_500_000_000, highHz: 81_000_000_000 },
  { name: "2.5MM", lowHz: 119_980_000_000, highHz: 123_000_000_000 },
  { name: "2MM", lowHz: 134_000_000_000, highHz: 149_000_000_000 },
  { name: "1MM", lowHz: 241_000_000_000, highHz: 250_000_000_000 },
  { name: "SUBMM", lowHz: 300_000_000_000, highHz: 7_500_000_000_000 },
];

const BY_NAME = new Map(BANDS.map((b) => [b.name, b]));

export function bandForHz(hz: number): Band | null {
  for (const b of BANDS) if (hz >= b.lowHz && hz <= b.highHz) return b;
  return null;
}

export function bandName(hz: number): string | null {
  return bandForHz(hz)?.name ?? null;
}

/** Accepts "20m", "20M", " 20 m " → "20M". Null when unknown. */
export function normaliseBand(input: string | null | undefined): string | null {
  if (!input) return null;
  const name = input.replace(/\s+/g, "").toUpperCase();
  return BY_NAME.has(name) ? name : null;
}

export function bandByName(name: string): Band | null {
  return BY_NAME.get(name.toUpperCase()) ?? null;
}

/** HF bands in the order an operator thinks of them, low to high. */
export const HF_BANDS = ["160M", "80M", "60M", "40M", "30M", "20M", "17M", "15M", "12M", "10M", "6M"] as const;

/** Does the frequency and band agree? Used to catch imports with a wrong BAND field. */
export function bandMatchesFreq(band: string, hz: number): boolean {
  const b = bandByName(band);
  return b !== null && hz >= b.lowHz && hz <= b.highHz;
}
