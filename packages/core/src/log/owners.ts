/**
 * Each user is their own station: their callsign on the air, their logbook, their personal
 * settings and state. This keeps every user with a callsign owning one station, and once
 * moves what used to be shared (the one station's settings and state) to the user whose
 * station it was.
 */
import { and, asc, eq, isNull, sql } from "drizzle-orm";

import type { Db } from "../db/client.ts";
import { engineState, runs, settings, stations, userSettings, users, type Station } from "../db/schema.ts";
import { isPersonal } from "../settings/registry.ts";
import { EngineState, PERSONAL_STATE, userStateKey } from "../state/engine-state.ts";
import { newId } from "../util/id.ts";
import { defaultStation } from "./qsos.ts";

/** The station a user operates as, or null (no callsign yet). */
export function stationForUser(db: Db, userId: string): Station | null {
  return db.select().from(stations).where(eq(stations.userId, userId)).get() ?? null;
}

/** The user whose station this is. */
export function ownerOfStation(db: Db, stationId: string): string | null {
  return db.select({ u: stations.userId }).from(stations).where(eq(stations.id, stationId)).get()?.u ?? null;
}

/**
 * Give every user with a callsign a station: an unowned one with their callsign, or a new
 * one at the shack's grid. Returns how many were claimed or made.
 */
export function ensureUserStations(db: Db): number {
  let n = 0;
  const shackGrid = defaultStation(db)?.grid ?? "AA00";
  const people = db.select().from(users).orderBy(asc(users.createdAt)).all();
  for (const u of people) {
    const call = u.callsign?.trim().toUpperCase();
    if (!call || stationForUser(db, u.id)) continue;
    const free = db
      .select()
      .from(stations)
      .where(and(isNull(stations.userId), sql`upper(${stations.callsign}) = ${call}`))
      .orderBy(asc(stations.createdAt))
      .get();
    if (free) db.update(stations).set({ userId: u.id, updatedAt: Date.now() }).where(eq(stations.id, free.id)).run();
    else db.insert(stations).values({ id: newId(), callsign: call, grid: shackGrid, name: u.name, isDefault: false, userId: u.id }).run();
    n++;
  }
  return n;
}

/**
 * Once: the settings and engine state that were the one station's become its owner's own
 * (their QRZ, LoTW and the rest, their contest and keys), and runs so far are theirs.
 */
export function splitSharedStation(db: Db): { owner: string | null; settings: number; state: number } {
  const state = new EngineState(db);
  if (state.get("usersSplitAt")) return { owner: null, settings: 0, state: 0 };
  ensureUserStations(db);
  const home = defaultStation(db);
  const owner = home?.userId ?? null;
  let movedSettings = 0;
  let movedState = 0;
  if (owner && home) {
    db.transaction((tx) => {
      for (const row of tx.select().from(settings).all()) {
        if (!isPersonal(row.key)) continue;
        tx.insert(userSettings).values({ userId: owner, key: row.key, value: row.value, encrypted: row.encrypted, updatedAt: row.updatedAt }).onConflictDoNothing().run();
        tx.delete(settings).where(eq(settings.key, row.key)).run();
        movedSettings++;
      }
      for (const key of PERSONAL_STATE) {
        const row = tx.select().from(engineState).where(eq(engineState.key, key)).get();
        if (!row) continue;
        tx.insert(engineState).values({ key: userStateKey(owner, key), value: row.value, updatedAt: row.updatedAt }).onConflictDoNothing().run();
        tx.delete(engineState).where(eq(engineState.key, key)).run();
        movedState++;
      }
      tx.update(runs).set({ stationId: home.id }).where(isNull(runs.stationId)).run();
    });
  }
  state.set("usersSplitAt", Date.now());
  return { owner, settings: movedSettings, state: movedState };
}

/** Every user who can operate: active, with a station. Jobs run once for each. */
export function accounts(db: Db): { userId: string; stationId: string; callsign: string; grid: string }[] {
  return db
    .select({ userId: users.id, stationId: stations.id, callsign: stations.callsign, grid: stations.grid })
    .from(stations)
    .innerJoin(users, eq(users.id, stations.userId))
    .where(eq(users.active, true))
    .orderBy(asc(users.createdAt))
    .all();
}
