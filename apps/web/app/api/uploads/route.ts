/** Queue maintenance: retry failed, queue history, mark history as already sent. */
import { z } from "zod";

import { UPLOAD_SERVICES } from "@zerobeat/core/db/schema";
import { markUploadsSent, queueUploads } from "@zerobeat/core/log/qsos";

import { authorize, json, problem, readJson } from "@/lib/server/auth";
import { db } from "@/lib/server/ctx";
import { getSqlite } from "@zerobeat/core/db/client";
import { ownScope } from "@/lib/server/scope";

const Body = z.object({
  service: z.enum(UPLOAD_SERVICES),
  action: z.enum(["retry-failed", "queue-since", "skip-before"]),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export async function POST(req: Request) {
  // Each user maintains their own queue.
  const who = authorize(req, "OPERATOR");
  if (who instanceof Response) return who;
  const p = Body.safeParse(await readJson(req));
  if (!p.success) return problem(400, p.error.issues[0]?.message ?? "bad request");
  const { service, action, date } = p.data;
  const at = date ? Date.parse(`${date}T00:00:00Z`) : 0;
  const stationId = ownScope(who).stationId;
  if (action === "retry-failed") {
    const n = getSqlite()
      .prepare(`UPDATE upload_state SET status='pending', attempts=0, next_attempt_at=NULL, last_error=NULL, updated_at=? WHERE service=? AND status='failed' AND qso_id IN (SELECT id FROM qsos WHERE station_id = ?)`)
      .run(Date.now(), service, stationId).changes;
    return json({ ok: true, changed: n });
  }
  if (action === "queue-since") {
    if (!date) return problem(400, "pick a date");
    return json({ ok: true, changed: queueUploads(db(), service, { stationId, since: at }) });
  }
  if (!date) return problem(400, "pick a date");
  return json({ ok: true, changed: markUploadsSent(db(), service, { stationId, before: at }) });
}
