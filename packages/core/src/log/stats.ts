/** Dashboard and statistics queries, of one station's logbook. Plain SQL; each is one round trip. */
import { sql } from "drizzle-orm";

import type { Db } from "../db/client.ts";
import { DAY, startOfUtcDay } from "../util/time.ts";

export interface Summary {
  total: number;
  confirmedCredit: number;
  dxcc: number;
  dxccConfirmed: number;
  today: number;
  yesterday: number;
  last7: number;
  last30: number;
  firstQso: number | null;
}

export function summary(db: Db, stationId: string, now = Date.now()): Summary {
  const today = startOfUtcDay(now);
  const r = db.get<Summary>(sql`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN qsl_rcvd = 'CONFIRMED' OR lotw_rcvd = 1 THEN 1 ELSE 0 END) AS confirmedCredit,
      COUNT(DISTINCT dxcc) AS dxcc,
      COUNT(DISTINCT CASE WHEN qsl_rcvd = 'CONFIRMED' OR lotw_rcvd = 1 THEN dxcc END) AS dxccConfirmed,
      SUM(CASE WHEN start_time >= ${today} THEN 1 ELSE 0 END) AS today,
      SUM(CASE WHEN start_time >= ${today - DAY} AND start_time < ${today} THEN 1 ELSE 0 END) AS yesterday,
      SUM(CASE WHEN start_time >= ${today - 6 * DAY} THEN 1 ELSE 0 END) AS last7,
      SUM(CASE WHEN start_time >= ${today - 29 * DAY} THEN 1 ELSE 0 END) AS last30,
      MIN(start_time) AS firstQso
    FROM qsos WHERE station_id = ${stationId}
  `)!;
  return {
    total: r.total ?? 0,
    confirmedCredit: r.confirmedCredit ?? 0,
    dxcc: r.dxcc ?? 0,
    dxccConfirmed: r.dxccConfirmed ?? 0,
    today: r.today ?? 0,
    yesterday: r.yesterday ?? 0,
    last7: r.last7 ?? 0,
    last30: r.last30 ?? 0,
    firstQso: r.firstQso ?? null,
  };
}

export function byBandMode(db: Db, stationId: string, since = 0): { band: string; mode: string; count: number }[] {
  return db.all(sql`
    SELECT band, COALESCE(submode, mode) AS mode, COUNT(*) AS count
    FROM qsos WHERE station_id = ${stationId} AND start_time >= ${since}
    GROUP BY band, COALESCE(submode, mode) ORDER BY count DESC
  `);
}

/** Contacts per UTC day for the last `days` days, oldest first, zero-filled. */
export function perDay(db: Db, stationId: string, days = 30, now = Date.now()): { day: string; count: number }[] {
  const start = startOfUtcDay(now) - (days - 1) * DAY;
  const rows = db.all<{ day: string; count: number }>(sql`
    SELECT strftime('%Y-%m-%d', start_time / 1000, 'unixepoch') AS day, COUNT(*) AS count
    FROM qsos WHERE station_id = ${stationId} AND start_time >= ${start} GROUP BY day
  `);
  const map = new Map(rows.map((r) => [r.day, r.count]));
  return Array.from({ length: days }, (_, i) => {
    const d = new Date(start + i * DAY).toISOString().slice(0, 10);
    return { day: d, count: map.get(d) ?? 0 };
  });
}

/** Entities, states or zones worked for the first time today. */
export function newOnes(db: Db, stationId: string, now = Date.now()): { kind: string; key: string; callsign: string; at: number }[] {
  const today = startOfUtcDay(now);
  return db.all(sql`
    SELECT 'dxcc' AS kind, CAST(dxcc AS TEXT) AS key, callsign, start_time AS at FROM qsos q
    WHERE q.station_id = ${stationId} AND start_time >= ${today} AND dxcc IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM qsos p WHERE p.station_id = ${stationId} AND p.dxcc = q.dxcc AND p.start_time < ${today})
      AND start_time = (SELECT MIN(start_time) FROM qsos x WHERE x.station_id = ${stationId} AND x.dxcc = q.dxcc)
    UNION ALL
    SELECT 'state', state, callsign, start_time FROM qsos q
    WHERE q.station_id = ${stationId} AND start_time >= ${today} AND state IS NOT NULL AND dxcc IN (291, 6, 110)
      AND NOT EXISTS (SELECT 1 FROM qsos p WHERE p.station_id = ${stationId} AND p.state = q.state AND p.dxcc IN (291, 6, 110) AND p.start_time < ${today})
      AND start_time = (SELECT MIN(start_time) FROM qsos x WHERE x.station_id = ${stationId} AND x.state = q.state AND x.dxcc IN (291, 6, 110))
    ORDER BY at DESC LIMIT 50
  `);
}

export function uploadSummary(db: Db, stationId: string): { service: string; status: string; count: number }[] {
  return db.all(sql`SELECT u.service, u.status, COUNT(*) AS count FROM upload_state u JOIN qsos q ON q.id = u.qso_id WHERE q.station_id = ${stationId} GROUP BY u.service, u.status`);
}

export function mapPoints(db: Db, opts: { stationId: string; since?: number; band?: string }): { grid: string; count: number; confirmed: number }[] {
  return db.all(sql`
    SELECT upper(substr(grid, 1, 4)) AS grid, COUNT(*) AS count,
           SUM(CASE WHEN qsl_rcvd = 'CONFIRMED' OR lotw_rcvd = 1 THEN 1 ELSE 0 END) AS confirmed
    FROM qsos
    WHERE station_id = ${opts.stationId} AND grid IS NOT NULL AND length(grid) >= 4 AND start_time >= ${opts.since ?? 0}
      ${opts.band ? sql`AND band = ${opts.band}` : sql``}
    GROUP BY upper(substr(grid, 1, 4))
  `);
}
