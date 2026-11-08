/**
 * Download confirmations from LoTW, eQSL and QRZ Logbook and mark matching contacts.
 *
 * Matching is the same everywhere: same callsign, same band, start within a tolerance
 * (LoTW 2 min, QRZ 5 min, eQSL 30 min because eQSL users often log rounded times).
 * Award fields the log is missing are filled from LoTW, which is authoritative for them.
 * Each user's confirmations come from their own accounts and match only their own logbook.
 */
import { and, between, eq, sql } from "drizzle-orm";

import { parseAdif, recordToContact } from "@zerobeat/core/adif/adif";
import type { Db } from "@zerobeat/core/db/client";
import { qsos } from "@zerobeat/core/db/schema";
import { eqslInbox } from "@zerobeat/core/integrations/eqsl";
import { lotwDownloadConfirmations } from "@zerobeat/core/integrations/lotw";
import { qrzFetchAfter } from "@zerobeat/core/integrations/qrz";
import type { SettingsSnapshot } from "@zerobeat/core/settings/registry";
import type { EngineState } from "@zerobeat/core/state/engine-state";

function findMatch(db: Db, stationId: string, call: string, band: string, start: number, tolMs: number) {
  return db
    .select()
    .from(qsos)
    .where(and(eq(qsos.stationId, stationId), eq(qsos.callsign, call), eq(qsos.band, band), between(qsos.startTime, start - tolMs, start + tolMs)))
    .orderBy(sql`abs(${qsos.startTime} - ${start})`)
    .get();
}

export async function syncLotw(db: Db, s: SettingsSnapshot, state: EngineState, stationId: string): Promise<string> {
  if (!s["lotw.username"] || !s["lotw.password"]) return "no LoTW login";
  const since = state.get("lotwLastQslSince") || new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  const text = await lotwDownloadConfirmations({ username: s["lotw.username"], password: s["lotw.password"], since });
  const doc = parseAdif(text);
  let matched = 0;
  for (const rec of doc.records) {
    const r = recordToContact(rec);
    if (!r.ok) continue;
    const c = r.value.qso;
    const q = findMatch(db, stationId, c.callsign, c.band, c.startTime, 2 * 60_000);
    if (!q) continue;
    db.update(qsos)
      .set({
        lotwRcvd: true,
        lotwRcvdAt: c.lotwRcvdAt ?? Date.now(),
        grid: q.grid ?? c.grid,
        state: q.state ?? c.state,
        county: q.county ?? c.county,
        cqZone: q.cqZone ?? c.cqZone,
        ituZone: q.ituZone ?? c.ituZone,
        dxcc: q.dxcc ?? c.dxcc,
        iota: q.iota ?? c.iota,
        updatedAt: Date.now(),
      })
      .where(eq(qsos.id, q.id))
      .run();
    matched++;
  }
  const last = doc.header.APP_LOTW_LASTQSL;
  if (last) state.set("lotwLastQslSince", last.slice(0, 10));
  return `${doc.records.length} confirmations, ${matched} matched`;
}

export async function syncEqsl(db: Db, s: SettingsSnapshot, state: EngineState, stationId: string): Promise<string> {
  if (!s["eqsl.username"] || !s["eqsl.password"]) return "no eQSL login";
  const since = state.get("eqslLastRcvd") ?? null;
  const started = new Date();
  const text = await eqslInbox({ username: s["eqsl.username"], password: s["eqsl.password"], qthNickname: s["eqsl.qthNickname"] }, since);
  const doc = parseAdif(text);
  let matched = 0;
  for (const rec of doc.records) {
    const r = recordToContact(rec);
    if (!r.ok) continue;
    const q = findMatch(db, stationId, r.value.qso.callsign, r.value.qso.band, r.value.qso.startTime, 30 * 60_000);
    if (!q || q.eqslRcvd) continue;
    db.update(qsos).set({ eqslRcvd: true, updatedAt: Date.now() }).where(eq(qsos.id, q.id)).run();
    matched++;
  }
  state.set("eqslLastRcvd", started.toISOString().replace(/[-:T]/g, "").slice(0, 12));
  return `${doc.records.length} in the inbox, ${matched} matched`;
}

export async function syncQrz(db: Db, s: SettingsSnapshot, state: EngineState, stationId: string): Promise<string> {
  if (!s["qrz.logbookKey"]) return "no QRZ Logbook key";
  // Everything modified since a day before the last sync (QRZ's dates are UTC days; the
  // overlap costs a few repeat reads, never a missed confirmation). The first sync reads
  // the whole logbook.
  const since = state.get("qrzModSince");
  const started = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  // A sync that stopped at the page limit picks up after the last log id it read.
  let cursor = state.get("qrzResumeAfter") ?? 0;
  let seen = 0;
  let confirmed = 0;
  let complete = false;
  for (let page = 0; page < 40; page++) {
    const { adif } = await qrzFetchAfter(s["qrz.logbookKey"], cursor, 250, since);
    const doc = parseAdif(adif);
    if (!doc.records.length) {
      complete = true;
      break;
    }
    for (const rec of doc.records) {
      const id = Number(rec.APP_QRZLOG_LOGID);
      if (Number.isFinite(id) && id > cursor) cursor = id;
      seen++;
      const r = recordToContact(rec);
      if (!r.ok) continue;
      const q = findMatch(db, stationId, r.value.qso.callsign, r.value.qso.band, r.value.qso.startTime, 5 * 60_000);
      if (!q) continue;
      const isConfirmed = (rec.APP_QRZLOG_STATUS ?? "").toUpperCase() === "C";
      db.update(qsos)
        .set({ qrzLogId: Number.isFinite(id) ? id : q.qrzLogId, qrzRcvd: q.qrzRcvd || isConfirmed, updatedAt: Date.now() })
        .where(eq(qsos.id, q.id))
        .run();
      if (isConfirmed && !q.qrzRcvd) confirmed++;
    }
    if (doc.records.length < 250) {
      complete = true;
      break;
    }
  }
  state.set("qrzLastLogId", Math.max(cursor, state.get("qrzLastLogId") ?? 0));
  // Only a sync that read to the end moves the date on; a partial one resumes next time.
  if (complete) {
    state.set("qrzModSince", started);
    state.set("qrzResumeAfter", 0);
  } else state.set("qrzResumeAfter", cursor);
  return `${seen} records read, ${confirmed} newly confirmed`;
}
