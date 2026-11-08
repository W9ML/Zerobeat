import { and, eq } from "drizzle-orm";

import { incompleteExchanges, stations } from "@zerobeat/core/db/schema";
import { operatorForUser } from "@zerobeat/core/log/operators";
import { createQso, enabledUploadServices } from "@zerobeat/core/log/qsos";

import { authorize, json, problem, readJson } from "@/lib/server/auth";
import { db, settingsStore } from "@/lib/server/ctx";
import { engineQsoLogged } from "@/lib/server/engine";
import { ownScope } from "@/lib/server/scope";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const who = authorize(req, "OPERATOR");
  if (who instanceof Response) return who;
  const id = (await ctx.params).id;
  const body = await readJson<{ action?: string }>(req);
  // Only your own station's unfinished exchanges.
  const x = db().select().from(incompleteExchanges).where(and(eq(incompleteExchanges.id, id), eq(incompleteExchanges.stationId, ownScope(who).stationId))).get();
  if (!x) return problem(404, "no such exchange");
  if (x.resolvedAt) return problem(409, "already resolved");
  if (body?.action === "dismiss") {
    db().update(incompleteExchanges).set({ resolvedAt: Date.now() }).where(eq(incompleteExchanges.id, id)).run();
    return json({ ok: true });
  }
  if (body?.action === "promote") {
    const { qso } = createQso(
      db(),
      {
        stationId: x.stationId,
        operatorId: who.kind === "user" ? operatorForUser(db(), x.stationId, who.id, db().select({ c: stations.callsign }).from(stations).where(eq(stations.id, x.stationId)).get()?.c ?? "") : null,
        callsign: x.callsign,
        band: x.band,
        freqHz: x.freqHz,
        mode: x.mode,
        startTime: x.startTime,
        rstSent: x.rstSent,
        rstRcvd: x.rstRcvd,
        grid: x.grid,
        transcript: x.transcript,
        notes: `Logged from an incomplete exchange (${x.reason})`,
      },
      { uploadServices: enabledUploadServices(settingsStore().snapshot(ownScope(who).userId)) },
    );
    db().update(incompleteExchanges).set({ resolvedAt: Date.now(), promotedQsoId: qso.id }).where(eq(incompleteExchanges.id, id)).run();
    engineQsoLogged(qso.id);
    return json({ ok: true, qsoId: qso.id });
  }
  return problem(400, "action must be promote or dismiss");
}
