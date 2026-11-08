/**
 * "While you were away": what happened at the station since a time, as facts from the
 * database. Contacts and runs, what was new, the needed entities the receiver decoded
 * but nobody worked, failed uploads and the brakes that fired. No summary text: every
 * item is a thing that happened, with its call, band and time.
 */
import { sql } from "drizzle-orm";

import type { Db } from "../db/client.ts";
import { getDxcc } from "../dxcc/cty.ts";

export interface AwaySummary {
  since: number;
  contacts: number;
  runs: number;
  /** New entities, zones, continents, parks worked, from the runs. */
  newOnes: { kind: string; label: string; callsign: string }[];
  /** Entities the log needs that were decoded and not worked: the best decode of each. */
  missed: { dxcc: number; name: string; callsign: string; band: string; mode: string; at: number; snr: number; times: number }[];
  failedUploads: { service: string; count: number; lastError: string | null }[];
  faults: { at: number; reason: string }[];
}

export function awaySummary(db: Db, stationId: string, since: number): AwaySummary {
  const contacts = db.get<{ n: number }>(sql`SELECT COUNT(*) AS n FROM qsos WHERE station_id = ${stationId} AND created_at >= ${since}`)?.n ?? 0;
  const runs = db.all<{ started_at: number; new_ones: string; faults: string }>(
    sql`SELECT started_at, new_ones, faults FROM runs WHERE station_id = ${stationId} AND (started_at >= ${since} OR ended_at >= ${since} OR ended_at IS NULL)`,
  );
  const newOnes = runs
    .flatMap((r) => {
      try {
        return JSON.parse(r.new_ones) as { kind: string; label: string; callsign: string }[];
      } catch {
        return [];
      }
    })
    .filter((n) => ["dxcc", "zone", "continent", "park"].includes(n.kind));
  const faults = runs.flatMap((r) => {
    try {
      return (JSON.parse(r.faults) as { at?: number; reason: string }[]).map((f) => ({ at: f.at ?? r.started_at, reason: f.reason }));
    } catch {
      return [];
    }
  });

  // Needed entities on the air: decodes since then whose entity the log has never worked.
  const worked = new Set(db.all<{ dxcc: number }>(sql`SELECT DISTINCT dxcc FROM qsos WHERE station_id = ${stationId} AND dxcc IS NOT NULL`).map((r) => r.dxcc));
  const rows = db.all<{ callsign: string; band: string; mode: string; at: number; snr: number }>(
    sql`SELECT callsign, band, mode, at, snr FROM decodes WHERE at >= ${since} AND callsign IS NOT NULL ORDER BY at`,
  );
  const dx = getDxcc();
  const missed = new Map<number, AwaySummary["missed"][number]>();
  for (const r of rows) {
    const e = dx.resolve(r.callsign);
    if (!e || worked.has(e.adif)) continue;
    const m = missed.get(e.adif);
    if (!m) missed.set(e.adif, { dxcc: e.adif, name: e.name, callsign: r.callsign, band: r.band, mode: r.mode, at: r.at, snr: r.snr, times: 1 });
    else {
      m.times++;
      if (r.snr > m.snr) Object.assign(m, { callsign: r.callsign, band: r.band, mode: r.mode, at: r.at, snr: r.snr });
    }
  }
  const failedUploads = db.all<{ service: string; count: number; last_error: string | null }>(
    sql`SELECT u.service, COUNT(*) AS count, MAX(u.last_error) AS last_error FROM upload_state u JOIN qsos q ON q.id = u.qso_id WHERE q.station_id = ${stationId} AND u.status = 'failed' AND u.updated_at >= ${since} GROUP BY u.service`,
  );
  return {
    since,
    contacts,
    runs: runs.length,
    newOnes: newOnes.slice(0, 12),
    missed: [...missed.values()].sort((a, b) => b.snr - a.snr).slice(0, 8),
    failedUploads: failedUploads.map((f) => ({ service: f.service, count: f.count, lastError: f.last_error })),
    faults: faults.filter((f) => f.at >= since).slice(0, 5),
  };
}
