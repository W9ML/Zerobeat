/** GET ?since=ms: what happened at the station since then (the "while you were away" strip). */
import { awaySummary } from "@zerobeat/core/log/away";

import { authorize, json, problem } from "@/lib/server/auth";
import { requestScope } from "@/lib/server/scope";
import { db } from "@/lib/server/ctx";

export async function GET(req: Request) {
  const who = authorize(req, "VIEWER");
  if (who instanceof Response) return who;
  const since = Number(new URL(req.url).searchParams.get("since"));
  if (!Number.isFinite(since) || since <= 0) return problem(400, "give ?since= as a time in ms");
  // At most a week back: older than that is the logbook's job.
  return json(awaySummary(db(), requestScope(req, who).stationId, Math.max(since, Date.now() - 7 * 86_400_000)));
}
