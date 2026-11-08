/**
 * Records each automatic run: when it started and stopped and why, the modes and bands it
 * used, the contacts it made, what was new, and every fault. Written as it happens, so a
 * crash still leaves an honest record.
 */
import { and, desc, eq, gte, isNull, lte } from "drizzle-orm";

import type { Db } from "@zerobeat/core/db/client";
import { runs, type Run } from "@zerobeat/core/db/schema";
import { newId } from "@zerobeat/core/util/id";

export interface NewOne {
  kind: "dxcc" | "band" | "zone" | "continent" | "park" | "grid" | "state";
  label: string;
  callsign: string;
}

export class RunRecorder {
  private current: string | null = null;

  constructor(private readonly db: Db) {
    // A run left open by a crash or restart is closed honestly.
    this.db.update(runs).set({ endedAt: Date.now(), stopReason: "engine stopped" }).where(isNull(runs.endedAt)).run();
  }

  get active(): string | null {
    return this.current;
  }

  private row(): Run | undefined {
    return this.current ? this.db.select().from(runs).where(eq(runs.id, this.current)).get() : undefined;
  }

  private patch(p: Partial<Run>): void {
    if (this.current) this.db.update(runs).set(p).where(eq(runs.id, this.current)).run();
  }

  start(mode: string, by: string, band: string | null, startedAt = Date.now(), stationId: string | null = null): void {
    if (this.current) return this.mode(mode, band);
    this.current = newId();
    this.db
      .insert(runs)
      .values({ id: this.current, startedAt, startedBy: by, stationId, modes: JSON.stringify([mode]), bands: JSON.stringify(band ? [band] : []) })
      .run();
  }

  /**
   * Carries on the run a restart interrupted: the run that started at startedAt and was
   * closed only because the engine stopped is opened again, so its contacts keep counting.
   * Pieces of the same run split by earlier restarts are folded into it. Returns the run's
   * contacts so far, or null when there is nothing to carry on (a new run starts instead).
   */
  resume(startedAt: number, mode: string, band: string | null): number | null {
    if (this.current) return null;
    const parts = this.db
      .select()
      .from(runs)
      // Within a couple of seconds: runs before this fix took their own reading of the clock.
      .where(and(gte(runs.startedAt, startedAt - 2000), lte(runs.startedAt, startedAt + 2000), eq(runs.stopReason, "engine stopped")))
      .all()
      .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
    const keep = parts[0];
    if (!keep) return null;
    const union = (key: "modes" | "bands") => {
      const out: string[] = [];
      for (const p of parts) for (const v of JSON.parse(p[key]) as string[]) if (out.at(-1) !== v && (key === "modes" || !out.includes(v))) out.push(v);
      return JSON.stringify(out);
    };
    const merged = {
      endedAt: null,
      stopReason: null,
      modes: union("modes"),
      bands: union("bands"),
      qsos: parts.reduce((n, p) => n + p.qsos, 0),
      newOnes: JSON.stringify(parts.flatMap((p) => JSON.parse(p.newOnes) as NewOne[]).slice(-200)),
      transmissions: parts.reduce((n, p) => n + p.transmissions, 0),
      txSeconds: parts.reduce((n, p) => n + p.txSeconds, 0),
      faults: JSON.stringify(parts.flatMap((p) => JSON.parse(p.faults) as { at: number; reason: string }[]).slice(-50)),
    };
    this.db.transaction((tx) => {
      tx.update(runs).set(merged).where(eq(runs.id, keep.id)).run();
      for (const p of parts.slice(1)) tx.delete(runs).where(eq(runs.id, p.id)).run();
    });
    this.current = keep.id;
    this.mode(mode, band);
    return merged.qsos;
  }

  mode(mode: string, band: string | null): void {
    const r = this.row();
    if (!r) return;
    const modes = JSON.parse(r.modes) as string[];
    if (modes.at(-1) !== mode) modes.push(mode);
    this.patch({ modes: JSON.stringify(modes) });
    if (band) this.band(band);
  }

  band(band: string): void {
    const r = this.row();
    if (!r) return;
    const bands = JSON.parse(r.bands) as string[];
    if (!bands.includes(band)) {
      bands.push(band);
      this.patch({ bands: JSON.stringify(bands) });
    }
  }

  qso(band: string, newOnes: NewOne[]): void {
    const r = this.row();
    if (!r) return;
    const all = [...(JSON.parse(r.newOnes) as NewOne[]), ...newOnes].slice(-200);
    this.patch({ qsos: r.qsos + 1, newOnes: JSON.stringify(all) });
    this.band(band);
  }

  transmission(seconds: number): void {
    const r = this.row();
    if (r) this.patch({ transmissions: r.transmissions + 1, txSeconds: r.txSeconds + Math.round(seconds) });
  }

  fault(reason: string, at = Date.now()): void {
    const r = this.row();
    if (!r) return;
    const faults = [...(JSON.parse(r.faults) as { at: number; reason: string }[]), { at, reason }].slice(-50);
    this.patch({ faults: JSON.stringify(faults) });
  }

  stop(reason: string, at = Date.now()): void {
    if (!this.current) return;
    this.patch({ endedAt: at, stopReason: reason });
    this.current = null;
  }
}

/** Runs since `since`, newest first: one station's, or every station's. */
export function recentRuns(db: Db, since = 0, limit = 50, stationId?: string): Run[] {
  return db.select().from(runs).where(and(gte(runs.startedAt, since), stationId ? eq(runs.stationId, stationId) : undefined)).orderBy(desc(runs.startedAt)).limit(limit).all();
}
