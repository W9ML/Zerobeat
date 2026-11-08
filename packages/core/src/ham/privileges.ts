/**
 * US amateur privileges by license class (FCC Part 97: 97.301 frequencies, 97.305
 * emissions), for refusing a transmission the control operator may not make.
 *
 * Kinds: C = CW, D = RTTY and data (FT8, JS8, WSPR, PSK31, RTTY…), P = phone, I = image
 * (SSTV). CW is allowed wherever the class has any privilege, which the table spells out.
 * Only the US table exists. A user with no class set is not checked: a non-US station,
 * or a US one that has not filled it in, and the settings say so.
 */
export const LICENSE_CLASSES = ["T", "G", "A", "E"] as const;
export type LicenseClass = (typeof LICENSE_CLASSES)[number];
export const LICENSE_NAMES: Record<LicenseClass, string> = { T: "Technician", G: "General", A: "Advanced", E: "Amateur Extra" };
export type EmissionKind = "C" | "D" | "P" | "I";

/** [low kHz, high kHz, kinds, classes]. Rows may overlap; any matching row allows. */
const US: [number, number, string, string][] = [
  [135.7, 137.8, "CD", "GAE"],
  [472, 479, "CD", "GAE"],
  [1800, 2000, "CDPI", "GAE"],
  [3500, 3525, "CD", "E"],
  [3525, 3600, "CD", "GAE"],
  [3525, 3600, "C", "T"],
  [3600, 3700, "CPI", "E"],
  [3700, 3800, "CPI", "AE"],
  [3800, 4000, "CPI", "GAE"],
  // 60 m (97.303(h), as amended by FCC 25-60, in force February 2026): anywhere in
  // 5351.5-5366.5 kHz, plus four 2.8 kHz channels centred on 5332, 5348, 5373 and
  // 5405 kHz (channel 3 at 5358.5 is now inside the segment). Phone, RTTY and data; no
  // image. CW on a channel goes on its centre frequency.
  [5330.6, 5333.4, "DP", "GAE"],
  [5331.95, 5332.05, "C", "GAE"],
  [5346.6, 5349.4, "DP", "GAE"],
  [5347.95, 5348.05, "C", "GAE"],
  [5351.5, 5366.5, "CDP", "GAE"],
  [5371.6, 5374.4, "DP", "GAE"],
  [5372.95, 5373.05, "C", "GAE"],
  [5403.6, 5406.4, "DP", "GAE"],
  [5404.95, 5405.05, "C", "GAE"],
  [7000, 7025, "CD", "E"],
  [7025, 7125, "CD", "GAE"],
  [7025, 7125, "C", "T"],
  [7125, 7175, "CPI", "AE"],
  [7175, 7300, "CPI", "GAE"],
  [10100, 10150, "CD", "GAE"],
  [14000, 14025, "CD", "E"],
  [14025, 14150, "CD", "GAE"],
  [14150, 14175, "CPI", "E"],
  [14175, 14225, "CPI", "AE"],
  [14225, 14350, "CPI", "GAE"],
  [18068, 18110, "CD", "GAE"],
  [18110, 18168, "CPI", "GAE"],
  [21000, 21025, "CD", "E"],
  [21025, 21200, "CD", "GAE"],
  [21025, 21200, "C", "T"],
  [21200, 21225, "CPI", "E"],
  [21225, 21275, "CPI", "AE"],
  [21275, 21450, "CPI", "GAE"],
  [24890, 24930, "CD", "GAE"],
  [24930, 24990, "CPI", "GAE"],
  [28000, 28300, "CD", "TGAE"],
  // Technicians: CW and SSB phone only, 28.3-28.5 MHz (97.305(c), 97.307(f)(10)).
  [28300, 28500, "CP", "T"],
  [28300, 29700, "CPI", "GAE"],
  [50000, 50100, "C", "TGAE"],
  [50100, 54000, "CDPI", "TGAE"],
  [144000, 144100, "C", "TGAE"],
  [144100, 148000, "CDPI", "TGAE"],
  [222000, 225000, "CDPI", "TGAE"],
  [420000, 450000, "CDPI", "TGAE"],
  [902000, 928000, "CDPI", "TGAE"],
  [1240000, 1300000, "CDPI", "TGAE"],
  [2300000, 2310000, "CDPI", "TGAE"],
  [2390000, 2450000, "CDPI", "TGAE"],
  [3300000, 3500000, "CDPI", "TGAE"],
  [5650000, 5925000, "CDPI", "TGAE"],
  [10000000, 10500000, "CDPI", "TGAE"],
  [24000000, 24250000, "CDPI", "TGAE"],
];

const KIND_NAMES: Record<EmissionKind, string> = { C: "CW", D: "data", P: "phone", I: "image (SSTV)" };

/** The merged spans (Hz) this class may use for this kind of emission. */
function spans(cls: LicenseClass, kind: EmissionKind): [number, number][] {
  const rows = US.filter(([, , k, c]) => k.includes(kind) && c.includes(cls))
    .map(([lo, hi]) => [Math.round(lo * 1000), Math.round(hi * 1000)] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const r of rows) {
    const last = out.at(-1);
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([...r]);
  }
  return out;
}

/** True when the whole signal, loHz to hiHz, is inside this class's privileges. */
export function usAllowed(cls: LicenseClass, kind: EmissionKind, loHz: number, hiHz: number): boolean {
  return spans(cls, kind).some(([a, b]) => loHz >= a && hiHz <= b);
}

/** Why this class may not send this, or null when it may. */
export function privilegeProblem(cls: LicenseClass | null | undefined, kind: EmissionKind, loHz: number, hiHz: number): string | null {
  if (!cls) return null;
  if (usAllowed(cls, kind, loHz, hiHz)) return null;
  const mhz = ((loHz + hiHz) / 2 / 1e6).toFixed(4);
  const anyClass = LICENSE_CLASSES.some((c) => usAllowed(c, kind, loHz, hiHz));
  if (!anyClass) return `${mhz} MHz is outside the US ${KIND_NAMES[kind]} segments for every license class`;
  return `a ${LICENSE_NAMES[cls]} license has no ${KIND_NAMES[kind]} privileges at ${mhz} MHz`;
}

/**
 * A US power limit narrower than the class's usual one, for the signal at loHz-hiHz:
 * 60 m allows 9.15 W ERP in the 5351.5-5366.5 kHz segment and 100 W ERP on the four
 * channels. ERP depends on the antenna, so this is shown, not enforced.
 */
export function usPowerNote(loHz: number, hiHz: number): string | null {
  if (loHz >= 5_351_500 && hiHz <= 5_366_500) return "US limit here: 9.15 W ERP (60 m segment, 5351.5-5366.5 kHz)";
  if (loHz >= 5_330_000 && hiHz <= 5_407_000) return "US limit here: 100 W ERP (60 m channel)";
  return null;
}

/** The emission kind for an operating mode. */
export function emissionKind(mode: string): EmissionKind {
  const m = mode.toUpperCase();
  if (m === "CW") return "C";
  if (m === "SSTV") return "I";
  if (m === "SSB" || m === "USB" || m === "LSB" || m === "AM" || m === "FM") return "P";
  return "D";
}

export function isLicenseClass(v: unknown): v is LicenseClass {
  return typeof v === "string" && (LICENSE_CLASSES as readonly string[]).includes(v);
}

/** The higher of two classes (a control operator's privileges extend to the operator). */
export function higherClass(a: LicenseClass | null | undefined, b: LicenseClass | null | undefined): LicenseClass | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return LICENSE_CLASSES.indexOf(a) >= LICENSE_CLASSES.indexOf(b) ? a : b;
}
