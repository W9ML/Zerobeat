import { operatorForUser } from "@zerobeat/core/log/operators";
import { createQso, enabledUploadServices, searchQsos } from "@zerobeat/core/log/qsos";

import { authorize, json, problem, readJson } from "@/lib/server/auth";
import { db, settingsStore } from "@/lib/server/ctx";
import { engineQsoLogged } from "@/lib/server/engine";
import { QsoBody } from "@/lib/server/qso-input";
import { cannotLog, ownScope, requestScope } from "@/lib/server/scope";

export async function GET(req: Request) {
  const who = authorize(req, "VIEWER");
  if (who instanceof Response) return who;
  const u = new URL(req.url);
  const n = (k: string) => (u.searchParams.get(k) ? Number(u.searchParams.get(k)) : undefined);
  const r = searchQsos(db(), {
    stationId: requestScope(req, who).stationId,
    q: u.searchParams.get("q") ?? undefined,
    band: u.searchParams.get("band") ?? undefined,
    mode: u.searchParams.get("mode") ?? undefined,
    from: n("from"),
    to: n("to"),
    page: n("page"),
    pageSize: n("pageSize"),
    confirmed: (u.searchParams.get("confirmed") as "any" | "lotw" | "none" | null) ?? undefined,
  });
  return json(r);
}

export async function POST(req: Request) {
  const who = authorize(req, "OPERATOR");
  if (who instanceof Response) return who;
  const parsed = QsoBody.safeParse(await readJson(req));
  if (!parsed.success) return problem(400, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  // Into the signed-in user's own logbook, with their own upload services.
  const scope = ownScope(who);
  const no = cannotLog(scope);
  if (no) return problem(409, no);
  const operatorId = who.kind === "user" ? operatorForUser(db(), scope.stationId, who.id, scope.callsign!) : null;
  const { qso, created } = createQso(db(), { ...parsed.data, stationId: scope.stationId, operatorId }, { uploadServices: enabledUploadServices(settingsStore().snapshot(scope.userId)) });
  if (created) engineQsoLogged(qso.id);
  return json({ qso, created }, created ? 201 : 200);
}
