/**
 * Radio time (@zerobeat/core/radio/bookings).
 * GET ?from=&to= (ms): the bookings in that stretch, everyone's.
 * POST { startsAt, endsAt, note }: book the radio for yourself.
 * DELETE ?id=: cancel your own booking (an admin, anyone's); one already on ends now.
 * The engine reads the bookings itself every 15 seconds.
 */
import { cancelBooking, createBooking, listBookings } from "@zerobeat/core/radio/bookings";

import { authorize, json, problem, readJson } from "@/lib/server/auth";
import { db } from "@/lib/server/ctx";

const DAY = 86_400_000;

export async function GET(req: Request) {
  const who = authorize(req, "VIEWER");
  if (who instanceof Response) return who;
  const u = new URL(req.url);
  const now = Date.now();
  const from = Number(u.searchParams.get("from") ?? now - DAY);
  const to = Number(u.searchParams.get("to") ?? now + 14 * DAY);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > 62 * DAY) return problem(400, "give ?from= and ?to= in ms, at most 62 days apart");
  return json({ bookings: listBookings(db(), from, to), me: who.kind === "user" ? who.id : null, admin: who.role === "ADMIN" });
}

export async function POST(req: Request) {
  const who = authorize(req, "OPERATOR");
  if (who instanceof Response) return who;
  if (who.kind !== "user") return problem(403, "sign in to book the radio");
  const b = ((await readJson(req)) ?? {}) as { startsAt?: unknown; endsAt?: unknown; note?: unknown };
  const r = createBooking(db(), who.id, Number(b.startsAt), Number(b.endsAt), typeof b.note === "string" ? b.note : "");
  if ("error" in r) return problem(409, r.error);
  return json({ booking: r });
}

export async function DELETE(req: Request) {
  const who = authorize(req, "OPERATOR");
  if (who instanceof Response) return who;
  if (who.kind !== "user") return problem(403, "sign in to cancel a booking");
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return problem(400, "give ?id=");
  const err = cancelBooking(db(), id, who.id, who.role === "ADMIN");
  if (err) return problem(409, err);
  return json({ ok: true });
}
