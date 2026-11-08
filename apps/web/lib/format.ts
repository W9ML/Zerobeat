/** Formatting shared by server and client. Everything is UTC. */
const pad = (n: number) => String(n).padStart(2, "0");

export function utcDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function utcTime(ms: number, seconds = false): string {
  const d = new Date(ms);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}${seconds ? ":" + pad(d.getUTCSeconds()) : ""}`;
}

export function utcDateTime(ms: number): string {
  return `${utcDate(ms)} ${utcTime(ms)}Z`;
}

/** 14.074000 → "14.074 000" style, the way radios show it. */
export function mhz(hz: number, digits = 6): string {
  if (!hz) return "—";
  const s = (hz / 1e6).toFixed(digits);
  const [a, b] = s.split(".");
  return digits > 3 ? `${a}.${b!.slice(0, 3)} ${b!.slice(3)}` : s;
}

export function khz(hz: number): string {
  return (hz / 1000).toFixed(1);
}

export function ago(ms: number, now = Date.now()): string {
  const s = Math.round((now - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function duration(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

export function displayMode(mode: string, submode: string | null | undefined): string {
  return submode || mode;
}

export function num(n: number): string {
  return n.toLocaleString("en-US");
}
