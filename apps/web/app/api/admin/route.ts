/**
 * Admin actions for stations, users and API keys. One route, discriminated by `action`,
 * so every admin write goes through the same authorisation and validation.
 */
import { and, eq, ne } from "drizzle-orm";
import { z } from "zod";

import { hashPassword, passwordProblem } from "@zerobeat/core/auth/password";
import { activeAdminCount, createApiKey, destroyUserSessions } from "@zerobeat/core/auth/sessions";
import { apiKeys, stations, users, qsos } from "@zerobeat/core/db/schema";
import { isGrid } from "@zerobeat/core/ham/grid";
import { looksLikeCallsign, normaliseCallsign } from "@zerobeat/core/ham/callsign";
import { newId } from "@zerobeat/core/util/id";

import { authorize, json, problem, readJson } from "@/lib/server/auth";
import { db } from "@/lib/server/ctx";
import { ensureUserStations, stationForUser } from "@zerobeat/core/log/owners";

const call = z.string().trim().transform(normaliseCallsign).refine(looksLikeCallsign, "not a callsign");
const grid = z.string().trim().refine(isGrid, "not a grid locator");
const role = z.enum(["ADMIN", "OPERATOR", "VIEWER"]);

/** US license class, or "" for none (not checked: a non-US station). */
const license = z.enum(["", "T", "G", "A", "E"]);

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("station.save"), id: z.string().optional(), callsign: call, grid, name: z.string().max(64).optional().nullable(), isDefault: z.boolean().optional() }),
  z.object({ action: z.literal("station.delete"), id: z.string() }),
  z.object({ action: z.literal("user.create"), email: z.string().trim().toLowerCase().email(), name: z.string().trim().min(1).max(100), callsign: z.string().trim().max(16).optional().nullable(), role, password: z.string(), licenseClass: license.optional() }),
  z.object({ action: z.literal("user.update"), id: z.string(), role: role.optional(), active: z.boolean().optional(), name: z.string().trim().min(1).max(100).optional(), password: z.string().optional(), licenseClass: license.optional(), callsign: z.string().trim().max(16).nullable().optional() }),
  z.object({ action: z.literal("user.delete"), id: z.string() }),
  z.object({ action: z.literal("apikey.create"), name: z.string().trim().min(1).max(80), role: z.enum(["OPERATOR", "VIEWER"]), days: z.number().int().min(0).max(3650).default(0) }),
  z.object({ action: z.literal("apikey.revoke"), id: z.string() }),
]);

export async function POST(req: Request) {
  const who = authorize(req, "ADMIN");
  if (who instanceof Response) return who;
  if (who.kind !== "user") return problem(403, "admin actions need a signed-in user");
  const p = Body.safeParse(await readJson(req));
  if (!p.success) return problem(400, p.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  const b = p.data;
  const d = db();
  const now = Date.now();

  switch (b.action) {
    case "station.save": {
      const g = b.grid.slice(0, 2).toUpperCase() + b.grid.slice(2, 4) + b.grid.slice(4).toLowerCase();
      d.transaction((tx) => {
        if (b.isDefault) tx.update(stations).set({ isDefault: false }).run();
        if (b.id) tx.update(stations).set({ callsign: b.callsign, grid: g, name: b.name ?? null, ...(b.isDefault ? { isDefault: true } : {}), updatedAt: now }).where(eq(stations.id, b.id)).run();
        else tx.insert(stations).values({ id: newId(), callsign: b.callsign, grid: g, name: b.name ?? null, isDefault: !!b.isDefault }).run();
      });
      return json({ ok: true });
    }
    case "station.delete": {
      const used = d.select({ id: qsos.id }).from(qsos).where(eq(qsos.stationId, b.id)).limit(1).get();
      if (used) return problem(409, "contacts were logged from this station; it cannot be deleted");
      d.delete(stations).where(eq(stations.id, b.id)).run();
      return json({ ok: true });
    }
    case "user.create": {
      const pw = passwordProblem(b.password);
      if (pw) return problem(400, pw);
      if (d.select().from(users).where(eq(users.email, b.email)).get()) return problem(409, "a user with that email exists");
      d.insert(users).values({ id: newId(), email: b.email, name: b.name, callsign: b.callsign ? normaliseCallsign(b.callsign) : null, role: b.role, licenseClass: b.licenseClass || null, passwordHash: await hashPassword(b.password) }).run();
      // Their own station (callsign, logbook) from the start.
      ensureUserStations(d);
      return json({ ok: true });
    }
    case "user.update": {
      const u = d.select().from(users).where(eq(users.id, b.id)).get();
      if (!u) return problem(404, "no such user");
      const losingAdmin = u.role === "ADMIN" && ((b.role && b.role !== "ADMIN") || b.active === false);
      if (losingAdmin && activeAdminCount(d, u.id) === 0) return problem(409, "that would leave no active administrator");
      const patch: Partial<typeof users.$inferInsert> = { updatedAt: now };
      if (b.role) patch.role = b.role;
      if (b.active !== undefined) patch.active = b.active;
      if (b.name) patch.name = b.name;
      if (b.licenseClass !== undefined) patch.licenseClass = b.licenseClass || null;
      if (b.callsign !== undefined) {
        patch.callsign = b.callsign ? normaliseCallsign(b.callsign) : null;
        // Their station follows, unless contacts were logged under the old call: those
        // would change with it.
        const st = stationForUser(d, u.id);
        if (st && patch.callsign && patch.callsign !== st.callsign.toUpperCase()) {
          const used = d.select({ id: qsos.id }).from(qsos).where(eq(qsos.stationId, st.id)).limit(1).get();
          if (used) return problem(409, `${st.callsign} has contacts in its logbook; changing the callsign would change them too, so it stays ${st.callsign}`);
          d.update(stations).set({ callsign: patch.callsign, updatedAt: now }).where(eq(stations.id, st.id)).run();
        }
      }
      if (b.password) {
        const pw = passwordProblem(b.password);
        if (pw) return problem(400, pw);
        patch.passwordHash = await hashPassword(b.password);
      }
      d.update(users).set(patch).where(eq(users.id, b.id)).run();
      // A callsign given for the first time brings their station.
      ensureUserStations(d);
      if (b.password || b.active === false || b.role) destroyUserSessions(d, b.id);
      return json({ ok: true });
    }
    case "user.delete": {
      if (b.id === who.id) return problem(409, "you cannot delete yourself");
      const u = d.select().from(users).where(eq(users.id, b.id)).get();
      if (u?.role === "ADMIN" && activeAdminCount(d, u.id) === 0) return problem(409, "that would leave no active administrator");
      // Their logbook stays (an unowned station an admin can see under Stations).
      d.transaction((tx) => {
        tx.update(stations).set({ userId: null, updatedAt: now }).where(eq(stations.userId, b.id)).run();
        tx.delete(users).where(and(eq(users.id, b.id), ne(users.id, who.id))).run();
      });
      return json({ ok: true });
    }
    case "apikey.create": {
      const r = createApiKey(d, { name: b.name, role: b.role, createdById: who.id, expiresAt: b.days ? now + b.days * 86_400_000 : null });
      return json({ ok: true, token: r.token });
    }
    case "apikey.revoke":
      d.update(apiKeys).set({ active: false }).where(eq(apiKeys.id, b.id)).run();
      return json({ ok: true });
  }
}
