/** UTC formatting. Nothing here reads local time; the log is UTC everywhere. */

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

export function utcDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function utcTime(ms: number, seconds = true): string {
  const d = new Date(ms);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}${seconds ? ":" + pad(d.getUTCSeconds()) : ""}`;
}

export function utcDateTime(ms: number): string {
  return `${utcDate(ms)} ${utcTime(ms)}Z`;
}

/** ADIF QSO_DATE: YYYYMMDD. */
export function adifDate(ms: number): string {
  return utcDate(ms).replace(/-/g, "");
}

/** ADIF TIME_ON: HHMMSS. */
export function adifTime(ms: number): string {
  return utcTime(ms).replace(/:/g, "");
}

/** Parse ADIF YYYYMMDD + HHMM[SS] into unix ms. Null when malformed. */
export function parseAdifDateTime(date: string | undefined, time: string | undefined): number | null {
  if (!date || !/^\d{8}$/.test(date)) return null;
  const t = (time ?? "0000").padEnd(6, "0");
  if (!/^\d{6}$/.test(t)) return null;
  const ms = Date.UTC(
    Number(date.slice(0, 4)),
    Number(date.slice(4, 6)) - 1,
    Number(date.slice(6, 8)),
    Number(t.slice(0, 2)),
    Number(t.slice(2, 4)),
    Number(t.slice(4, 6)),
  );
  return Number.isFinite(ms) ? ms : null;
}

export function startOfUtcDay(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export const MINUTE = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;
