/**
 * The logbook. Every write to `qsos` goes through here, so DXCC enrichment, special
 * activity references and upload queueing happen the same way for manual entry, the
 * engine, ADIF import and the public API.
 */
import { and, asc, desc, eq, gte, inArray, like, lte, or, sql, type SQL } from "drizzle-orm";

import type { Db } from "../db/client.ts";
import {
  qsoSigRefs,
  qsos,
  stations,
  uploadState,
  UPLOAD_SERVICES,
  type NewQso,
  type Qso,
  type Station,
  type UploadService,
} from "../db/schema.ts";
import { getDxcc } from "../dxcc/cty.ts";
import { bandForHz } from "../ham/bands.ts";
import { normaliseCallsign } from "../ham/callsign.ts";
import { toAdifMode } from "../ham/modes.ts";
import type { SettingsSnapshot } from "../settings/registry.ts";
import { newId } from "../util/id.ts";
import { startOfUtcDay } from "../util/time.ts";

export type QsoInput = Omit<NewQso, "id" | "createdAt" | "updatedAt"> & {
  sigRefs?: { sig: string; ref: string }[];
};

/** The services new contacts are queued for, from settings. */
export function enabledUploadServices(s: SettingsSnapshot): UploadService[] {
  const on: UploadService[] = [];
  if (s["uploads.qrz"] && s["qrz.logbookKey"]) on.push("qrz");
  if (s["uploads.lotw"]) on.push("lotw");
  if (s["uploads.eqsl"] && s["eqsl.username"] && s["eqsl.password"]) on.push("eqsl");
  if (s["uploads.clublog"] && s["clublog.email"] && s["clublog.apiKey"]) on.push("clublog");
  if (s["uploads.wrl"] && s["wrl.apiKey"]) on.push("wrl");
  if (s["uploads.n3fjp"] && s["n3fjp.host"]) on.push("n3fjp");
  return on;
}

/** Fill DXCC, zones and continent from the callsign where the caller left them empty. */
export function enrich<T extends Partial<NewQso> & { callsign: string; startTime: number }>(q: T): T {
  if (q.dxcc && q.cqZone && q.continent && q.ituZone) return q;
  const m = getDxcc().resolve(q.callsign);
  if (!m) return q;
  // Only trust the resolver when it agrees with an entity already given (or none was).
  if (q.dxcc && q.dxcc !== m.adif) return q;
  return {
    ...q,
    dxcc: q.dxcc ?? m.adif,
    cqZone: q.cqZone ?? m.cqZone,
    ituZone: q.ituZone ?? m.ituZone,
    continent: q.continent ?? m.continent,
  };
}

function normaliseInput(input: QsoInput): QsoInput {
  const callsign = normaliseCallsign(input.callsign);
  const { mode, submode } = toAdifMode(input.mode, input.submode);
  const band = input.band || bandForHz(input.freqHz)?.name || input.band;
  return { ...input, callsign, mode, submode, band };
}

export function createQso(
  db: Db,
  input: QsoInput,
  opts: { uploadServices?: UploadService[] } = {},
): { qso: Qso; created: boolean } {
  const data = enrich(normaliseInput(input));
  if (data.clientId) {
    const existing = db.select().from(qsos).where(eq(qsos.clientId, data.clientId)).get();
    if (existing) return { qso: existing, created: false };
  }
  const id = newId();
  const now = Date.now();
  const { sigRefs, ...row } = data;
  const refs = normaliseRefs(sigRefs, row.sig, row.sigInfo);
  const qso = db.transaction((tx) => {
    tx.insert(qsos)
      .values({ ...row, id, sig: refs[0]?.sig ?? null, sigInfo: refs[0]?.ref ?? null, createdAt: now, updatedAt: now })
      .run();
    for (const r of refs) tx.insert(qsoSigRefs).values({ qsoId: id, sig: r.sig, ref: r.ref }).onConflictDoNothing().run();
    for (const service of opts.uploadServices ?? []) {
      tx.insert(uploadState).values({ qsoId: id, service, status: "pending", updatedAt: now }).onConflictDoNothing().run();
    }
    return tx.select().from(qsos).where(eq(qsos.id, id)).get()!;
  });
  return { qso, created: true };
}

function normaliseRefs(refs: { sig: string; ref: string }[] | undefined, sig?: string | null, sigInfo?: string | null) {
  const out: { sig: string; ref: string }[] = [];
  const seen = new Set<string>();
  const add = (s: string, r: string) => {
    const S = s.trim().toUpperCase();
    const R = r.trim().toUpperCase();
    if (!S || !R || seen.has(`${S}|${R}`)) return;
    seen.add(`${S}|${R}`);
    out.push({ sig: S, ref: R });
  };
  if (sig && sigInfo) add(sig, sigInfo);
  for (const r of refs ?? []) add(r.sig, r.ref);
  return out;
}

export function updateQso(db: Db, id: string, patch: Partial<QsoInput>): Qso | null {
  const existing = db.select().from(qsos).where(eq(qsos.id, id)).get();
  if (!existing) return null;
  const { sigRefs, ...rest } = patch;
  const merged = { ...existing, ...rest } as QsoInput;
  const norm = normaliseInput(merged);
  const callChanged = norm.callsign !== existing.callsign;
  const enriched = callChanged ? enrich({ ...norm, dxcc: rest.dxcc ?? null, cqZone: rest.cqZone ?? null, ituZone: rest.ituZone ?? null, continent: rest.continent ?? null }) : norm;
  const now = Date.now();
  return db.transaction((tx) => {
    const { sigRefs: _drop, ...row } = enriched;
    let refsRow: { sig: string | null; sigInfo: string | null } = { sig: row.sig ?? null, sigInfo: row.sigInfo ?? null };
    if (sigRefs !== undefined) {
      // The patch carries the references for the activities it edits (the form knows
      // POTA); references for other activities (SOTA, WWFF, IOTA...) are kept.
      const refs = normaliseRefs(sigRefs);
      const edited = new Set(refs.map((r) => r.sig));
      if (!edited.size) edited.add("POTA");
      const kept = tx
        .select({ sig: qsoSigRefs.sig, ref: qsoSigRefs.ref })
        .from(qsoSigRefs)
        .where(eq(qsoSigRefs.qsoId, id))
        .all()
        .filter((r) => !edited.has(r.sig));
      const all = [...kept, ...refs];
      tx.delete(qsoSigRefs).where(eq(qsoSigRefs.qsoId, id)).run();
      for (const r of all) tx.insert(qsoSigRefs).values({ qsoId: id, ...r }).run();
      refsRow = { sig: all[0]?.sig ?? null, sigInfo: all[0]?.ref ?? null };
    }
    const { id: _id, createdAt: _c, ...values } = row as Qso;
    // A contact whose call, band, mode or minute changed is a different contact to the
    // services: their confirmations no longer apply and it must be sent again.
    const keyChanged = callChanged || norm.band !== existing.band || norm.mode !== existing.mode || Math.floor(norm.startTime / 60_000) !== Math.floor(existing.startTime / 60_000);
    const cleared = keyChanged ? { lotwRcvd: false, lotwRcvdAt: null, eqslRcvd: false, qrzRcvd: false } : {};
    tx.update(qsos).set({ ...values, ...refsRow, ...cleared, updatedAt: now }).where(eq(qsos.id, id)).run();
    // An edited contact must be re-sent: to QRZ and Club Log, which keep the edited
    // fields, on any edit; to every service when it became a different contact.
    tx.update(uploadState)
      .set({ status: "pending", attempts: 0, nextAttemptAt: null, lastError: null, updatedAt: now })
      .where(keyChanged ? eq(uploadState.qsoId, id) : and(eq(uploadState.qsoId, id), inArray(uploadState.service, ["qrz", "clublog"])))
      .run();
    return tx.select().from(qsos).where(eq(qsos.id, id)).get()!;
  });
}

export function deleteQso(db: Db, id: string): boolean {
  return db.delete(qsos).where(eq(qsos.id, id)).run().changes > 0;
}

export function getQso(db: Db, id: string) {
  const qso = db.select().from(qsos).where(eq(qsos.id, id)).get();
  if (!qso) return null;
  const refs = db.select().from(qsoSigRefs).where(eq(qsoSigRefs.qsoId, id)).all();
  const uploads = db.select().from(uploadState).where(eq(uploadState.qsoId, id)).all();
  const station = db.select().from(stations).where(eq(stations.id, qso.stationId)).get() ?? null;
  return { qso, sigRefs: refs.map((r) => ({ sig: r.sig, ref: r.ref })), uploads, station };
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface QsoQuery {
  q?: string;
  callsign?: string;
  band?: string;
  mode?: string;
  from?: number;
  to?: number;
  /** credit: card or LoTW (what awards count); any: credit, eQSL or QRZ; nocredit: no card or LoTW yet. */
  confirmed?: "credit" | "any" | "lotw" | "none" | "nocredit";
  dxcc?: number;
  stationId?: string;
  park?: string;
  page?: number;
  pageSize?: number;
  /** "newest", "oldest", or a column and direction: "call-asc", "band-desc"... */
  sort?: string;
}

const SORT_COLUMNS = { time: qsos.startTime, call: qsos.callsign, band: qsos.band, mode: qsos.mode, grid: qsos.grid, country: qsos.dxcc } as const;

/** The ORDER BY for a sort string; newest first when it names nothing known. */
function orderFor(sort: string | undefined) {
  if (sort === "oldest") return [asc(qsos.startTime)];
  const m = /^(time|call|band|mode|grid|country)-(asc|desc)$/.exec(sort ?? "");
  if (!m) return [desc(qsos.startTime)];
  const col = SORT_COLUMNS[m[1] as keyof typeof SORT_COLUMNS];
  const dir = m[2] === "asc" ? asc : desc;
  // Ties by time, newest first, so a sorted page still reads in order.
  return m[1] === "time" ? [dir(col)] : [dir(col), desc(qsos.startTime)];
}

/** The DXCC entities and modes in the log, for the filter pickers. */
export function logFacets(db: Db, stationId: string): { dxcc: number[]; modes: string[] } {
  const dxcc = db.all<{ d: number }>(sql`SELECT DISTINCT dxcc AS d FROM qsos WHERE station_id = ${stationId} AND dxcc IS NOT NULL`).map((r) => r.d);
  const modes = db.all<{ m: string }>(sql`SELECT DISTINCT COALESCE(submode, mode) AS m FROM qsos WHERE station_id = ${stationId} ORDER BY m`).map((r) => r.m);
  return { dxcc, modes };
}

export function searchQsos(db: Db, query: QsoQuery) {
  const where: SQL[] = [];
  if (query.q) {
    const t = `%${query.q.trim().toUpperCase()}%`;
    where.push(or(like(qsos.callsign, t), like(sql`upper(${qsos.name})`, t), like(qsos.grid, t), like(sql`upper(${qsos.sigInfo})`, t))!);
  }
  if (query.callsign) where.push(eq(qsos.callsign, normaliseCallsign(query.callsign)));
  if (query.band) where.push(eq(qsos.band, query.band.toUpperCase()));
  if (query.mode) {
    const m = query.mode.toUpperCase();
    where.push(or(eq(qsos.mode, m), eq(qsos.submode, m))!);
  }
  if (query.from) where.push(gte(qsos.startTime, query.from));
  if (query.to) where.push(lte(qsos.startTime, query.to));
  if (query.dxcc) where.push(eq(qsos.dxcc, query.dxcc));
  if (query.stationId) where.push(eq(qsos.stationId, query.stationId));
  if (query.park) where.push(sql`${qsos.id} IN (SELECT qso_id FROM qso_sig_refs WHERE ref = ${query.park.toUpperCase()})`);
  if (query.confirmed === "lotw") where.push(eq(qsos.lotwRcvd, true));
  if (query.confirmed === "credit") where.push(sql`(${qsos.lotwRcvd} = 1 OR ${qsos.qslRcvd} = 'CONFIRMED')`);
  if (query.confirmed === "nocredit") where.push(sql`(${qsos.lotwRcvd} = 0 AND ${qsos.qslRcvd} <> 'CONFIRMED')`);
  if (query.confirmed === "any") where.push(sql`(${qsos.lotwRcvd} = 1 OR ${qsos.qslRcvd} = 'CONFIRMED' OR ${qsos.eqslRcvd} = 1 OR ${qsos.qrzRcvd} = 1)`);
  if (query.confirmed === "none") where.push(sql`(${qsos.lotwRcvd} = 0 AND ${qsos.qslRcvd} <> 'CONFIRMED' AND ${qsos.eqslRcvd} = 0 AND ${qsos.qrzRcvd} = 0)`);

  const pageSize = Math.min(Math.max(query.pageSize ?? 50, 1), 500);
  const page = Math.max(query.page ?? 1, 1);
  const cond = where.length ? and(...where) : undefined;
  const total = db.select({ c: sql<number>`count(*)` }).from(qsos).where(cond).get()?.c ?? 0;
  const rows = db
    .select()
    .from(qsos)
    .where(cond)
    .orderBy(...orderFor(query.sort))
    .limit(pageSize)
    .offset((page - 1) * pageSize)
    .all();
  return { rows, total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)) };
}

// ---------------------------------------------------------------------------
// Dupe and "worked before"
// ---------------------------------------------------------------------------

export interface WorkedBefore {
  total: number;
  thisBand: number;
  thisBandMode: number;
  today: number;
  last: Qso | null;
}

export function workedBefore(db: Db, stationId: string, callsign: string, band?: string, mode?: string, now = Date.now()): WorkedBefore {
  const call = normaliseCallsign(callsign);
  const rows = db.select().from(qsos).where(and(eq(qsos.stationId, stationId), eq(qsos.callsign, call))).orderBy(desc(qsos.startTime)).all();
  const m = mode?.toUpperCase();
  const sameMode = (q: Qso) => !m || q.mode === m || q.submode === m;
  const today = startOfUtcDay(now);
  return {
    total: rows.length,
    thisBand: band ? rows.filter((q) => q.band === band).length : 0,
    thisBandMode: band ? rows.filter((q) => q.band === band && sameMode(q)).length : 0,
    today: rows.filter((q) => q.startTime >= today && (!band || q.band === band) && sameMode(q)).length,
    last: rows[0] ?? null,
  };
}

// ---------------------------------------------------------------------------
// Stations
// ---------------------------------------------------------------------------

export function defaultStation(db: Db): Station | null {
  return (
    db.select().from(stations).where(eq(stations.isDefault, true)).get() ??
    db.select().from(stations).orderBy(asc(stations.createdAt)).get() ??
    null
  );
}

export function queueUploads(db: Db, service: UploadService, opts: { stationId: string; since?: number; onlyMissing?: boolean }): number {
  const now = Date.now();
  const since = opts.since ?? 0;
  const res = db.run(sql`
    INSERT INTO upload_state (qso_id, service, status, attempts, updated_at)
    SELECT id, ${service}, 'pending', 0, ${now} FROM qsos
    WHERE station_id = ${opts.stationId} AND start_time >= ${since}
    ON CONFLICT (qso_id, service) DO ${opts.onlyMissing === false ? sql`UPDATE SET status = 'pending', attempts = 0, next_attempt_at = NULL, last_error = NULL, updated_at = ${now} WHERE status IN ('failed', 'skipped')` : sql`NOTHING`}
  `);
  return res.changes;
}

export function markUploadsSent(db: Db, service: UploadService, opts: { stationId: string; before: number }): number {
  const now = Date.now();
  return db.run(sql`
    INSERT INTO upload_state (qso_id, service, status, attempts, sent_at, updated_at)
    SELECT id, ${service}, 'skipped', 0, NULL, ${now} FROM qsos WHERE station_id = ${opts.stationId} AND start_time < ${opts.before}
    ON CONFLICT (qso_id, service) DO UPDATE SET status = 'skipped', updated_at = ${now} WHERE status = 'pending'
  `).changes;
}

export { UPLOAD_SERVICES };
