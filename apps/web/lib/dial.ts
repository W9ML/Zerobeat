/**
 * A typed frequency as Hz: "14.074" (MHz), "14074" or "14074 kHz" (kHz), "14,074",
 * "1296.1 MHz". A bare number of 1000 or more is kHz, as hams type HF dials.
 * Null when it is not a frequency the engine can tune.
 */
export function parseDial(text: string): number | null {
  const t = text.trim().toLowerCase();
  const unit = /mhz$/.test(t) ? "mhz" : /khz$/.test(t) ? "khz" : null;
  const v = Number(t.replace(/\s*(mhz|khz)$/, "").replace(",", "."));
  if (!Number.isFinite(v) || v <= 0) return null;
  const hz = unit === "mhz" ? v * 1e6 : unit === "khz" || v >= 1000 ? v * 1000 : v * 1e6;
  return hz >= 100_000 && hz <= 1_300_000_000 ? Math.round(hz) : null;
}
