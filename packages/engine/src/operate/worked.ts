/**
 * What the log already holds, for deciding who is worth calling and who is a dupe.
 * Read from SQLite in a handful of queries, cached for a minute, invalidated whenever
 * a contact is logged. The log is the operator's own: the station of whoever has the radio.
 */
import { sql } from "drizzle-orm";
import type { Db } from "@zerobeat/core/db/client";
import { getDxcc } from "@zerobeat/core/dxcc/cty";
import { US_DXCC } from "@zerobeat/core/ham/us-states";

export interface WorkedIndex {
  dxcc: Set<number>;
  dxccBand: Set<number>;
  states: Set<string>;
  statesBand: Set<string>;
  grids: Set<string>;
  gridsBand: Set<string>;
  zones: Set<number>;
  continents: Set<string>;
  calls: Set<string>;
  parks: Set<string>;
}

export class LogQueries {
  private cache = new Map<string, { at: number; idx: WorkedIndex }>();
  private failures = new Map<string, number>(); // call → until

  /** Whose log: the station of the operator (set by the engine; none: an empty log). */
  station: () => string | null = () => null;

  constructor(private readonly db: Db) {}

  invalidate(): void {
    this.cache.clear();
  }

  private get sid(): string {
    return this.station() ?? "";
  }

  worked(band: string, now = Date.now()): WorkedIndex {
    const sid = this.sid;
    const hit = this.cache.get(`${sid}|${band}`);
    if (hit && now - hit.at < 60_000) return hit.idx;
    const rows = this.db.all<{ callsign: string; band: string; dxcc: number | null; state: string | null; grid: string | null; cq_zone: number | null; continent: string | null }>(
      sql`SELECT callsign, band, dxcc, state, grid, cq_zone, continent FROM qsos WHERE station_id = ${sid}`,
    );
    const idx: WorkedIndex = {
      dxcc: new Set(),
      dxccBand: new Set(),
      states: new Set(),
      statesBand: new Set(),
      grids: new Set(),
      gridsBand: new Set(),
      zones: new Set(),
      continents: new Set(),
      calls: new Set(),
      parks: new Set(this.db.all<{ ref: string }>(sql`SELECT DISTINCT r.ref FROM qso_sig_refs r JOIN qsos q ON q.id = r.qso_id WHERE r.sig = 'POTA' AND q.station_id = ${sid}`).map((r) => r.ref)),
    };
    for (const r of rows) {
      const same = r.band === band;
      idx.calls.add(r.callsign);
      if (r.dxcc) {
        idx.dxcc.add(r.dxcc);
        if (same) idx.dxccBand.add(r.dxcc);
      }
      if (r.state && r.dxcc && US_DXCC.has(r.dxcc)) {
        idx.states.add(r.state);
        if (same) idx.statesBand.add(r.state);
      }
      if (r.grid && r.grid.length >= 4) {
        const g = r.grid.slice(0, 4).toUpperCase();
        idx.grids.add(g);
        if (same) idx.gridsBand.add(g);
      }
      if (r.cq_zone) idx.zones.add(r.cq_zone);
      if (r.continent) idx.continents.add(r.continent);
    }
    this.cache.set(`${sid}|${band}`, { at: now, idx });
    return idx;
  }

  /** Worked this call on this band and mode since `since` (ms), or ever if since = 0. */
  workedSince(call: string, band: string, mode: string, since: number): boolean {
    const m = mode.toUpperCase();
    const r = this.db.get<{ c: number }>(
      sql`SELECT COUNT(*) AS c FROM qsos WHERE station_id = ${this.sid} AND callsign = ${call} AND band = ${band} AND (mode = ${m} OR submode = ${m}) AND start_time >= ${since}`,
    );
    return (r?.c ?? 0) > 0;
  }

  /** Worked this activator at this park on this band and mode since `since` (ms). */
  workedAtPark(call: string, park: string, band: string, mode: string, since: number): boolean {
    const m = mode.toUpperCase();
    const r = this.db.get<{ c: number }>(
      sql`SELECT COUNT(*) AS c FROM qsos q JOIN qso_sig_refs r ON r.qso_id = q.id AND r.sig = 'POTA' AND r.ref = ${park}
          WHERE q.station_id = ${this.sid} AND q.callsign = ${call} AND q.band = ${band} AND (q.mode = ${m} OR q.submode = ${m}) AND q.start_time >= ${since}`,
    );
    return (r?.c ?? 0) > 0;
  }

  doNotCall(call: string, now = Date.now()): string | null {
    const r = this.db.get<{ kind: string; note: string | null; expires_at: number | null }>(sql`SELECT kind, note, expires_at FROM do_not_call WHERE callsign = ${call}`);
    if (!r || (r.expires_at && r.expires_at < now)) return null;
    return r.note ? `on the do-not-call list (${r.note})` : "on the do-not-call list";
  }

  recordFailure(call: string, cooldownMs: number, now = Date.now()): void {
    if (cooldownMs > 0) this.failures.set(call, now + cooldownMs);
  }

  coolingDown(call: string, now = Date.now()): boolean {
    const until = this.failures.get(call);
    if (!until) return false;
    if (until < now) {
      this.failures.delete(call);
      return false;
    }
    return true;
  }
}

// ---------------------------------------------------------------------------
// Worth
// ---------------------------------------------------------------------------

export interface Candidate {
  callsign: string;
  grid: string | null;
  snr: number;
  /** POTA park, when known from the spot feed. */
  park: string | null;
  potaCq: boolean;
}

export type NewKind = "dxcc" | "band" | "continent" | "zone" | "state" | "stateBand" | "park" | "grid" | "gridBand" | "pota" | "call";

export interface Scored extends Candidate {
  points: number;
  reasons: string[];
  /** Machine-readable versions of the reasons, same order. */
  kinds: NewKind[];
  dxcc: number | null;
  /** True when the only reasons are informational (never worked) — nothing for an award. */
  routine: boolean;
}

const POINTS = {
  newDxcc: 100,
  newContinent: 40,
  newPark: 35,
  newDxccBand: 30,
  newState: 25,
  newZone: 20,
  potaActivator: 15,
  newCall: 12,
  newStateBand: 12,
  newGrid: 5,
  newGridBand: 3,
};

export function score(c: Candidate, w: WorkedIndex, stateOf?: (call: string) => string | null): Scored {
  const reasons: string[] = [];
  const kinds: NewKind[] = [];
  let points = 0;
  const KIND: Record<keyof typeof POINTS, NewKind> = {
    newDxcc: "dxcc",
    newContinent: "continent",
    newPark: "park",
    newDxccBand: "band",
    newState: "state",
    newZone: "zone",
    potaActivator: "pota",
    newCall: "call",
    newStateBand: "stateBand",
    newGrid: "grid",
    newGridBand: "gridBand",
  };
  const add = (k: keyof typeof POINTS, why: string) => {
    points += POINTS[k];
    reasons.push(why);
    kinds.push(KIND[k]);
  };
  const m = getDxcc().resolve(c.callsign);
  if (m) {
    if (!w.dxcc.has(m.adif)) add("newDxcc", `new DXCC: ${m.name}`);
    else if (!w.dxccBand.has(m.adif)) add("newDxccBand", `${m.name} new on this band`);
    if (!w.continents.has(m.continent)) add("newContinent", `new continent ${m.continent}`);
    if (!w.zones.has(m.cqZone)) add("newZone", `new CQ zone ${m.cqZone}`);
  }
  const state = m && US_DXCC.has(m.adif) ? (stateOf?.(c.callsign) ?? null) : null;
  if (state) {
    if (!w.states.has(state)) add("newState", `new state ${state}`);
    else if (!w.statesBand.has(state)) add("newStateBand", `${state} new on this band`);
  }
  if (c.park && !w.parks.has(c.park)) add("newPark", `new park ${c.park}`);
  else if (c.potaCq && !c.park) add("potaActivator", "POTA activator");
  if (c.grid) {
    const g = c.grid.slice(0, 4).toUpperCase();
    if (!w.grids.has(g)) add("newGrid", `new grid ${g}`);
    else if (!w.gridsBand.has(g)) add("newGridBand", `${g} new on this band`);
  }
  const routine = reasons.length === 0;
  if (!w.calls.has(c.callsign)) {
    points += POINTS.newCall;
    reasons.push("never worked");
    kinds.push("call");
  }
  points += Math.max(0, Math.min(6, (c.snr + 24) / 5));
  return { ...c, points: Math.round(points * 10) / 10, reasons, kinds, dxcc: m?.adif ?? null, routine };
}

/**
 * Is a directed CQ meant for us? `CQ DX` excludes our own continent; continent codes
 * select that continent; activity words (POTA, SOTA, WWFF, TEST, WW, QRP) are open to
 * all; contest words for an exchange we are not sending (FD, RU) and anything else
 * (CQ JA, CQ USA) are not answered: answering with a grid is the wrong protocol.
 */
/** CQ modifiers that invite everyone. */
const OPEN_CQ = new Set(["POTA", "SOTA", "WWFF", "IOTA", "TEST", "WW", "QRP", "ALL", "BOTA", "LH"]);

export function cqIsForUs(modifier: string | null, ours: { continent: string | null; dxcc: number | null }, theirs: { continent: string | null; dxcc: number | null }): boolean {
  if (!modifier) return true;
  const m = modifier.toUpperCase();
  if (m === "DX") {
    if (ours.dxcc && theirs.dxcc && ours.dxcc === theirs.dxcc) return false;
    if (ours.continent && theirs.continent && ours.continent === theirs.continent) return false;
    return true;
  }
  if (["NA", "SA", "EU", "AF", "AS", "OC", "AN"].includes(m)) return !ours.continent || ours.continent === m;
  return OPEN_CQ.has(m);
}
