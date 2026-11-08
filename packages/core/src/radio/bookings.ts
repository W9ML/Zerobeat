/**
 * Radio time: operators book stretches of time on the shack's one radio, and everyone can
 * see who has booked when.
 *
 * The rule while a booking is on:
 * - If its operator is signed in (Zerobeat open somewhere, or within the last
 *   PRESENT_GRACE_MS), the radio is theirs. It is handed to them when the booking starts
 *   (or when they open Zerobeat during it), whoever had it is warned HEADS_UP_MS before,
 *   and nobody else can take it or ask for it until the booking ends.
 * - If they are not signed in, the booking does not hold the radio: it is used as on any
 *   other day, the first one to want it gets it. It holds again as soon as they come back.
 *
 * Bookings are whole minutes, BOOKING_MIN_MS to BOOKING_MAX_MS long, no further ahead than
 * BOOKING_AHEAD_MS, and never overlap. An operator can cancel their own (a booking already
 * on is ended there and then, so the history stays); an admin can cancel anyone's.
 */
import { randomUUID } from "node:crypto";

import { and, asc, eq, gt, lt } from "drizzle-orm";

import type { Db } from "../db/client.ts";
import { radioBookings, users } from "../db/schema.ts";

export const BOOKING_MIN_MS = 15 * 60_000;
export const BOOKING_MAX_MS = 8 * 3_600_000;
export const BOOKING_AHEAD_MS = 30 * 86_400_000;
/** Upcoming bookings one operator may hold at once. */
export const BOOKINGS_PER_USER = 10;
/** How long after the last open Zerobeat page closed an operator still counts as signed in. */
export const PRESENT_GRACE_MS = 10 * 60_000;
/** How long before a booking the operator who has the radio is told it is going. */
export const HEADS_UP_MS = 5 * 60_000;

export interface Booking {
  id: string;
  userId: string;
  name: string;
  callsign: string | null;
  startsAt: number;
  endsAt: number;
  note: string;
}

function select(db: Db) {
  return db
    .select({ id: radioBookings.id, userId: radioBookings.userId, name: users.name, callsign: users.callsign, startsAt: radioBookings.startsAt, endsAt: radioBookings.endsAt, note: radioBookings.note })
    .from(radioBookings)
    .innerJoin(users, eq(users.id, radioBookings.userId));
}

/** Bookings that overlap [from, to), earliest first. */
export function listBookings(db: Db, from: number, to: number): Booking[] {
  return select(db)
    .where(and(lt(radioBookings.startsAt, to), gt(radioBookings.endsAt, from)))
    .orderBy(asc(radioBookings.startsAt))
    .all();
}

/** The booking on at `t`, if any. */
export function bookingAt(db: Db, t: number): Booking | null {
  return listBookings(db, t, t + 1)[0] ?? null;
}

/** The next booking to start after `t`. */
export function nextBooking(db: Db, t: number): Booking | null {
  return select(db).where(gt(radioBookings.startsAt, t)).orderBy(asc(radioBookings.startsAt)).limit(1).get() ?? null;
}

/** Book [startsAt, endsAt) for a user. Returns the booking, or why not. */
export function createBooking(db: Db, userId: string, startsAt: number, endsAt: number, note = "", now = Date.now()): Booking | { error: string } {
  if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt)) return { error: "give a start and an end" };
  // Whole minutes; a start in the minute just gone counts as now.
  const start = Math.floor(startsAt / 60_000) * 60_000;
  const end = Math.floor(endsAt / 60_000) * 60_000;
  if (end <= start) return { error: "the end has to be after the start" };
  if (end - start < BOOKING_MIN_MS) return { error: `book at least ${BOOKING_MIN_MS / 60_000} minutes` };
  if (end - start > BOOKING_MAX_MS) return { error: `book at most ${BOOKING_MAX_MS / 3_600_000} hours at a time` };
  if (start < Math.floor(now / 60_000) * 60_000 - 60_000) return { error: "that time has already gone" };
  if (start > now + BOOKING_AHEAD_MS) return { error: `book at most ${BOOKING_AHEAD_MS / 86_400_000} days ahead` };
  const u = db.select({ active: users.active, role: users.role }).from(users).where(eq(users.id, userId)).get();
  if (!u || !u.active) return { error: "no such user" };
  if (u.role === "VIEWER") return { error: "a viewer cannot operate, so cannot book the radio" };
  const clash = listBookings(db, start, end)[0];
  if (clash) return { error: `${clash.callsign ?? clash.name} has the radio booked then (${new Date(clash.startsAt).toISOString().slice(11, 16)}–${new Date(clash.endsAt).toISOString().slice(11, 16)}Z)` };
  const mine = select(db)
    .where(and(eq(radioBookings.userId, userId), gt(radioBookings.endsAt, now)))
    .all().length;
  if (mine >= BOOKINGS_PER_USER) return { error: `you already have ${BOOKINGS_PER_USER} bookings coming up` };
  const id = randomUUID();
  db.insert(radioBookings).values({ id, userId, startsAt: start, endsAt: end, note: note.trim().slice(0, 120) }).run();
  return select(db).where(eq(radioBookings.id, id)).get()!;
}

/**
 * Cancel a booking: the operator's own, or anyone's for an admin. One already on is ended
 * now rather than removed, so it still shows who had the radio; one that is over stays.
 */
export function cancelBooking(db: Db, id: string, byUserId: string, admin: boolean, now = Date.now()): string | null {
  const b = db.select().from(radioBookings).where(eq(radioBookings.id, id)).get();
  if (!b) return "no such booking";
  if (b.userId !== byUserId && !admin) return "that is someone else's booking";
  if (b.endsAt <= now) return "that booking is already over";
  if (b.startsAt <= now) {
    // At least a minute long, so it is not left as an empty stretch.
    db.update(radioBookings)
      .set({ endsAt: Math.max(b.startsAt + 60_000, Math.ceil(now / 60_000) * 60_000) })
      .where(eq(radioBookings.id, id))
      .run();
  } else db.delete(radioBookings).where(eq(radioBookings.id, id)).run();
  return null;
}

export interface BookingDecision {
  /** The booking holding the radio now (its operator is signed in), if any. */
  holding: Booking | null;
  /** Hand the radio to this user now. */
  handTo: string | null;
  /** Tell the operator who has the radio that this booking is about to take it. */
  headsUp: Booking | null;
}

/**
 * What the radio should do now. `present(userId)` says whether someone is signed in;
 * `warned` is the id of the booking already announced, so the heads-up goes once.
 */
export function decideBooking(o: { now: number; holderId: string | null; current: Booking | null; next: Booking | null; present: (userId: string) => boolean; warned: string | null }): BookingDecision {
  const holding = o.current && o.present(o.current.userId) ? o.current : null;
  const handTo = holding && o.holderId !== holding.userId ? holding.userId : null;
  const n = o.next;
  const headsUp = n && n.startsAt - o.now <= HEADS_UP_MS && o.warned !== n.id && o.holderId && o.holderId !== n.userId && o.present(n.userId) ? n : null;
  return { holding, handTo, headsUp };
}

/** Why someone other than the booking's operator cannot have the radio now, or null. */
export function bookedOut(holding: Booking | null, userId: string): string | null {
  if (!holding || holding.userId === userId) return null;
  return `${holding.callsign ?? holding.name} has the radio booked until ${new Date(holding.endsAt).toISOString().slice(11, 16)}Z`;
}
