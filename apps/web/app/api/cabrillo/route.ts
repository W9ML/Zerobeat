/**
 * Cabrillo export for a contest the station worked: GET ?contest=ARRL-FD&from=&to=&power=&location=.
 * Contacts belong to a contest by the CONTEST_ID the station wrote when it logged them.
 */
import { and, asc, eq, gte, like, lte } from "drizzle-orm";

import { CABRILLO_CONTESTS, cabrilloLog, type CabrilloContest } from "@zerobeat/core/contest/cabrillo";
import { qsos, stations } from "@zerobeat/core/db/schema";
import { operatorCalls } from "@zerobeat/core/log/operators";

import { authorize, problem } from "@/lib/server/auth";
import { db, VERSION } from "@/lib/server/ctx";
import { requestScope } from "@/lib/server/scope";

export async function GET(req: Request) {
  const who = authorize(req, "VIEWER", { apiKey: true });
  if (who instanceof Response) return who;
  const u = new URL(req.url);
  const contest = u.searchParams.get("contest") as CabrilloContest | null;
  if (!contest || !(CABRILLO_CONTESTS as readonly string[]).includes(contest)) return problem(400, `contest must be one of ${CABRILLO_CONTESTS.join(", ")}`);
  const scope = requestScope(req, who);
  const st = scope.stationId ? db().select().from(stations).where(eq(stations.id, scope.stationId)).get() : undefined;
  if (!st) return problem(409, "this account has no callsign yet");
  const from = u.searchParams.get("from") ? Date.parse(`${u.searchParams.get("from")}T00:00:00Z`) : null;
  const to = u.searchParams.get("to") ? Date.parse(`${u.searchParams.get("to")}T23:59:59Z`) : null;
  const rows = db()
    .select()
    .from(qsos)
    .where(and(eq(qsos.stationId, st.id), like(qsos.extras, `%"CONTEST_ID":"${contest}"%`), from ? gte(qsos.startTime, from) : undefined, to ? lte(qsos.startTime, to) : undefined))
    .orderBy(asc(qsos.startTime))
    .all();
  const power = (u.searchParams.get("power") ?? "LOW").toUpperCase();
  // OPERATORS: everyone who made a contact in it, as the contest's rules ask for a
  // multi-operator entry; the station call alone when nobody is recorded.
  const ops = operatorCalls(db());
  const opCalls = [...new Set(rows.map((q) => (q.operatorId ? ops.get(q.operatorId) : undefined)).filter((c): c is string => !!c))];
  const text = cabrilloLog(rows, contest, {
    callsign: st.callsign,
    grid: st.grid,
    location: u.searchParams.get("location") ?? undefined,
    power: power === "HIGH" || power === "QRP" ? power : "LOW",
    operators: opCalls.length ? opCalls.join(" ") : undefined,
  }, `Zerobeat ${VERSION}`);
  const name = `${st.callsign.replace(/\//g, "-")}-${contest}-${new Date().toISOString().slice(0, 10)}.log`;
  return new Response(text, { headers: { "content-type": "text/plain; charset=utf-8", "content-disposition": `attachment; filename="${name}"`, "cache-control": "no-store" } });
}
