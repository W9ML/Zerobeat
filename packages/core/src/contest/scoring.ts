/**
 * Contest scoring from the log: dupes, QSO points, multipliers, score and rate, for the
 * contests the station works. Pure: give it the contest's contacts, get the totals.
 *
 * Rules, from each sponsor's current rules:
 *   WW Digi DX (ww-digi.com/rules): 160-10 m without WARC, FT4/FT8; once per band,
 *     either mode; 1 point plus 1 per 3000 km between grid-square centres; multiplier
 *     each 2-character grid field per band; score = points x fields.
 *   ARRL Digi (contests.arrl.org Digital-Rules): once per band; 1 point plus 1 per
 *     500 km between grid-square centres, rounded up, at least 1; no multipliers; score
 *     = points.
 *   ARRL Field Day (arrl.org/field-day-rules 6.3, 7.1, 7.2): once per band per mode;
 *     CW and digital 2 points, phone 1; score = points x power multiplier (5, 2 or 1);
 *     bonus points are not tracked here.
 *   ARRL RTTY Roundup (arrl.org/rtty-roundup and rules 2.2): RTTY only, 80-10 m; once per
 *     band; 1 point; multipliers US states, Canadian provinces and territories and
 *     DXCC entities other than the US and Canada, each once (not per band); KH6 and KL7
 *     count as DXCC entities; score = points x multipliers.
 *
 * Each sponsor's rules also say a person must start every contact: fully automated
 * contacts are not allowed.
 */
import { gridToLatLon, distanceKm, isGrid } from "../ham/grid.ts";
import { US_STATES } from "../ham/us-states.ts";

export const CONTEST_IDS = ["ww-digi", "arrl-digi", "field-day", "rtty-roundup"] as const;
export type ContestId = (typeof CONTEST_IDS)[number];

export const CANADA_PROVINCES: Record<string, string> = {
  NB: "New Brunswick", NL: "Newfoundland and Labrador", NS: "Nova Scotia", PE: "Prince Edward Island", QC: "Quebec", ON: "Ontario",
  MB: "Manitoba", SK: "Saskatchewan", AB: "Alberta", BC: "British Columbia", YT: "Yukon", NT: "Northwest Territories", NU: "Nunavut",
};

const HF_NO_WARC = ["160M", "80M", "40M", "20M", "15M", "10M"];

export interface ContestDef {
  id: ContestId;
  name: string;
  cabrillo: "WW-DIGI" | "ARRL-DIGI" | "ARRL-FD" | "ARRL-RTTY";
  bands: string[] | null; // null: any amateur band
  /** Whether multipliers count once per band ("band") or once in the contest ("once"). */
  multsPer: "band" | "once" | null;
  /** A note the desk shows: what the rules say about modes. */
  note?: string;
}

export const CONTESTS: Record<ContestId, ContestDef> = {
  "ww-digi": { id: "ww-digi", name: "WW Digi DX", cabrillo: "WW-DIGI", bands: HF_NO_WARC, multsPer: "band", note: "FT4 and FT8 only; a station counts once per band, either mode." },
  "arrl-digi": { id: "arrl-digi", name: "ARRL Digi", cabrillo: "ARRL-DIGI", bands: HF_NO_WARC, multsPer: null, note: "Any digital mode except RTTY; no multipliers, the score is the points." },
  "field-day": { id: "field-day", name: "ARRL Field Day", cabrillo: "ARRL-FD", bands: null, multsPer: null, note: "Once per band per mode (CW, digital, phone); bonus points are not counted here." },
  "rtty-roundup": { id: "rtty-roundup", name: "ARRL RTTY Roundup", cabrillo: "ARRL-RTTY", bands: ["80M", "40M", "20M", "15M", "10M"], multsPer: "once", note: "RTTY contacts only count in this contest; FT8 and FT4 in the Roundup exchange are for other events." },
};

/** A contact as the scorer needs it. */
export interface ContestQso {
  callsign: string;
  band: string;
  mode: string;
  submode: string | null;
  startTime: number;
  grid: string | null;
  dxcc: number | null;
  state: string | null;
  extras: string | null;
}

export interface ScoreOptions {
  myGrid: string;
  /** Field Day power multiplier: 5 (5 W, battery or solar), 2 (100 W or less) or 1. */
  fdPowerMult?: 1 | 2 | 5;
  now?: number;
}

export interface ScoredQso {
  callsign: string;
  band: string;
  modeGroup: "CW" | "DIGI" | "PHONE";
  startTime: number;
  points: number;
  mults: string[];
  dupe: boolean;
  /** Why a contact scores nothing (a band or mode the contest does not use), or null. */
  invalid: string | null;
  serialSent: number | null;
  exchange: string;
}

export interface ContestSummary {
  id: ContestId;
  qsos: number;
  dupes: number;
  points: number;
  mults: number;
  score: number;
  /** Contacts in the last 10 minutes, as an hourly rate, and in the last 60 minutes. */
  rate10: number;
  rate60: number;
  byBand: { band: string; qsos: number; points: number; mults: number }[];
  /** The multipliers worked: keys like "20M:EN" (per band) or "WI" (once). */
  multList: string[];
  lastSerialSent: number | null;
  rows: ScoredQso[];
}

export function modeGroup(mode: string, submode?: string | null): "CW" | "DIGI" | "PHONE" {
  const m = (submode || mode).toUpperCase();
  const base = mode.toUpperCase();
  if (base === "CW" || m === "CW") return "CW";
  if (["SSB", "USB", "LSB", "AM", "FM", "DIGITALVOICE", "FREEDV", "C4FM", "DSTAR", "DMR"].includes(base) || ["USB", "LSB"].includes(m)) return "PHONE";
  return "DIGI";
}

function extrasOf(q: { extras: string | null }): Record<string, string> {
  try {
    return q.extras ? (JSON.parse(q.extras) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

const grid4 = (g: string | null | undefined) => (g && isGrid(g.slice(0, 4)) ? g.slice(0, 4).toUpperCase() : null);

/** Kilometres between the centres of two 4-character grid squares. */
export function grid4Km(a: string, b: string): number | null {
  const pa = gridToLatLon(a.slice(0, 4));
  const pb = gridToLatLon(b.slice(0, 4));
  return pa && pb ? distanceKm(pa, pb) : null;
}

/** The dupe key: a station once per band, or (Field Day) once per band per mode. */
export function dupeKey(id: ContestId, call: string, band: string, group: string): string {
  return id === "field-day" ? `${call.toUpperCase()}|${band}|${group}` : `${call.toUpperCase()}|${band}`;
}

/** The Roundup multiplier for what a station sent: a state, province or DXCC entity. */
export function roundupMult(x: { state: string | null; exchange: string; dxcc: number | null }): string | null {
  const ex = x.exchange.trim().toUpperCase();
  const token = /^[A-Z]{2}$/.test(ex) ? ex : (x.state ?? "").toUpperCase();
  // DC counts as Maryland, as in ARRL's multiplier list; KH6 and KL7 are DXCC entities.
  const st = token === "DC" ? "MD" : token;
  if (st && US_STATES[st] && st !== "AK" && st !== "HI" && (x.dxcc === null || x.dxcc === 291)) return st;
  if (CANADA_PROVINCES[st] && (x.dxcc === null || x.dxcc === 1)) return st;
  if (x.dxcc !== null && x.dxcc !== 291 && x.dxcc !== 1) return `DXCC-${x.dxcc}`;
  return null;
}

function theirExchange(id: ContestId, q: ContestQso, ex: Record<string, string>): string {
  const rcvd = (ex.SRX_STRING ?? "").toUpperCase().trim();
  if (id === "ww-digi" || id === "arrl-digi") return grid4(rcvd) ?? grid4(q.grid) ?? "";
  if (id === "rtty-roundup") return rcvd.split(/\s+/).at(-1) ?? ex.STATE ?? ex.SRX ?? "";
  return rcvd || [ex.CLASS, ex.ARRL_SECT].filter(Boolean).join(" ");
}

/** Score one contact, given which dupe keys and multipliers are already in the log. */
export function scoreQso(id: ContestId, q: ContestQso, opts: ScoreOptions): Omit<ScoredQso, "dupe"> {
  const def = CONTESTS[id];
  const ex = extrasOf(q);
  const group = modeGroup(q.mode, q.submode);
  const exchange = theirExchange(id, q, ex);
  const stx = Number(ex.STX);
  const serialSent = Number.isFinite(stx) && stx > 0 ? stx : /^\d{1,4}$/.test(ex.STX_STRING ?? "") ? Number(ex.STX_STRING) : null;
  const base = { callsign: q.callsign.toUpperCase(), band: q.band.toUpperCase(), modeGroup: group, startTime: q.startTime, serialSent, exchange };
  let invalid: string | null = null;
  if (def.bands && !def.bands.includes(base.band)) invalid = `${base.band.toLowerCase()} is not a ${def.name} band`;
  else if (id === "rtty-roundup" && (q.submode || q.mode).toUpperCase() !== "RTTY") invalid = "the Roundup counts RTTY contacts only";
  else if (id === "arrl-digi" && (q.submode || q.mode).toUpperCase() === "RTTY") invalid = "ARRL Digi does not count RTTY";
  else if (id === "ww-digi" && !["FT8", "FT4"].includes((q.submode || q.mode).toUpperCase())) invalid = "WW Digi counts FT4 and FT8 only";
  if (invalid) return { ...base, points: 0, mults: [], invalid };

  const mine = grid4(ex.STX_STRING) ?? grid4(opts.myGrid);
  const theirs = grid4(exchange);
  const km = mine && theirs ? grid4Km(mine, theirs) : null;
  if (id === "ww-digi") {
    return { ...base, points: 1 + (km === null ? 0 : Math.floor(km / 3000)), mults: theirs ? [`${base.band}:${theirs.slice(0, 2)}`] : [], invalid: null };
  }
  if (id === "arrl-digi") {
    return { ...base, points: 1 + (km === null ? 1 : Math.max(1, Math.ceil(km / 500))), mults: [], invalid: null };
  }
  if (id === "field-day") return { ...base, points: group === "PHONE" ? 1 : 2, mults: [], invalid: null };
  const m = roundupMult({ state: q.state ?? ex.STATE ?? null, exchange, dxcc: q.dxcc });
  return { ...base, points: 1, mults: m ? [m] : [], invalid: null };
}

export function summarize(id: ContestId, qsos: ContestQso[], opts: ScoreOptions): ContestSummary {
  const now = opts.now ?? Date.now();
  const sorted = [...qsos].sort((a, b) => a.startTime - b.startTime);
  const seen = new Set<string>();
  const mults = new Set<string>();
  const rows: ScoredQso[] = [];
  const bands = new Map<string, { qsos: number; points: number; mults: Set<string> }>();
  let points = 0;
  let dupes = 0;
  let lastSerialSent: number | null = null;
  for (const q of sorted) {
    const s = scoreQso(id, q, opts);
    const key = dupeKey(id, s.callsign, s.band, s.modeGroup);
    const dupe = seen.has(key);
    seen.add(key);
    if (s.serialSent !== null) lastSerialSent = Math.max(lastSerialSent ?? 0, s.serialSent);
    const row: ScoredQso = { ...s, dupe, points: dupe ? 0 : s.points, mults: dupe ? [] : s.mults.filter((m) => !mults.has(m)) };
    rows.push(row);
    if (dupe) {
      dupes++;
      continue;
    }
    points += row.points;
    for (const m of row.mults) mults.add(m);
    const b = bands.get(s.band) ?? { qsos: 0, points: 0, mults: new Set<string>() };
    b.qsos++;
    b.points += row.points;
    for (const m of row.mults) b.mults.add(m);
    bands.set(s.band, b);
  }
  const counted = rows.filter((r) => !r.dupe && !r.invalid);
  const multCount = CONTESTS[id].multsPer ? mults.size : 0;
  const score = id === "field-day" ? points * (opts.fdPowerMult ?? 2) : id === "arrl-digi" ? points : points * multCount;
  return {
    id,
    qsos: counted.length,
    dupes,
    points,
    mults: multCount,
    score,
    rate10: counted.filter((r) => now - r.startTime <= 10 * 60_000).length * 6,
    rate60: counted.filter((r) => now - r.startTime <= 60 * 60_000).length,
    byBand: [...bands.entries()].map(([band, b]) => ({ band, qsos: b.qsos, points: b.points, mults: b.mults.size })),
    multList: [...mults].sort(),
    lastSerialSent,
    rows,
  };
}

/** For a station about to be worked: is it a dupe, and which multipliers would it add? */
export function checkStation(
  id: ContestId,
  summary: Pick<ContestSummary, "rows" | "multList">,
  c: { callsign: string; band: string; mode: string; grid?: string | null; state?: string | null; dxcc?: number | null; exchange?: string },
): { dupe: boolean; newMults: string[]; workedOn: string[] } {
  const call = c.callsign.toUpperCase();
  const group = modeGroup(c.mode);
  const key = dupeKey(id, call, c.band.toUpperCase(), group);
  const mine = summary.rows.filter((r) => r.callsign === call && !r.dupe);
  const dupe = mine.some((r) => dupeKey(id, r.callsign, r.band, r.modeGroup) === key);
  const have = new Set(summary.multList);
  let candidate: string[] = [];
  if (id === "ww-digi") {
    const g = grid4(c.grid ?? c.exchange);
    if (g) candidate = [`${c.band.toUpperCase()}:${g.slice(0, 2)}`];
  } else if (id === "rtty-roundup") {
    const m = roundupMult({ state: c.state ?? null, exchange: c.exchange ?? "", dxcc: c.dxcc ?? null });
    if (m) candidate = [m];
  }
  return { dupe, newMults: dupe ? [] : candidate.filter((m) => !have.has(m)), workedOn: [...new Set(mine.map((r) => (id === "field-day" ? `${r.band} ${r.modeGroup}` : r.band)))] };
}

/** The Roundup multipliers not yet worked (states and provinces; DXCC is open-ended). */
export function roundupMissing(multList: string[]): string[] {
  const have = new Set(multList);
  const all = [...Object.keys(US_STATES).filter((s) => s !== "AK" && s !== "HI" && s !== "DC"), ...Object.keys(CANADA_PROVINCES)];
  return all.filter((s) => !have.has(s));
}
