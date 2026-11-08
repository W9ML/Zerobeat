/**
 * Who operated: a row per person per station, linked to their user account, so each
 * contact can say who made it (ADIF OPERATOR, Cabrillo OPERATORS, the log's operator
 * column) in a club or multi-operator station.
 */
import { and, eq } from "drizzle-orm";

import type { Db } from "../db/client.ts";
import { operators, users } from "../db/schema.ts";
import { newId } from "../util/id.ts";

/** The operator row for this user at this station, created (or its call refreshed) as needed. */
export function operatorForUser(db: Db, stationId: string, userId: string, stationCallsign: string): string | null {
  const u = db.select({ id: users.id, name: users.name, callsign: users.callsign }).from(users).where(eq(users.id, userId)).get();
  if (!u) return null;
  const call = (u.callsign || stationCallsign).toUpperCase();
  const row = db.select().from(operators).where(and(eq(operators.stationId, stationId), eq(operators.userId, userId))).get();
  if (row) {
    if (row.callsign !== call || row.name !== u.name) db.update(operators).set({ callsign: call, name: u.name }).where(eq(operators.id, row.id)).run();
    return row.id;
  }
  const id = newId();
  db.insert(operators).values({ id, stationId, userId, name: u.name, callsign: call }).run();
  return id;
}

/** Operator id → callsign, for exports. */
export function operatorCalls(db: Db): Map<string, string> {
  return new Map(db.select({ id: operators.id, callsign: operators.callsign }).from(operators).all().map((o) => [o.id, o.callsign]));
}
