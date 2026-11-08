/** Public API: list and create contacts with an API key. Same validation as the web form. */
import { roleAtLeast } from "@zerobeat/core/auth/sessions";
import { createQso, enabledUploadServices, searchQsos } from "@zerobeat/core/log/qsos";

import { authorize, json, problem, readJson } from "@/lib/server/auth";
import { db, settingsStore } from "@/lib/server/ctx";
import { engineQsoLogged } from "@/lib/server/engine";
import { QsoBody } from "@/lib/server/qso-input";
import { cannotLog, ownScope } from "@/lib/server/scope";

/** What a list returns by default: the contact, not the person (no name, QTH, email, notes, extras or transcript). */
const PUBLIC_FIELDS = [
  "id", "callsign", "band", "mode", "submode", "freqHz", "startTime", "endTime", "rstSent", "rstRcvd", "grid", "state", "dxcc", "continent", "cqZone", "sigInfo",
  "lotwRcvd", "qslRcvd", "qrzRcvd", "eqslRcvd",
] as const;

export async function GET(req: Request) {
  const who = authorize(req, "VIEWER", { apiKey: true });
  if (who instanceof Response) return who;
  const u = new URL(req.url);
  const n = (k: string, int = false) => {
    const v = Number(u.searchParams.get(k) || NaN);
    return Number.isFinite(v) ? (int ? Math.trunc(v) : v) : undefined;
  };
  const r = searchQsos(db(), {
    stationId: ownScope(who).stationId,
    callsign: u.searchParams.get("callsign") ?? undefined,
    band: u.searchParams.get("band") ?? undefined,
    mode: u.searchParams.get("mode") ?? undefined,
    from: n("since"),
    page: n("page", true),
    pageSize: n("pageSize", true),
  });
  // The personal fields leave only on request, and only for someone who may operate.
  const full = u.searchParams.get("full") === "1" && roleAtLeast(who.role, "OPERATOR");
  if (full) return json({ ...r, full });
  return json({ ...r, rows: r.rows.map((row) => Object.fromEntries(PUBLIC_FIELDS.map((k) => [k, row[k]]))), full });
}

export async function POST(req: Request) {
  const who = authorize(req, "OPERATOR", { apiKey: true });
  if (who instanceof Response) return who;
  const p = QsoBody.safeParse(await readJson(req));
  if (!p.success) return problem(400, p.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  // An API key logs into the logbook of the user who made it.
  const scope = ownScope(who);
  const no = cannotLog(scope);
  if (no) return problem(409, no);
  const r = createQso(db(), { ...p.data, stationId: scope.stationId }, { uploadServices: enabledUploadServices(settingsStore().snapshot(scope.userId)) });
  if (r.created) engineQsoLogged(r.qso.id);
  return json(r, r.created ? 201 : 200);
}
