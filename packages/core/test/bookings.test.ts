import { describe, expect, it } from "vitest";

import { bookedOut, bookingAt, cancelBooking, createBooking, decideBooking, HEADS_UP_MS, listBookings, nextBooking, type Booking } from "../src/radio/bookings.ts";
import { testDb } from "./testdb.ts";

const H = 3_600_000;
const NOW = Date.UTC(2026, 10, 7, 12, 0);

function setup() {
  const { db, sqlite } = testDb();
  const add = sqlite.prepare("INSERT INTO users (id,email,name,callsign,password_hash,role,active,created_at,updated_at) VALUES (?,?,?,?,'x',?,1,0,0)");
  add.run("u1", "m@x", "Michael", "W9ML", "ADMIN");
  add.run("u2", "t@x", "Tav", "KD9NSC", "OPERATOR");
  add.run("u3", "v@x", "Viewer", null, "VIEWER");
  return db;
}

const ok = (r: Booking | { error: string }): Booking => {
  if ("error" in r) throw new Error(r.error);
  return r;
};

describe("radio bookings", () => {
  it("books whole minutes, and refuses overlaps, the past, too long and viewers", () => {
    const db = setup();
    const b = ok(createBooking(db, "u1", NOW + H + 30_123, NOW + 3 * H, "40m Hell net", NOW));
    expect(b).toMatchObject({ userId: "u1", callsign: "W9ML", startsAt: NOW + H, endsAt: NOW + 3 * H, note: "40m Hell net" });
    expect(createBooking(db, "u2", NOW + 2 * H, NOW + 4 * H, "", NOW)).toEqual({ error: "W9ML has the radio booked then (13:00–15:00Z)" });
    expect(createBooking(db, "u2", NOW - 2 * H, NOW - H, "", NOW)).toEqual({ error: "that time has already gone" });
    expect(createBooking(db, "u2", NOW + 4 * H, NOW + 13 * H, "", NOW)).toMatchObject({ error: expect.stringContaining("at most 8 hours") });
    expect(createBooking(db, "u2", NOW + 4 * H, NOW + 4 * H + 5 * 60_000, "", NOW)).toMatchObject({ error: expect.stringContaining("at least 15") });
    expect(createBooking(db, "u3", NOW + 4 * H, NOW + 5 * H, "", NOW)).toMatchObject({ error: expect.stringContaining("viewer") });
    // Back to back is fine.
    ok(createBooking(db, "u2", NOW + 3 * H, NOW + 4 * H, "", NOW));
    expect(listBookings(db, NOW, NOW + 24 * H).map((x) => x.callsign)).toEqual(["W9ML", "KD9NSC"]);
    expect(bookingAt(db, NOW + 3 * H)?.callsign).toBe("KD9NSC");
    expect(bookingAt(db, NOW + 3 * H - 1)?.callsign).toBe("W9ML");
    expect(nextBooking(db, NOW)?.callsign).toBe("W9ML");
  });

  it("cancels your own; an admin cancels anyone's; one already on ends now", () => {
    const db = setup();
    const a = ok(createBooking(db, "u2", NOW + H, NOW + 2 * H, "", NOW));
    expect(cancelBooking(db, a.id, "u3", false, NOW)).toBe("that is someone else's booking");
    expect(cancelBooking(db, a.id, "u1", true, NOW)).toBeNull();
    expect(listBookings(db, NOW, NOW + 24 * H)).toEqual([]);
    const b = ok(createBooking(db, "u2", NOW, NOW + 2 * H, "", NOW));
    expect(cancelBooking(db, b.id, "u2", false, NOW + 30 * 60_000 + 10)).toBeNull();
    expect(bookingAt(db, NOW + 10 * 60_000)?.endsAt).toBe(NOW + 31 * 60_000);
    expect(bookingAt(db, NOW + 40 * 60_000)).toBeNull();
  });

  it("holds the radio only while its operator is signed in, and warns the one on it first", () => {
    const db = setup();
    const b = ok(createBooking(db, "u2", NOW + H, NOW + 2 * H, "", NOW));
    const here = new Set(["u2"]);
    const present = (u: string) => here.has(u);
    // Five minutes before: Michael has the radio and hears about it, once.
    const before = { now: NOW + H - HEADS_UP_MS, holderId: "u1", current: null, next: b, present, warned: null };
    expect(decideBooking(before)).toMatchObject({ holding: null, handTo: null, headsUp: { id: b.id } });
    expect(decideBooking({ ...before, warned: b.id }).headsUp).toBeNull();
    expect(decideBooking({ ...before, now: NOW + H - HEADS_UP_MS - 60_000 }).headsUp).toBeNull();
    // On: handed to Tav, and nobody else can have it.
    const on = { now: NOW + H, holderId: "u1", current: b, next: null, present, warned: b.id };
    const d = decideBooking(on);
    expect(d.handTo).toBe("u2");
    expect(bookedOut(d.holding, "u1")).toBe("KD9NSC has the radio booked until 14:00Z");
    expect(bookedOut(d.holding, "u2")).toBeNull();
    expect(decideBooking({ ...on, holderId: "u2" }).handTo).toBeNull();
    // Tav not signed in: the booking does not hold the radio.
    here.clear();
    expect(decideBooking(on)).toMatchObject({ holding: null, handTo: null });
    expect(decideBooking(before).headsUp).toBeNull();
  });
});
