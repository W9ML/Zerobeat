/**
 * ADIF export (GET, streamed) and import (POST multipart). Import treats the file as
 * history unless the operator ticks services to queue it for.
 */
import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";

import { adifHeader, qsoToAdif } from "@zerobeat/core/adif/adif";
import { qsoSigRefs, qsos, stations, UPLOAD_SERVICES, type UploadService } from "@zerobeat/core/db/schema";
import { importAdif } from "@zerobeat/core/log/import";
import { operatorCalls } from "@zerobeat/core/log/operators";

import { authorize, json, problem } from "@/lib/server/auth";
import { cannotLog, ownScope, requestScope } from "@/lib/server/scope";
import { db, VERSION } from "@/lib/server/ctx";

export async function GET(req: Request) {
  const who = authorize(req, "VIEWER", { apiKey: true });
  if (who instanceof Response) return who;
  const u = new URL(req.url);
  const from = u.searchParams.get("from") ? Date.parse(`${u.searchParams.get("from")}T00:00:00Z`) : null;
  const to = u.searchParams.get("to") ? Date.parse(`${u.searchParams.get("to")}T23:59:59Z`) : null;
  // The viewer's logbook (an admin viewing someone exports theirs).
  const where = and(eq(qsos.stationId, requestScope(req, who).stationId), from ? gte(qsos.startTime, from) : undefined, to ? lte(qsos.startTime, to) : undefined);
  const st = new Map(db().select().from(stations).all().map((s) => [s.id, s]));
  const ops = operatorCalls(db());
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    start(ctrl) {
      ctrl.enqueue(enc.encode(adifHeader(VERSION)));
      const PAGE = 1000;
      for (let off = 0; ; off += PAGE) {
        const rows = db().select().from(qsos).where(where).orderBy(asc(qsos.startTime)).limit(PAGE).offset(off).all();
        if (!rows.length) break;
        const refs = db().select().from(qsoSigRefs).where(inArray(qsoSigRefs.qsoId, rows.map((r) => r.id))).all();
        const byQso = new Map<string, { sig: string; ref: string }[]>();
        for (const r of refs) byQso.set(r.qsoId, [...(byQso.get(r.qsoId) ?? []), { sig: r.sig, ref: r.ref }]);
        for (const q of rows) ctrl.enqueue(enc.encode(qsoToAdif(q, st.get(q.stationId) ?? { callsign: "", grid: "" }, byQso.get(q.id) ?? [], { full: true, operator: q.operatorId ? ops.get(q.operatorId) : null })));
      }
      ctrl.close();
    },
  });
  const name = `zerobeat-${new Date().toISOString().slice(0, 10)}.adi`;
  return new Response(stream, { headers: { "content-type": "text/plain; charset=utf-8", "content-disposition": `attachment; filename="${name}"`, "cache-control": "no-store" } });
}

export async function POST(req: Request) {
  const who = authorize(req, "OPERATOR", { apiKey: true });
  if (who instanceof Response) return who;
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return problem(400, "choose an ADIF file");
  if (file.size > 64 * 1024 * 1024) return problem(413, "the file is over 64 MB");
  const services = (form!.getAll("upload").map(String) as UploadService[]).filter((s) => (UPLOAD_SERVICES as readonly string[]).includes(s));
  const scope = ownScope(who);
  const no = cannotLog(scope);
  if (no) return problem(409, no);
  const station = scope.stationId;
  const report = importAdif(db(), Buffer.from(await file.arrayBuffer()), {
    stationId: station,
    skipDuplicates: form!.get("dupes") !== "keep",
    uploadServices: services,
    dryRun: form!.get("dryRun") === "1",
  });
  return json(report);
}
