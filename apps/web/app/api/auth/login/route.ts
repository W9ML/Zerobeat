import { login, SESSION_COOKIE } from "@zerobeat/core/auth/sessions";

import { clientIp, isSecure, json, problem, readJson } from "@/lib/server/auth";
import { db, settingsStore } from "@/lib/server/ctx";

export async function POST(req: Request) {
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return problem(403, "cross-site request refused");
  const body = await readJson<{ identifier?: string; password?: string }>(req);
  if (!body?.identifier || !body.password) return problem(400, "enter your email or callsign and password");
  const r = await login(db(), {
    identifier: String(body.identifier).slice(0, 200),
    password: String(body.password).slice(0, 256),
    ip: clientIp(req),
    userAgent: req.headers.get("user-agent"),
    sessionDays: settingsStore().get("app.sessionDays"),
  });
  if (!r.ok) {
    if (r.reason === "locked") return problem(429, `too many attempts; try again in ${Math.ceil((r.retryAfterMs ?? 0) / 60_000)} min`);
    return problem(401, "that email/callsign and password do not match");
  }
  const res = json({ ok: true });
  const secure = isSecure(req);
  res.headers.append(
    "set-cookie",
    `${SESSION_COOKIE}=${r.token}; Path=/; HttpOnly; SameSite=Lax; Expires=${new Date(r.expiresAt).toUTCString()}${secure ? "; Secure" : ""}`,
  );
  return res;
}
