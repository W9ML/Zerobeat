/**
 * The DXCC entities this station hears, by band, mode and UTC hour, kept forever, and the
 * question they answer best: which entities the log still needs that this antenna
 * actually hears, and when. ClubLog's charts come from other people's logs; this is
 * what reaches you.
 */
import { sql } from "drizzle-orm";

import type { Db } from "../db/client.ts";
import { getDxcc } from "../dxcc/cty.ts";

export interface EntityHit {
  decodes: number;
  bestSnr: number | null;
  lastAt: number;
  lastCall: string;
}

/** Add what one stretch of decoding heard. \`key\` is "band|mode|dxcc|hourOfDay". */
export function recordEntities(db: Db, hits: Map<string, EntityHit>): void {
  if (!hits.size) return;
  db.transaction((tx) => {
    for (const [k, h] of hits) {
      const [band, mode, dxcc, hour] = k.split("|");
      const day = Math.floor(h.lastAt / 86_400_000);
      tx.run(sql`
        INSERT INTO heard_entities (dxcc, band, mode, hour_of_day, decodes, days, last_day, best_snr, first_at, last_at, last_call)
        VALUES (${Number(dxcc)}, ${band}, ${mode}, ${Number(hour)}, ${h.decodes}, 1, ${day}, ${h.bestSnr}, ${h.lastAt}, ${h.lastAt}, ${h.lastCall})
        ON CONFLICT (dxcc, band, mode, hour_of_day) DO UPDATE SET
          decodes = decodes + excluded.decodes,
          days = days + (CASE WHEN last_day = excluded.last_day THEN 0 ELSE 1 END),
          last_day = MAX(last_day, excluded.last_day),
          best_snr = MAX(COALESCE(best_snr, -99), COALESCE(excluded.best_snr, -99)),
          last_at = MAX(last_at, excluded.last_at),
          last_call = CASE WHEN excluded.last_at >= last_at THEN excluded.last_call ELSE last_call END
      `);
    }
  });
}

/** Fill the table once from the decodes already stored (14 days, plus logged contacts). */
export function backfillEntities(db: Db): number {
  const have = db.get<{ n: number }>(sql`SELECT COUNT(*) AS n FROM heard_entities`)?.n ?? 0;
  if (have > 0) return 0;
  const rows = db.all<{ at: number; band: string; mode: string; callsign: string; snr: number }>(
    sql`SELECT at, band, mode, callsign, snr FROM decodes WHERE callsign IS NOT NULL AND mode IN ('FT8', 'FT4', 'FT2') ORDER BY at`,
  );
  // One call per UTC day at a time: days are counted, so feed day by day.
  const byDay = new Map<number, Map<string, EntityHit>>();
  const dx = getDxcc();
  for (const r of rows) {
    const e = dx.resolve(r.callsign);
    if (!e) continue;
    const day = Math.floor(r.at / 86_400_000);
    const k = `${r.band}|${r.mode}|${e.adif}|${new Date(r.at).getUTCHours()}`;
    let m = byDay.get(day);
    if (!m) byDay.set(day, (m = new Map()));
    const h = m.get(k) ?? { decodes: 0, bestSnr: null, lastAt: 0, lastCall: r.callsign };
    h.decodes++;
    h.bestSnr = h.bestSnr === null ? r.snr : Math.max(h.bestSnr, r.snr);
    if (r.at >= h.lastAt) {
      h.lastAt = r.at;
      h.lastCall = r.callsign;
    }
    m.set(k, h);
  }
  for (const m of byDay.values()) recordEntities(db, m);
  return rows.length;
}

export interface HeardNeverWorked {
  dxcc: number;
  name: string;
  /** The band and hour it is heard best (most days), with its numbers. */
  best: { band: string; mode: string; hourOfDay: number; days: number; decodes: number; bestSnr: number | null };
  /** Every band it has been heard on. */
  bands: string[];
  totalDecodes: number;
  lastAt: number;
  lastCall: string | null;
}

/**
 * DXCC entities heard here and never worked, best first: most days heard at their best
 * band and hour, then the most recent. Deleted entities are left out.
 */
export function heardNeverWorked(db: Db, stationId: string, opts: { limit?: number } = {}): HeardNeverWorked[] {
  const rows = db.all<{ dxcc: number; band: string; mode: string; hour_of_day: number; decodes: number; days: number; best_snr: number | null; last_at: number; last_call: string | null }>(sql`
    SELECT h.* FROM heard_entities h
    WHERE h.dxcc NOT IN (SELECT DISTINCT dxcc FROM qsos WHERE station_id = ${stationId} AND dxcc IS NOT NULL)
  `);
  const dx = getDxcc();
  const by = new Map<number, typeof rows>();
  for (const r of rows) by.set(r.dxcc, [...(by.get(r.dxcc) ?? []), r]);
  const out: HeardNeverWorked[] = [];
  for (const [dxcc, rs] of by) {
    const ent = dx.entity(dxcc);
    if (!ent) continue; // not in the current country file: a deleted entity
    const best = [...rs].sort((a, b) => b.days - a.days || b.decodes - a.decodes)[0]!;
    const last = [...rs].sort((a, b) => b.last_at - a.last_at)[0]!;
    out.push({
      dxcc,
      name: ent.name,
      best: { band: best.band, mode: best.mode, hourOfDay: best.hour_of_day, days: best.days, decodes: best.decodes, bestSnr: best.best_snr },
      bands: [...new Set(rs.map((r) => r.band))],
      totalDecodes: rs.reduce((a, r) => a + r.decodes, 0),
      lastAt: last.last_at,
      lastCall: last.last_call,
    });
  }
  out.sort((a, b) => b.best.days - a.best.days || b.lastAt - a.lastAt);
  return opts.limit ? out.slice(0, opts.limit) : out;
}
