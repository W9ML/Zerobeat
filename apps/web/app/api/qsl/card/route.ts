/** QSL card artwork: upload (validated and normalised by sharp) and preview. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { desc, eq } from "drizzle-orm";

import { qsos, stations, type Qso } from "@zerobeat/core/db/schema";
import { renderCard } from "@zerobeat/core/qsl/card";

import { authorize, json, problem } from "@/lib/server/auth";
import { db, settingsStore } from "@/lib/server/ctx";
import { cardPath, cardUploadPath } from "@/lib/server/paths";
import { ownScope, requestScope } from "@/lib/server/scope";
import { defaultStation } from "@zerobeat/core/log/qsos";


export async function GET(req: Request) {
  const who = authorize(req, "VIEWER");
  if (who instanceof Response) return who;
  // A preview of the viewer's own card, on their newest contact.
  const scope = requestScope(req, who);
  const q =
    db().select().from(qsos).where(eq(qsos.stationId, scope.stationId)).orderBy(desc(qsos.startTime)).limit(1).get() ??
    ({ callsign: "K1ABC", startTime: Date.now(), band: "20M", freqHz: 14_074_000, mode: "FT8", submode: null, rstSent: "-10" } as unknown as Qso);
  const st = (scope.stationId ? db().select().from(stations).where(eq(stations.id, scope.stationId)).get() : undefined) ?? { callsign: scope.callsign ?? "N0CALL" };
  const jpg = await renderCard(q, st, { imagePath: cardPath(scope.userId, defaultStation(db())?.userId), settings: settingsStore().snapshot(scope.userId) });
  return new Response(new Uint8Array(jpg), { headers: { "content-type": "image/jpeg", "cache-control": "no-store" } });
}

export async function POST(req: Request) {
  // Each user's own card picture.
  const who = authorize(req, "OPERATOR");
  if (who instanceof Response) return who;
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return problem(400, "choose an image file");
  if (file.size > 20 * 1024 * 1024) return problem(413, "the image is over 20 MB");
  try {
    const png = await sharp(Buffer.from(await file.arrayBuffer()))
      .rotate()
      .resize({ width: 2400, withoutEnlargement: true })
      .png()
      .toBuffer();
    const dest = cardUploadPath(ownScope(who).userId);
    mkdirSync(join(dest, ".."), { recursive: true });
    writeFileSync(dest, png);
    const meta = await sharp(png).metadata();
    return json({ ok: true, width: meta.width, height: meta.height });
  } catch {
    return problem(400, "that file is not an image sharp can read (use PNG or JPEG)");
  }
}
