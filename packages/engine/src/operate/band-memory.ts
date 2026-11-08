/**
 * Summarises every decoded window into band_hours: per UTC hour, band, mode and the
 * sender's continent, how many decodes and distinct stations, and the best SNR. Counts
 * accumulate in memory for the current hour and are written every few minutes.
 *
 * Distinct-station counts are kept as a maximum, so a restart mid-hour cannot inflate
 * them; at worst that hour slightly under-counts.
 */
import { sql } from "drizzle-orm";

import type { Db } from "@zerobeat/core/db/client";
import { getDxcc } from "@zerobeat/core/dxcc/cty";
import { recordEntities, type EntityHit } from "@zerobeat/core/log/heard-entities";

interface Acc {
  windows: number;
  decodes: number;
  calls: Set<string>;
  bestSnr: number | null;
}

export class BandMemory {
  private hour = 0;
  private acc = new Map<string, Acc>();
  private flushedWindows = new Map<string, number>();
  private flushedDecodes = new Map<string, number>();
  /** Entities heard since the last flush, by "band|mode|dxcc|hourOfDay". */
  private entities = new Map<string, EntityHit>();

  constructor(private readonly db: Db) {}

  add(start: number, band: string, mode: string, decodes: { sender: string | null; snr: number }[]): void {
    const hour = Math.floor(start / 3_600_000) * 3_600_000;
    if (hour !== this.hour) {
      this.flush();
      this.hour = hour;
      this.acc.clear();
      this.flushedWindows.clear();
      this.flushedDecodes.clear();
    }
    const get = (cont: string) => {
      const k = `${band}|${mode}|${cont}`;
      let a = this.acc.get(k);
      if (!a) {
        a = { windows: 0, decodes: 0, calls: new Set(), bestSnr: null };
        this.acc.set(k, a);
      }
      return a;
    };
    const all = get("*");
    all.windows++;
    const hourOfDay = new Date(start).getUTCHours();
    for (const d of decodes) {
      const dx = d.sender ? getDxcc().resolve(d.sender) : null;
      const cont = dx?.continent ?? "?";
      if (dx && d.sender) {
        const k = `${band}|${mode}|${dx.adif}|${hourOfDay}`;
        const e = this.entities.get(k) ?? { decodes: 0, bestSnr: null, lastAt: 0, lastCall: d.sender };
        e.decodes++;
        e.bestSnr = e.bestSnr === null ? d.snr : Math.max(e.bestSnr, d.snr);
        if (start >= e.lastAt) {
          e.lastAt = start;
          e.lastCall = d.sender;
        }
        this.entities.set(k, e);
      }
      for (const a of [all, get(cont)]) {
        a.decodes++;
        if (d.sender) a.calls.add(d.sender);
        a.bestSnr = a.bestSnr === null ? d.snr : Math.max(a.bestSnr, d.snr);
      }
    }
  }

  flush(): void {
    // Entities flush on their own: a day boundary inside one batch would count once.
    if (this.entities.size) {
      recordEntities(this.db, this.entities);
      this.entities = new Map();
    }
    if (!this.hour || this.acc.size === 0) return;
    const hour = this.hour;
    this.db.transaction((tx) => {
      for (const [k, a] of this.acc) {
        const [band, mode, continent] = k.split("|") as [string, string, string];
        const dw = a.windows - (this.flushedWindows.get(k) ?? 0);
        const dd = a.decodes - (this.flushedDecodes.get(k) ?? 0);
        this.flushedWindows.set(k, a.windows);
        this.flushedDecodes.set(k, a.decodes);
        tx.run(sql`
          INSERT INTO band_hours (hour, band, mode, continent, windows, decodes, stations, best_snr)
          VALUES (${hour}, ${band}, ${mode}, ${continent}, ${dw}, ${dd}, ${a.calls.size}, ${a.bestSnr})
          ON CONFLICT (hour, band, mode, continent) DO UPDATE SET
            windows = windows + excluded.windows,
            decodes = decodes + excluded.decodes,
            stations = MAX(stations, excluded.stations),
            best_snr = MAX(COALESCE(best_snr, -99), COALESCE(excluded.best_snr, -99))
        `);
      }
    });
  }

  /** This UTC hour so far, per band, for one mode: windows decoded, decodes and distinct stations (live, unflushed). */
  current(mode: string, now = Date.now()): Map<string, { windows: number; decodes: number; stations: number }> {
    const out = new Map<string, { windows: number; decodes: number; stations: number }>();
    if (this.hour !== Math.floor(now / 3_600_000) * 3_600_000) return out;
    for (const [k, a] of this.acc) {
      const [band, m, cont] = k.split("|") as [string, string, string];
      if (m === mode && cont === "*" && a.windows > 0) out.set(band, { windows: a.windows, decodes: a.decodes, stations: a.calls.size });
    }
    return out;
  }

  /**
   * For one UTC hour of the day: per band, decodes per window over the last `days` days and from how many monitored
   * hours. Decodes per window compares fairly with a part-hour now; distinct stations per hour would not.
   */
  activityAt(hourOfDay: number, mode: string, days = 30, now = Date.now()): Map<string, { perWindow: number; samples: number }> {
    const since = now - days * 86_400_000;
    const rows = this.db.all<{ band: string; per: number; samples: number }>(sql`
      SELECT band, SUM(decodes) * 1.0 / SUM(windows) AS per, COUNT(*) AS samples
      FROM band_hours
      WHERE continent = '*' AND mode = ${mode} AND hour >= ${since} AND windows >= 4
        AND CAST(strftime('%H', hour / 1000, 'unixepoch') AS INTEGER) = ${hourOfDay}
      GROUP BY band
    `);
    return new Map(rows.map((r) => [r.band, { perWindow: Math.round(r.per * 10) / 10, samples: r.samples }]));
  }

  /**
   * For one UTC hour of the day: per band, how many stations a window usually had over
   * the last `days` days, and from how many monitored hours (Band memory's "*" rows).
   */
  yieldAt(hourOfDay: number, mode: string, days = 30, now = Date.now()): Map<string, { avg: number; samples: number; best: number | null }> {
    const since = now - days * 86_400_000;
    const rows = this.db.all<{ band: string; avg: number; samples: number; best: number | null }>(sql`
      SELECT band, AVG(stations) AS avg, COUNT(*) AS samples, MAX(best_snr) AS best
      FROM band_hours
      WHERE continent = '*' AND mode = ${mode} AND hour >= ${since} AND windows >= 4
        AND CAST(strftime('%H', hour / 1000, 'unixepoch') AS INTEGER) = ${hourOfDay}
      GROUP BY band
    `);
    return new Map(rows.map((r) => [r.band, { avg: Math.round(r.avg * 10) / 10, samples: r.samples, best: r.best }]));
  }
}
