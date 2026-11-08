/**
 * Award progress, computed from the log in one pass.
 *
 * "Confirmed" has ONE definition here, shared with the logbook filters and stats:
 *  - credit: a paper card marked received, or a LoTW confirmation. This is what DXCC
 *    and WAS accept.
 *  - any: credit, or an eQSL or QRZ confirmation. Shown, never counted as credit.
 */
import { sql } from "drizzle-orm";

import type { Db } from "../db/client.ts";
import { getDxcc } from "../dxcc/cty.ts";
import { CONTINENTS, US_DXCC, US_STATES } from "../ham/us-states.ts";

export interface ConfirmFlags {
  qslRcvd: string;
  lotwRcvd: boolean | number;
  eqslRcvd: boolean | number;
  qrzRcvd: boolean | number;
}

export function hasCredit(q: ConfirmFlags): boolean {
  return q.qslRcvd === "CONFIRMED" || !!q.lotwRcvd;
}

export function anyConfirmation(q: ConfirmFlags): boolean {
  return hasCredit(q) || !!q.eqslRcvd || !!q.qrzRcvd;
}

export type Status = "confirmed" | "worked";

export interface AwardEntry {
  key: string;
  label: string;
  status: Status;
  /** Bands worked / confirmed, for the band matrix. */
  bands: Record<string, Status>;
}

export interface Award {
  id: "dxcc" | "was" | "waz" | "wac" | "grids" | "pota";
  name: string;
  /** Null when there is no fixed total (grids, parks). */
  total: number | null;
  worked: number;
  confirmed: number;
  entries: AwardEntry[];
  /** For awards with a fixed universe: the ones not yet worked. */
  missing: { key: string; label: string }[];
  /** Worked entries outside the current universe (deleted DXCC entities): shown, never counted. */
  outside?: AwardEntry[];
  /** False where a card or LoTW is not how the award confirms (POTA): no confirmed count. */
  confirms?: boolean;
}

/** The six continents of WAC. Antarctica is a continent but not part of the award. */
const WAC_CONTINENTS = ["NA", "SA", "EU", "AF", "AS", "OC"] as const;

/** ADIF modes by award mode group, as LoTW groups them. */
// ARRL counts SSTV toward Phone for DXCC (arrl.org/dxcc-award-information).
const PHONE_MODES = ["SSB", "AM", "FM", "SSTV", "DIGITALVOICE", "DSTAR", "C4FM", "DMR", "FREEDV", "M17"];

interface Row extends ConfirmFlags {
  band: string;
  dxcc: number | null;
  state: string | null;
  cq_zone: number | null;
  continent: string | null;
  grid: string | null;
  refs: string | null;
}

class Tally {
  private map = new Map<string, AwardEntry>();
  constructor(private readonly labelOf: (k: string) => string) {}
  add(key: string, band: string, credit: boolean): void {
    let e = this.map.get(key);
    if (!e) {
      e = { key, label: this.labelOf(key), status: "worked", bands: {} };
      this.map.set(key, e);
    }
    const st: Status = credit ? "confirmed" : "worked";
    if (credit) e.status = "confirmed";
    if (e.bands[band] !== "confirmed") e.bands[band] = st;
  }
  entries(sort: (a: AwardEntry, b: AwardEntry) => number): AwardEntry[] {
    return [...this.map.values()].sort(sort);
  }
  has(k: string): boolean {
    return this.map.has(k);
  }
}

const byLabel = (a: AwardEntry, b: AwardEntry) => a.label.localeCompare(b.label);
const byKeyNum = (a: AwardEntry, b: AwardEntry) => Number(a.key) - Number(b.key);

function finish(id: Award["id"], name: string, t: Tally, sort: (a: AwardEntry, b: AwardEntry) => number, universe?: { key: string; label: string }[]): Award {
  const all = t.entries(sort);
  // Only entries in the award's universe count; the rest (a deleted DXCC entity from an
  // old log) are listed apart so they can't push the count past what the award accepts.
  const inUniverse = universe ? new Set(universe.map((u) => u.key)) : null;
  const entries = inUniverse ? all.filter((e) => inUniverse.has(e.key)) : all;
  const outside = inUniverse ? all.filter((e) => !inUniverse.has(e.key)) : [];
  return {
    id,
    name,
    total: universe ? universe.length : null,
    worked: entries.length,
    confirmed: entries.filter((e) => e.status === "confirmed").length,
    entries,
    missing: universe ? universe.filter((u) => !t.has(u.key)) : [],
    ...(outside.length ? { outside } : {}),
  };
}

export function computeAwards(db: Db, opts: { stationId?: string; mode?: string } = {}): Award[] {
  const filters: ReturnType<typeof sql>[] = [];
  if (opts.stationId) filters.push(sql`station_id = ${opts.stationId}`);
  // Mode groups as LoTW and the ARRL count them, or one mode.
  const phone = sql.join(PHONE_MODES.map((m) => sql`${m}`), sql`, `);
  if (opts.mode === "PHONE") filters.push(sql`mode IN (${phone})`);
  else if (opts.mode === "DIGITAL") filters.push(sql`mode NOT IN (${phone}) AND mode <> 'CW'`);
  else if (opts.mode) filters.push(sql`(mode = ${opts.mode} OR submode = ${opts.mode})`);
  const where = filters.length ? sql`WHERE ${sql.join(filters, sql` AND `)}` : sql``;
  const rows = db.all<Row>(sql`
    SELECT band, dxcc, state, cq_zone, continent, grid, qsl_rcvd AS qslRcvd, lotw_rcvd AS lotwRcvd,
           eqsl_rcvd AS eqslRcvd, qrz_rcvd AS qrzRcvd,
           (SELECT group_concat(ref) FROM qso_sig_refs r WHERE r.qso_id = qsos.id AND r.sig = 'POTA') AS refs
    FROM qsos ${where}
  `);

  const dx = getDxcc();
  const dxcc = new Tally((k) => dx.entity(Number(k))?.name ?? `Entity ${k}`);
  const was = new Tally((k) => US_STATES[k] ?? k);
  const waz = new Tally((k) => `Zone ${k}`);
  const wac = new Tally((k) => CONTINENTS[k] ?? k);
  const grids = new Tally((k) => k);
  const pota = new Tally((k) => k);

  for (const r of rows) {
    const credit = hasCredit(r);
    if (r.dxcc) dxcc.add(String(r.dxcc), r.band, credit);
    // DC counts as Maryland for WAS.
    const st = r.state === "DC" ? "MD" : r.state;
    if (st && r.dxcc && US_DXCC.has(r.dxcc) && US_STATES[st]) was.add(st, r.band, credit);
    if (r.cq_zone && r.cq_zone >= 1 && r.cq_zone <= 40) waz.add(String(r.cq_zone), r.band, credit);
    if (r.continent && CONTINENTS[r.continent]) wac.add(r.continent, r.band, credit);
    if (r.grid && r.grid.length >= 4) grids.add(r.grid.slice(0, 4).toUpperCase(), r.band, credit);
    for (const ref of (r.refs ?? "").split(",").filter(Boolean)) pota.add(ref, r.band, credit);
  }

  return [
    finish("dxcc", "DXCC", dxcc, byLabel, dx.allEntities().map((e) => ({ key: String(e.adif), label: e.name }))),
    finish("was", "Worked All States", was, byLabel, Object.entries(US_STATES).map(([key, label]) => ({ key, label }))),
    finish("waz", "Worked All Zones", waz, byKeyNum, Array.from({ length: 40 }, (_, i) => ({ key: String(i + 1), label: `Zone ${i + 1}` }))),
    finish("wac", "Worked All Continents", wac, byLabel, WAC_CONTINENTS.map((key) => ({ key, label: CONTINENTS[key]! }))),
    finish("grids", "Grid squares", grids, byLabel),
    // POTA hunter credit comes from the activator's upload, not a card or LoTW.
    { ...finish("pota", "POTA parks", pota, byLabel), confirms: false },
  ];
}
