/**
 * Whose logbook and settings a page or request is about. Everyone sees their own; an
 * admin can choose another user to look at ("Viewing: CALL", the ds_view cookie), read-only.
 * An API key acts for the user who made it.
 */
import "server-only";

import { cookies } from "next/headers";

import { and, eq } from "drizzle-orm";

import type { AuthUser } from "@zerobeat/core/auth/sessions";
import { qsos, users } from "@zerobeat/core/db/schema";
import { stationForUser } from "@zerobeat/core/log/owners";

import { cookieValue, type Identity } from "./auth";
import { db } from "./ctx";

export const VIEW_COOKIE = "ds_view";

export interface Scope {
  /** The user whose logbook this is. */
  userId: string;
  /** Their station: "" when they have no callsign yet (an empty logbook). */
  stationId: string;
  callsign: string | null;
  grid: string | null;
  /** An admin looking at someone else's: nothing may be changed. */
  readOnly: boolean;
}

function scopeOf(userId: string, readOnly: boolean): Scope {
  const st = stationForUser(db(), userId);
  return { userId, stationId: st?.id ?? "", callsign: st?.callsign ?? null, grid: st?.grid ?? null, readOnly };
}

/** For an admin, the user they chose to view (if that user exists and is not themselves). */
function viewed(me: { id: string; role: string }, chosen: string | null | undefined): string | null {
  if (me.role !== "ADMIN" || !chosen || chosen === me.id) return null;
  return db().select({ id: users.id }).from(users).where(eq(users.id, chosen)).get()?.id ?? null;
}

/** A page's scope: the signed-in user's own, or the user an admin is viewing. */
export async function pageScope(user: AuthUser): Promise<Scope> {
  const other = viewed(user, (await cookies()).get(VIEW_COOKIE)?.value);
  return other ? scopeOf(other, true) : scopeOf(user.id, false);
}

/** A request's scope (route handlers). An API key acts for its maker. */
export function requestScope(req: Request, who: Identity): Scope {
  if (who.kind === "apikey") return scopeOf(who.ownerId ?? "", false);
  const other = viewed(who, cookieValue(req, VIEW_COOKIE));
  return other ? scopeOf(other, true) : scopeOf(who.id, false);
}

/** The signed-in user's own scope, whatever they are viewing (for writes). */
export function ownScope(who: Identity): Scope {
  return scopeOf(who.kind === "apikey" ? (who.ownerId ?? "") : who.id, false);
}

/** Is this contact in the scope's logbook? */
export function ownsQso(scope: Scope, qsoId: string): boolean {
  if (!scope.stationId) return false;
  return !!db().select({ id: qsos.id }).from(qsos).where(and(eq(qsos.id, qsoId), eq(qsos.stationId, scope.stationId))).get();
}

/** Why the user cannot add to their logbook (no callsign yet), or null. */
export function cannotLog(scope: Scope): string | null {
  return scope.stationId ? null : "your account has no callsign yet: an admin sets it under Settings → Users";
}
