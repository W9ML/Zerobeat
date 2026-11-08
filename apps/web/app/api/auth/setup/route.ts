/** First run: create the first admin and the station. Closes once any user exists. */
import { z } from "zod";

import { hashPassword, passwordProblem } from "@zerobeat/core/auth/password";
import { createSession, SESSION_COOKIE, userCount } from "@zerobeat/core/auth/sessions";
import { stations, users } from "@zerobeat/core/db/schema";
import { isGrid } from "@zerobeat/core/ham/grid";
import { looksLikeCallsign, normaliseCallsign } from "@zerobeat/core/ham/callsign";
import { newId } from "@zerobeat/core/util/id";

import { clientIp, isSecure, json, problem, readJson } from "@/lib/server/auth";
import { db, settingsStore } from "@/lib/server/ctx";

const Body = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.string().trim().toLowerCase().email().max(190),
  callsign: z.string().trim().min(3).max(16),
  grid: z.string().trim().min(4).max(8),
  password: z.string().max(256),
});

export async function POST(req: Request) {
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return problem(403, "cross-site request refused");
  if (userCount(db()) > 0) return problem(409, "setup is already done");
  const parsed = Body.safeParse(await readJson(req));
  if (!parsed.success) return problem(400, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  const b = parsed.data;
  const call = normaliseCallsign(b.callsign);
  if (!looksLikeCallsign(call)) return problem(400, `${call} does not look like a callsign`);
  if (!isGrid(b.grid)) return problem(400, `${b.grid} is not a Maidenhead locator`);
  const pw = passwordProblem(b.password);
  if (pw) return problem(400, pw);
  const id = newId();
  const hash = await hashPassword(b.password);
  const grid = b.grid.slice(0, 2).toUpperCase() + b.grid.slice(2, 4) + b.grid.slice(4).toLowerCase();
  db().transaction((tx) => {
    tx.insert(users).values({ id, email: b.email, name: b.name, callsign: call, passwordHash: hash, role: "ADMIN" }).run();
    tx.insert(stations).values({ id: newId(), callsign: call, grid, name: "Home", isDefault: true, userId: id }).run();
  });
  const { token, expiresAt } = createSession(db(), id, { ip: clientIp(req), userAgent: req.headers.get("user-agent"), sessionDays: settingsStore().get("app.sessionDays") });
  const res = json({ ok: true });
  res.headers.append("set-cookie", `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Expires=${new Date(expiresAt).toUTCString()}${isSecure(req) ? "; Secure" : ""}`);
  return res;
}
