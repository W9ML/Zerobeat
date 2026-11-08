/**
 * ADIF modes and submodes. The log stores MODE and SUBMODE as ADIF defines them; the UI
 * and imports speak loosely ("FT4" alone, "USB", "PSK31"), so this maps both ways.
 */

/** ADIF submode → ADIF mode. */
const SUBMODE_PARENT: Record<string, string> = {
  FT4: "MFSK",
  FT2: "MFSK",
  FST4: "MFSK",
  FST4W: "MFSK",
  JS8: "MFSK",
  Q65: "MFSK",
  JTMS: "MFSK",
  USB: "SSB",
  LSB: "SSB",
  PSK31: "PSK",
  PSK63: "PSK",
  PSK125: "PSK",
  QPSK31: "PSK",
  QPSK63: "PSK",
  OLIVIA: "OLIVIA",
  "OLIVIA 8/250": "OLIVIA",
  "OLIVIA 8/500": "OLIVIA",
  "OLIVIA 16/500": "OLIVIA",
  "OLIVIA 32/1000": "OLIVIA",
  DOMINOEX: "DOMINO",
  JT9: "JT9",
  JT65: "JT65",
  FSQ: "MFSK",
  ASCI: "RTTY",
  FMHELL: "HELL",
  FSKHELL: "HELL",
  HELL80: "HELL",
  HELLX5: "HELL",
  HELLX9: "HELL",
  HFSK: "HELL",
  PSKHELL: "HELL",
  SLOWHELL: "HELL",
  "DSTAR": "DIGITALVOICE",
  "DMR": "DIGITALVOICE",
  "C4FM": "DIGITALVOICE",
  "FREEDV": "DIGITALVOICE",
  "M17": "DIGITALVOICE",
};

/** Modes that are their own ADIF MODE (not submodes). */
const MODES = new Set([
  "AM", "ARDOP", "ATV", "CHIP", "CLO", "CONTESTI", "CW", "DIGITALVOICE", "DOMINO", "DYNAMIC", "FAX", "FM",
  "FSK441", "FT8", "HELL", "JTTY", "ISCAT", "JT4", "JT6M", "JT9", "JT44", "JT65", "MFSK", "MSK144", "MT63", "OLIVIA",
  "OPERA", "PAC", "PAX", "PKT", "PSK", "PSK2K", "Q15", "QRA64", "ROS", "RTTY", "RTTYM", "SSB", "SSTV", "T10",
  "THOR", "THRB", "TOR", "V4", "VOI", "WINMOR", "WSPR",
]);

export interface AdifMode {
  mode: string;
  submode: string | null;
}

/**
 * Loose input → ADIF {mode, submode}. "FT4" → MFSK/FT4; "USB" → SSB/USB; "ft8" → FT8;
 * "MFSK" alone stays MFSK. Unknown strings are kept uppercase as the mode, because an
 * import must not lose data it does not recognise.
 */
export function toAdifMode(mode: string | null | undefined, submode?: string | null): AdifMode {
  const m = (mode ?? "").trim().toUpperCase();
  const s = (submode ?? "").trim().toUpperCase() || null;
  if (!m) return { mode: "", submode: null };
  if (s && SUBMODE_PARENT[s]) return { mode: SUBMODE_PARENT[s]!, submode: s };
  if (SUBMODE_PARENT[m] && !MODES.has(m)) return { mode: SUBMODE_PARENT[m]!, submode: m };
  return { mode: m, submode: s };
}

/** What an operator wants to see: the submode when there is one ("FT4", "USB"), else the mode. */
export function displayMode(mode: string, submode: string | null | undefined): string {
  return submode || mode;
}

/** The mode a decoder or digital engine means, from either representation. */
export function digitalMode(mode: string, submode: string | null | undefined): "FT8" | "FT4" | "FT2" | null {
  const d = displayMode(mode, submode).toUpperCase();
  return d === "FT8" || d === "FT4" || d === "FT2" ? d : null;
}

/** For awards and dupe checks: SSB, CW, DATA, FM, AM. */
export type ModeClass = "SSB" | "CW" | "DATA" | "FM" | "AM" | "OTHER";

export function modeClass(mode: string): ModeClass {
  const m = mode.toUpperCase();
  if (m === "SSB" || m === "USB" || m === "LSB") return "SSB";
  if (m === "CW") return "CW";
  if (m === "FM" || m === "DIGITALVOICE") return "FM";
  if (m === "AM") return "AM";
  if (MODES.has(m) || SUBMODE_PARENT[m]) return "DATA";
  return "OTHER";
}
