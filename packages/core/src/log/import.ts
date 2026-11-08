/**
 * ADIF import. History versus new contacts is an explicit choice: imported history is
 * NOT queued for upload unless the operator asks, which is the mistake that pushed 7,384
 * duplicates into N3FJP on the old install.
 */
import { and, eq, inArray, sql } from "drizzle-orm";

import { dupeKey, parseAdif, recordToContact } from "../adif/adif.ts";
import type { Db } from "../db/client.ts";
import { qsos, type UploadService, stations } from "../db/schema.ts";
import { createQso } from "./qsos.ts";

export interface ImportOptions {
  stationId: string;
  /** Skip records that match an existing contact (call, band, mode, minute). */
  skipDuplicates: boolean;
  /** Queue imported contacts for these services. Empty = treat as history. */
  uploadServices: UploadService[];
  dryRun?: boolean;
}

export interface ImportReport {
  records: number;
  imported: number;
  duplicates: number;
  rejected: { index: number; error: string }[];
  warnings: string[];
}

export function importAdif(db: Db, input: string | Buffer, opts: ImportOptions): ImportReport {
  const doc = parseAdif(input);
  const report: ImportReport = { records: doc.records.length, imported: 0, duplicates: 0, rejected: [], warnings: [] };

  const contacts = doc.records.map((r, index) => ({ index, res: recordToContact(r) }));
  const calls = [...new Set(contacts.flatMap((c) => (c.res.ok ? [c.res.value.qso.callsign] : [])))];
  const existing = new Set<string>();
  if (opts.skipDuplicates) {
    for (let i = 0; i < calls.length; i += 500) {
      const chunk = calls.slice(i, i + 500);
      for (const q of db
        .select({ callsign: qsos.callsign, band: qsos.band, mode: qsos.mode, submode: qsos.submode, startTime: qsos.startTime })
        .from(qsos)
        .where(and(eq(qsos.stationId, opts.stationId), inArray(qsos.callsign, chunk)))
        .all()) {
        existing.add(dupeKey(q));
        // A contact logged at 12:34:59 in one program and 12:35:00 in another is the same.
        existing.add(dupeKey(q, -1));
        existing.add(dupeKey(q, 1));
      }
    }
  }

  // Only the importer's own station: another user's call in STATION_CALLSIGN is not theirs.
  const stationByCall = new Map(db.select({ id: stations.id, callsign: stations.callsign }).from(stations).where(eq(stations.id, opts.stationId)).all().map((s) => [s.callsign.toUpperCase(), s.id]));
  const warnedCalls = new Set<string>();
  const run = () => {
    for (const { index, res } of contacts) {
      if (!res.ok) {
        report.rejected.push({ index, error: res.error });
        continue;
      }
      report.warnings.push(...res.value.warnings.slice(0, 3));
      const key = dupeKey(res.value.qso);
      if (opts.skipDuplicates && existing.has(key)) {
        report.duplicates++;
        continue;
      }
      existing.add(key);
      // A record made under another of our station callsigns (a portable call, a club
      // call) goes to that station; otherwise to the one chosen for the import.
      const sc = res.value.stationCallsign;
      const stationId = (sc && stationByCall.get(sc)) || opts.stationId;
      if (sc && !stationByCall.has(sc) && !warnedCalls.has(sc)) {
        warnedCalls.add(sc);
        report.warnings.push(`STATION_CALLSIGN ${sc} is not your callsign; those contacts went into your logbook`);
      }
      if (!opts.dryRun) {
        createQso(db, { ...res.value.qso, stationId, sigRefs: res.value.sigRefs }, { uploadServices: opts.uploadServices });
      }
      report.imported++;
    }
  };
  if (opts.dryRun) run();
  else db.transaction(() => run());
  if (report.warnings.length > 200) report.warnings = report.warnings.slice(0, 200);
  return report;
}

export function countQsos(db: Db): number {
  return db.get<{ c: number }>(sql`SELECT COUNT(*) AS c FROM qsos`)?.c ?? 0;
}

